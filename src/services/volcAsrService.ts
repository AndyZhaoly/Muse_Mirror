import { randomUUID } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import type { VoiceConfig } from '../config.js';
import {
  encodeAsrAudioRequest,
  encodeAsrFullRequest,
  parseJsonPayload,
  parseProviderError,
  parseVolcFrame,
  VolcMessageType,
} from './volcSpeechProtocol.js';

export interface AsrSessionHandlers {
  onReady(): void;
  onPartial(text: string): void;
  onFinal(text: string): void;
  onUtteranceEnd(): void;
  onError(error: Error): void;
}

export interface AsrSession {
  start(): Promise<void>;
  sendAudio(pcm: Buffer): void;
  stop(): void;
  close(): void;
}

interface AsrPayload {
  result?: {
    text?: string;
    utterances?: Array<{
      definite?: boolean;
      end_time?: number;
    }>;
  };
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function authHeaders(config: VoiceConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Api-Resource-Id': config.volcAsrResourceId,
    'X-Api-Request-Id': randomUUID(),
  };
  if (config.volcSpeechAppKey) {
    headers['X-Api-Key'] = config.volcSpeechAppKey;
  } else {
    headers['X-Api-App-Key'] = config.volcSpeechAppId;
    headers['X-Api-Access-Key'] = config.volcSpeechAccessKey;
  }
  return headers;
}

export function buildVolcAsrRequest(sampleRate: number) {
  return {
    user: { uid: randomUUID() },
    audio: {
      format: 'pcm',
      codec: 'raw',
      rate: sampleRate,
      bits: 16,
      channel: 1,
    },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      enable_ddc: true,
      show_utterances: true,
      enable_nonstream: false,
    },
  };
}

export class VolcAsrSession implements AsrSession {
  private socket?: WebSocket;
  private sequence = 1;
  private stopped = false;
  private latestText = '';
  private lastUtteranceEnd = -1;
  private stopTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: VoiceConfig,
    private readonly handlers: AsrSessionHandlers,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.config.volcAsrEndpoint, {
        headers: authHeaders(this.config),
      });
      this.socket = socket;
      let settled = false;

      socket.once('open', () => {
        const request = buildVolcAsrRequest(this.config.volcAsrSampleRate);
        socket.send(encodeAsrFullRequest(request, this.sequence));
        settled = true;
        this.handlers.onReady();
        resolve();
      });
      socket.on('message', (data) => this.handleMessage(toBuffer(data)));
      socket.once('error', (error) => {
        if (!settled) reject(error);
        else this.handlers.onError(error);
      });
      socket.once('close', () => {
        if (this.stopTimer) clearTimeout(this.stopTimer);
      });
    });
  }

  sendAudio(pcm: Buffer): void {
    if (this.stopped || !pcm.length || this.socket?.readyState !== WebSocket.OPEN) return;
    this.sequence += 1;
    this.socket.send(encodeAsrAudioRequest(pcm, this.sequence));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sequence += 1;
      this.socket.send(encodeAsrAudioRequest(Buffer.alloc(0), this.sequence, true));
      this.stopTimer = setTimeout(() => {
        this.handlers.onError(new Error('ASR final response timed out.'));
        this.close();
      }, 10_000);
      this.stopTimer.unref();
    }
  }

  close(): void {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
    this.socket = undefined;
  }

  private handleMessage(data: Buffer): void {
    try {
      const frame = parseVolcFrame(data);
      if (frame.messageType === VolcMessageType.Error) {
        const providerError = parseProviderError(frame);
        this.handlers.onError(new Error(`ASR provider error ${providerError.code}: ${providerError.message}`));
        this.close();
        return;
      }
      const payload = parseJsonPayload<AsrPayload>(frame);
      const text = payload?.result?.text?.trim() ?? '';
      if (text) {
        this.latestText = text;
        if (!frame.isLast) this.handlers.onPartial(text);
      }
      const utteranceEnd = Math.max(
        -1,
        ...(payload?.result?.utterances ?? [])
          .filter((utterance) => utterance.definite)
          .map((utterance) => utterance.end_time ?? -1),
      );
      if (utteranceEnd > this.lastUtteranceEnd) {
        this.lastUtteranceEnd = utteranceEnd;
        this.handlers.onUtteranceEnd();
      }
      if (frame.isLast) {
        if (this.stopTimer) clearTimeout(this.stopTimer);
        this.handlers.onFinal(this.latestText);
        this.close();
      }
    } catch (error) {
      this.handlers.onError(error instanceof Error ? error : new Error(String(error)));
      this.close();
    }
  }
}

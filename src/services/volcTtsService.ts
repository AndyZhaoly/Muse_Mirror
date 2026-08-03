import { randomUUID } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import type { VoiceConfig } from '../config.js';
import {
  encodeTtsRequest,
  parseProviderError,
  parseVolcFrame,
  VolcMessageType,
} from './volcSpeechProtocol.js';

const TTS_RESPONSE_EVENT = 352;
const TTS_SESSION_FINISHED_EVENT = 152;

export interface TtsSessionHandlers {
  onReady(sampleRate: number): void;
  onAudio(audio: Buffer): void;
  onDone(): void;
  onError(error: Error): void;
}

export interface TtsSession {
  start(text: string): Promise<void>;
  close(): void;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function authHeaders(config: VoiceConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Api-Resource-Id': config.volcTtsResourceId,
    'X-Api-Request-Id': randomUUID(),
  };
  if (config.volcSpeechAppKey) {
    headers['X-Api-Key'] = config.volcSpeechAppKey;
  } else {
    headers['X-Api-App-Id'] = config.volcSpeechAppId;
    headers['X-Api-Access-Key'] = config.volcSpeechAccessKey;
  }
  return headers;
}

export class VolcTtsSession implements TtsSession {
  private socket?: WebSocket;

  constructor(
    private readonly config: VoiceConfig,
    private readonly handlers: TtsSessionHandlers,
  ) {}

  start(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.config.volcTtsEndpoint, {
        headers: authHeaders(this.config),
      });
      this.socket = socket;
      let settled = false;

      socket.once('open', () => {
        const request = {
          user: { uid: randomUUID() },
          req_params: {
            speaker: this.config.volcTtsSpeakerId,
            text,
            model: this.config.volcTtsModel,
            audio_params: {
              format: 'pcm',
              sample_rate: this.config.volcTtsSampleRate,
            },
            additions: JSON.stringify({ disable_markdown_filter: false }),
          },
        };
        socket.send(encodeTtsRequest(request));
        settled = true;
        this.handlers.onReady(this.config.volcTtsSampleRate);
        resolve();
      });
      socket.on('message', (data) => this.handleMessage(toBuffer(data)));
      socket.once('error', (error) => {
        if (!settled) reject(error);
        else this.handlers.onError(error);
      });
    });
  }

  close(): void {
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
        this.handlers.onError(new Error(`TTS provider error ${providerError.code}: ${providerError.message}`));
        this.close();
        return;
      }
      if (frame.messageType === VolcMessageType.AudioOnlyServerResponse && frame.event === TTS_RESPONSE_EVENT) {
        if (frame.payload.length) this.handlers.onAudio(frame.payload);
        return;
      }
      if (frame.event === TTS_SESSION_FINISHED_EVENT || frame.isLast) {
        this.handlers.onDone();
        this.close();
      }
    } catch (error) {
      this.handlers.onError(error instanceof Error ? error : new Error(String(error)));
      this.close();
    }
  }
}

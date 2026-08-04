import type http from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { VoiceConfig } from '../config.js';
import {
  VolcAsrSession,
  type AsrSession,
  type AsrSessionHandlers,
} from '../services/volcAsrService.js';
import {
  VolcTtsSession,
  type TtsSession,
  type TtsSessionHandlers,
} from '../services/volcTtsService.js';

export interface VoiceCapabilityStatus {
  mode: 'semi_duplex';
  asr: {
    provider: VoiceConfig['asrProvider'];
    configured: boolean;
    ready: boolean;
    sampleRate: number;
    resourceId: string;
  };
  tts: {
    provider: VoiceConfig['ttsProvider'];
    configured: boolean;
    ready: boolean;
    sampleRate: number;
    model: string;
    resourceId: string;
    speakerConfigured: boolean;
  };
}

export interface VoiceSessionFactory {
  createAsr(handlers: AsrSessionHandlers): AsrSession;
  createTts(handlers: TtsSessionHandlers): TtsSession;
}

export interface VoiceGateway {
  getStatus(): VoiceCapabilityStatus;
  close(): void;
}

function hasCompleteCredential(config: VoiceConfig): boolean {
  return Boolean(
    config.volcSpeechAppKey ||
      (config.volcSpeechAppId && config.volcSpeechAccessKey),
  );
}

export function buildVoiceStatus(config: VoiceConfig): VoiceCapabilityStatus {
  const asrConfigured = Boolean(
    config.asrProvider === 'volcengine' &&
      hasCompleteCredential(config) &&
      config.volcAsrEndpoint &&
      config.volcAsrResourceId,
  );
  const ttsConfigured = Boolean(
    config.ttsProvider === 'volcengine' &&
      hasCompleteCredential(config) &&
      config.volcTtsEndpoint &&
      config.volcTtsResourceId &&
      config.volcTtsModel &&
      config.volcTtsSpeakerId,
  );
  return {
    mode: 'semi_duplex',
    asr: {
      provider: config.asrProvider,
      configured: asrConfigured,
      ready: asrConfigured,
      sampleRate: config.volcAsrSampleRate,
      resourceId: config.volcAsrResourceId,
    },
    tts: {
      provider: config.ttsProvider,
      configured: ttsConfigured,
      ready: ttsConfigured,
      sampleRate: config.volcTtsSampleRate,
      model: config.volcTtsModel,
      resourceId: config.volcTtsResourceId,
      speakerConfigured: Boolean(config.volcTtsSpeakerId),
    },
  };
}

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function parseJson(data: RawData): Record<string, unknown> | undefined {
  try {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8');
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function productErrorMessage(capability: 'ASR' | 'TTS', error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|403|auth|credential|access/i.test(message)) {
    return `${capability} 服务鉴权失败，请检查语音服务配置。`;
  }
  return `${capability} 服务暂时不可用，请稍后重试。`;
}

export function attachVoiceGateway(
  server: http.Server,
  options: { config: VoiceConfig; factory?: VoiceSessionFactory },
): VoiceGateway {
  const status = buildVoiceStatus(options.config);
  const factory: VoiceSessionFactory = options.factory ?? {
    createAsr: (handlers) => new VolcAsrSession(options.config, handlers),
    createTts: (handlers) => new VolcTtsSession(options.config, handlers),
  };
  const asrServer = new WebSocketServer({ noServer: true });
  const ttsServer = new WebSocketServer({ noServer: true });

  const upgrade = (request: http.IncomingMessage, socket: any, head: Buffer): void => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname === '/api/voice/asr') {
      asrServer.handleUpgrade(request, socket, head, (ws) => asrServer.emit('connection', ws, request));
      return;
    }
    if (url.pathname === '/api/voice/tts') {
      ttsServer.handleUpgrade(request, socket, head, (ws) => ttsServer.emit('connection', ws, request));
    }
  };
  server.on('upgrade', upgrade);

  asrServer.on('connection', (browser) => {
    let session: AsrSession | undefined;
    let stopped = false;
    browser.on('message', (data, isBinary) => {
      if (isBinary) {
        session?.sendAudio(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        return;
      }
      const message = parseJson(data);
      if (message?.type === 'start') {
        if (!status.asr.ready) {
          sendJson(browser, { type: 'error', code: 'not_configured', message: '语音识别尚未配置。' });
          return;
        }
        if (session) return;
        session = factory.createAsr({
          onReady: () => sendJson(browser, { type: 'ready' }),
          onPartial: (text) => sendJson(browser, { type: 'partial', text }),
          onFinal: (text) => sendJson(browser, { type: 'final', text }),
          onUtteranceEnd: () => sendJson(browser, { type: 'utterance_end' }),
          onError: (error) => sendJson(browser, { type: 'error', code: 'provider_error', message: productErrorMessage('ASR', error) }),
        });
        void session.start().catch((error) => {
          sendJson(browser, { type: 'error', code: 'connection_failed', message: productErrorMessage('ASR', error) });
          session?.close();
          session = undefined;
        });
        return;
      }
      if (message?.type === 'stop' && !stopped) {
        stopped = true;
        session?.stop();
      }
    });
    browser.once('close', () => session?.close());
    browser.once('error', () => session?.close());
  });

  ttsServer.on('connection', (browser) => {
    let session: TtsSession | undefined;
    browser.on('message', (data, isBinary) => {
      if (isBinary) return;
      const message = parseJson(data);
      if (message?.type !== 'start' || typeof message.text !== 'string') return;
      if (!status.tts.ready) {
        sendJson(browser, { type: 'error', code: 'not_configured', message: '语音合成尚未配置。' });
        return;
      }
      if (session) return;
      session = factory.createTts({
        onReady: (sampleRate) => sendJson(browser, { type: 'ready', sampleRate, format: 'pcm_s16le', channels: 1 }),
        onAudio: (audio) => {
          if (browser.readyState === WebSocket.OPEN) browser.send(audio, { binary: true });
        },
        onDone: () => sendJson(browser, { type: 'done' }),
        onError: (error) => sendJson(browser, { type: 'error', code: 'provider_error', message: productErrorMessage('TTS', error) }),
      });
      void session.start(message.text.trim()).catch((error) => {
        sendJson(browser, { type: 'error', code: 'connection_failed', message: productErrorMessage('TTS', error) });
        session?.close();
        session = undefined;
      });
    });
    browser.once('close', () => session?.close());
    browser.once('error', () => session?.close());
  });

  return {
    getStatus: () => status,
    close: () => {
      server.off('upgrade', upgrade);
      for (const client of asrServer.clients) client.close();
      for (const client of ttsServer.clients) client.close();
      asrServer.close();
      ttsServer.close();
    },
  };
}

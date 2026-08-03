import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import WebSocket from 'ws';
import { loadVoiceConfig } from '../src/config.js';
import type { AsrSession, AsrSessionHandlers } from '../src/services/volcAsrService.js';
import type { TtsSession, TtsSessionHandlers } from '../src/services/volcTtsService.js';
import {
  attachVoiceGateway,
  buildVoiceStatus,
  type VoiceSessionFactory,
} from '../src/server/voiceGateway.js';

function configuredVoice() {
  return loadVoiceConfig({
    FASHION_AGENT_ASR_PROVIDER: 'volcengine',
    FASHION_AGENT_TTS_PROVIDER: 'volcengine',
    VOLC_SPEECH_APP_ID: 'app-id-secret',
    VOLC_SPEECH_APP_KEY: 'app-key-secret',
    VOLC_TTS_SPEAKER_ID: 'speaker-demo',
  });
}

test('voice config is disabled without provider settings and does not block startup', () => {
  const status = buildVoiceStatus(loadVoiceConfig({}));
  assert.equal(status.asr.provider, 'disabled');
  assert.equal(status.asr.ready, false);
  assert.equal(status.tts.ready, false);
});

test('voice status reports capabilities without exposing credentials', () => {
  const status = buildVoiceStatus(configuredVoice());
  assert.equal(status.asr.ready, true);
  assert.equal(status.tts.ready, true);
  const serialized = JSON.stringify(status);
  assert.doesNotMatch(serialized, /app-id-secret|app-key-secret/);
});

test('new Volcengine API key auth does not require legacy app id', () => {
  const config = loadVoiceConfig({
    FASHION_AGENT_ASR_PROVIDER: 'volcengine',
    FASHION_AGENT_TTS_PROVIDER: 'volcengine',
    VOLC_SPEECH_APP_KEY: 'modern-api-key',
    VOLC_TTS_SPEAKER_ID: 'speaker-demo',
  });
  const status = buildVoiceStatus(config);
  assert.equal(status.asr.ready, true);
  assert.equal(status.tts.ready, true);
});

test('ASR gateway closes its provider session when the browser disconnects', async () => {
  let closed = false;
  class FakeAsr implements AsrSession {
    constructor(private readonly handlers: AsrSessionHandlers) {}
    async start() { this.handlers.onReady(); }
    sendAudio() {}
    stop() { this.handlers.onFinal('测试完成'); }
    close() { closed = true; }
  }
  class FakeTts implements TtsSession {
    constructor(private readonly handlers: TtsSessionHandlers) {}
    async start() { this.handlers.onReady(24000); this.handlers.onDone(); }
    close() {}
  }
  const factory: VoiceSessionFactory = {
    createAsr: (handlers) => new FakeAsr(handlers),
    createTts: (handlers) => new FakeTts(handlers),
  };
  const server = http.createServer((_req, res) => res.end('ok'));
  const gateway = attachVoiceGateway(server, { config: configuredVoice(), factory });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const browser = new WebSocket(`ws://127.0.0.1:${address.port}/api/voice/asr`);
  await new Promise<void>((resolve, reject) => {
    browser.once('open', resolve);
    browser.once('error', reject);
  });
  browser.send(JSON.stringify({ type: 'start' }));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ASR ready timed out')), 1000);
    browser.on('message', (data) => {
      const message = JSON.parse(data.toString()) as { type?: string };
      if (message.type === 'ready') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  browser.close();
  await new Promise<void>((resolve) => browser.once('close', resolve));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closed, true);
  gateway.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('voice WebSocket upgrade rejects unauthenticated requests', async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const gateway = attachVoiceGateway(server, {
    config: configuredVoice(),
    authorizeRequest: () => false,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const browser = new WebSocket(`ws://127.0.0.1:${address.port}/api/voice/asr`);
  const statusCode = await new Promise<number>((resolve, reject) => {
    browser.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
    browser.once('open', () => reject(new Error('Unauthorized WebSocket unexpectedly opened.')));
    browser.once('error', () => undefined);
  });
  assert.equal(statusCode, 401);
  browser.terminate();
  gateway.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

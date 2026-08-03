import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getOrCreateBrowserUserId,
  type BrowserStorage,
} from '../web/src/browserIdentity.js';
import { voiceWebSocketUrl } from '../web/src/voice/voiceTypes.js';

class MemoryStorage implements BrowserStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

test('browser identity is created once and survives refreshes', () => {
  const storage = new MemoryStorage();
  let calls = 0;
  const first = getOrCreateBrowserUserId(storage, () => {
    calls += 1;
    return '11111111-1111-4111-8111-111111111111';
  });
  const second = getOrCreateBrowserUserId(storage, () => {
    calls += 1;
    return '22222222-2222-4222-8222-222222222222';
  });
  assert.equal(first, 'team_demo_11111111-1111-4111-8111-111111111111');
  assert.equal(second, first);
  assert.equal(calls, 1);
});

test('different browser storage receives a different identity', () => {
  const first = getOrCreateBrowserUserId(
    new MemoryStorage(),
    () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  const second = getOrCreateBrowserUserId(
    new MemoryStorage(),
    () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  );
  assert.notEqual(first, second);
});

test('browser identity has a safe in-memory fallback when storage is unavailable', () => {
  const brokenStorage: BrowserStorage = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  const value = getOrCreateBrowserUserId(
    brokenStorage,
    () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  );
  assert.equal(value, 'team_demo_cccccccc-cccc-4ccc-8ccc-cccccccccccc');
});

test('voice WebSocket follows the page security protocol', () => {
  assert.equal(
    voiceWebSocketUrl('/api/voice/asr', { protocol: 'https:', host: 'muse.example' }),
    'wss://muse.example/api/voice/asr',
  );
  assert.equal(
    voiceWebSocketUrl('/api/voice/tts', { protocol: 'http:', host: 'localhost:5173' }),
    'ws://localhost:5173/api/voice/tts',
  );
});

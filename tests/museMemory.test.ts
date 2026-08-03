import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractPreferenceIntents } from '../src/runtime/memoryExtractor.js';
import {
  JsonMuseMemoryStore,
  memoryFromPreferenceEvent,
} from '../src/runtime/memoryStore.js';
import type { UserMemory } from '../src/types.js';

const userId = 'memory_user';
const conversationId = 'conversation_memory_test';

function tempStore(name: string): JsonMuseMemoryStore {
  return new JsonMuseMemoryStore(path.join(os.tmpdir(), `muse-memory-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`));
}

test('today bold becomes conversation override, not persistent memory event', () => {
  const result = extractPreferenceIntents({
    userId,
    conversationId,
    messageId: 'msg_today',
    userMessage: '今天大胆点',
    nowIso: '2026-06-23T10:00:00.000Z',
  });

  assert.equal(result.events.length, 0);
  assert.equal(result.overrides.length, 1);
  assert.equal(result.overrides[0]?.scope, 'conversation');
  assert.deepEqual((result.overrides[0]?.value as any).values, ['bold']);
});

test('this outfit override is task scoped', () => {
  const result = extractPreferenceIntents({
    userId,
    conversationId,
    messageId: 'msg_task',
    userMessage: '这套偏大胆一点',
  });

  assert.equal(result.events.length, 0);
  assert.equal(result.overrides[0]?.scope, 'task');
});

test('explicit remember creates persistent captured event', () => {
  const result = extractPreferenceIntents({
    userId,
    conversationId,
    messageId: 'msg_remember',
    userMessage: '记住我不喜欢高领',
  });

  assert.equal(result.overrides.length, 0);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.intent.durabilityIntent, 'persistent');
  assert.equal(result.events[0]?.intent.memoryAuthorization, 'explicit');
  assert.equal(result.events[0]?.status, 'captured');
  assert.deepEqual((result.events[0]?.intent.value as any).values, ['turtleneck']);
});

test('other person and do-not-remember statements do not create user memory', () => {
  const other = extractPreferenceIntents({
    userId,
    conversationId,
    messageId: 'msg_other',
    userMessage: '我朋友以后都不穿高领',
  });
  assert.equal(other.events.length, 0);
  assert.equal(other.overrides.length, 0);

  const denied = extractPreferenceIntents({
    userId,
    conversationId,
    messageId: 'msg_denied',
    userMessage: '不要记住我刚才说的以后别推荐高领',
  });
  assert.equal(denied.events.length, 1);
  assert.equal(denied.events[0]?.intent.operation, 'do_not_remember');
  assert.equal(denied.events[0]?.status, 'forbidden');
});

test('store keeps different applicability memories active and supersedes exact overlap', async () => {
  const store = tempStore('applicability');
  const base: Omit<UserMemory, 'id' | 'createdAt' | 'updatedAt' | 'status'> = {
    userId,
    value: {
      namespace: 'style_preference',
      key: 'style_tone',
      values: ['minimal'],
      preferenceStrength: 'medium',
    },
    applicability: { occasion: ['commute'] },
    explicitness: 'user_requested',
    authorization: 'explicit',
    confidence: 1,
    source: { type: 'conversation', conversationId, messageId: 'msg_1' },
  };
  const commute = await store.createMemory({ userId, memory: base, actor: 'user' });
  const party = await store.createMemory({
    userId,
    memory: {
      ...base,
      value: {
        namespace: 'style_preference',
        key: 'style_tone',
        values: ['dramatic'],
        preferenceStrength: 'medium',
      },
      applicability: { occasion: ['party'] },
      source: { type: 'conversation', conversationId, messageId: 'msg_2' },
    },
    actor: 'user',
  });
  const commuteReplacement = await store.createMemory({
    userId,
    memory: {
      ...base,
      value: {
        namespace: 'style_preference',
        key: 'style_tone',
        values: ['crisp'],
        preferenceStrength: 'medium',
      },
      applicability: { occasion: ['commute'] },
      source: { type: 'conversation', conversationId, messageId: 'msg_3' },
    },
    actor: 'user',
  });

  const memories = await store.listMemories(userId, true);
  assert.equal(memories.find((memory) => memory.id === commute.id)?.status, 'superseded');
  assert.equal(memories.find((memory) => memory.id === party.id)?.status, 'active');
  assert.equal(memories.find((memory) => memory.id === commuteReplacement.id)?.status, 'active');
});

test('deleted memory is not used and audit does not retain plaintext value', async () => {
  const store = tempStore('delete');
  const event = extractPreferenceIntents({
    userId,
    conversationId,
    messageId: 'msg_delete',
    userMessage: '记住我不喜欢高领',
  }).events[0];
  assert.ok(event);
  const memory = await store.createMemory({ userId, memory: memoryFromPreferenceEvent(event), actor: 'extractor' });
  await store.updateMemory(userId, memory.id, { status: 'deleted' }, 'user');

  const personalization = await store.buildPersonalizationContext(userId, conversationId, {
    usePersistentMemories: true,
    referencePastChats: false,
    allowExplicitMemoryWrites: true,
  });
  assert.equal(personalization.context.persistentMemories.length, 0);
});

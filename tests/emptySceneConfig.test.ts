import assert from 'node:assert/strict';
import test from 'node:test';
import { loadEmptySceneConfig } from '../src/config.js';

test('empty-scene guard has safe defaults', () => {
  assert.deepEqual(loadEmptySceneConfig({}), {
    threshold: 0.03,
    confirmations: 2,
    forceProbeMs: 90_000,
  });
});

test('empty-scene threshold, confirmations, and forced probe TTL are configurable and bounded', () => {
  assert.deepEqual(loadEmptySceneConfig({
    FASHION_AGENT_EMPTY_SCENE_THRESHOLD: '0.045',
    FASHION_AGENT_EMPTY_SCENE_CONFIRMATIONS: '3',
    FASHION_AGENT_EMPTY_SCENE_FORCE_PROBE_MS: '120000',
  }), {
    threshold: 0.045,
    confirmations: 3,
    forceProbeMs: 120_000,
  });
  assert.deepEqual(loadEmptySceneConfig({
    FASHION_AGENT_EMPTY_SCENE_THRESHOLD: '0',
    FASHION_AGENT_EMPTY_SCENE_CONFIRMATIONS: '1',
    FASHION_AGENT_EMPTY_SCENE_FORCE_PROBE_MS: '100',
  }), {
    threshold: 0.001,
    confirmations: 2,
    forceProbeMs: 10_000,
  });
});

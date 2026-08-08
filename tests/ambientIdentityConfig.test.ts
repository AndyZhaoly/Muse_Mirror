import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAmbientIdentityConfig } from '../src/config.js';

test('ambient identity includes the base closet by default', () => {
  assert.deepEqual(loadAmbientIdentityConfig({}), { ignoreBaseCloset: false });
});

test('ambient demo base-closet exclusion is explicitly enabled and reversible', () => {
  assert.deepEqual(loadAmbientIdentityConfig({
    FASHION_AGENT_AMBIENT_IGNORE_BASE_CLOSET: 'true',
  }), { ignoreBaseCloset: true });
  assert.deepEqual(loadAmbientIdentityConfig({
    FASHION_AGENT_AMBIENT_IGNORE_BASE_CLOSET: 'false',
  }), { ignoreBaseCloset: false });
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAmbientIdentityConfig } from '../src/config.js';

test('ambient identity includes the base closet by default', () => {
  assert.deepEqual(loadAmbientIdentityConfig({}), {
    ignoreBaseCloset: false,
    resetUserDataOnStart: false,
  });
});

test('ambient demo base-closet exclusion is explicitly enabled and reversible', () => {
  assert.deepEqual(loadAmbientIdentityConfig({
    FASHION_AGENT_AMBIENT_IGNORE_BASE_CLOSET: 'true',
    FASHION_AGENT_AMBIENT_RESET_USER_DATA_ON_START: 'true',
  }), {
    ignoreBaseCloset: true,
    resetUserDataOnStart: true,
  });
  assert.deepEqual(loadAmbientIdentityConfig({
    FASHION_AGENT_AMBIENT_IGNORE_BASE_CLOSET: 'false',
    FASHION_AGENT_AMBIENT_RESET_USER_DATA_ON_START: 'false',
  }), {
    ignoreBaseCloset: false,
    resetUserDataOnStart: false,
  });
});

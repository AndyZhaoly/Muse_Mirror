import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { resolveWithin } from '../src/utils/pathSafety.js';

test('resolveWithin accepts a path inside the base directory', () => {
  const base = path.resolve('./examples');
  const resolved = resolveWithin(base, path.resolve('./examples/mock_user_photo.jpg'));
  assert.equal(resolved, path.resolve('./examples/mock_user_photo.jpg'));
});

test('resolveWithin rejects traversal outside the base directory', () => {
  const base = path.resolve('./examples');
  assert.throws(() => resolveWithin(base, path.resolve('./package.json')));
});

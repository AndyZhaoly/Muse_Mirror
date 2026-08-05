import assert from 'node:assert/strict';
import test from 'node:test';
import { frameStabilityScore, nextStableSampleCount } from '../web/src/ambientCapture.js';

test('local frame stability is derived from real pixel differences', () => {
  const stable = { pixels: new Uint8ClampedArray([20, 40, 60, 80]), sourceWidth: 1280, sourceHeight: 720 };
  const nearlyStable = { pixels: new Uint8ClampedArray([20, 41, 60, 80]), sourceWidth: 1280, sourceHeight: 720 };
  const changed = { pixels: new Uint8ClampedArray([220, 240, 10, 180]), sourceWidth: 1280, sourceHeight: 720 };

  assert.equal(frameStabilityScore(undefined, stable), 0);
  assert.ok(frameStabilityScore(stable, nearlyStable) > 0.99);
  assert.ok(frameStabilityScore(stable, changed) < 0.5);
});

test('stable sample count resets as soon as motion crosses the threshold', () => {
  assert.equal(nextStableSampleCount(0, 0.95), 1);
  assert.equal(nextStableSampleCount(2, 0.92), 3);
  assert.equal(nextStableSampleCount(3, 0.89), 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  confirmEmptyScene,
  evaluateEmptySceneGuard,
  frameStabilityScore,
  matchesEmptyScene,
  nextStableSampleCount,
  resolveEmptySceneObservation,
  sceneDifference,
  type EmptySceneGuardConfig,
  type EmptySceneGuardState,
} from '../web/src/ambientCapture.js';

const emptyConfig: EmptySceneGuardConfig = {
  threshold: 0.03,
  confirmations: 2,
  forceProbeMs: 90_000,
};

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

test('scene difference tolerates light flicker but notices a changed scene', () => {
  const empty = sample([40, 42, 44, 46]);
  const flicker = sample([44, 46, 48, 50]);
  const changed = sample([160, 170, 180, 190]);
  assert.ok(sceneDifference(empty, flicker) < emptyConfig.threshold);
  assert.ok(sceneDifference(empty, changed) >= emptyConfig.threshold);
  assert.equal(matchesEmptyScene(empty, flicker, emptyConfig.threshold), true);
  assert.equal(matchesEmptyScene(empty, changed, emptyConfig.threshold), false);
});

test('one false no-person result creates only a candidate and never suppresses uploads', () => {
  const empty = sample([40, 42, 44, 46]);
  const candidate = confirmEmptyScene({ status: 'inactive' }, empty, 1_000, emptyConfig);
  assert.equal(candidate.status, 'candidate');
  const evaluation = evaluateEmptySceneGuard(candidate, empty, 2_000, emptyConfig);
  assert.equal(evaluation.shouldUpload, true);
  assert.equal(evaluation.skippedUpload, false);
});

test('two matching server confirmations suppress ordinary empty-scene uploads', () => {
  const empty = sample([40, 42, 44, 46]);
  const candidate = confirmEmptyScene({ status: 'inactive' }, empty, 1_000, emptyConfig);
  const confirmed = confirmEmptyScene(candidate, sample([41, 43, 45, 47]), 11_000, emptyConfig);
  assert.equal(confirmed.status, 'confirmed');
  const evaluation = evaluateEmptySceneGuard(confirmed, empty, 12_000, emptyConfig);
  assert.equal(evaluation.shouldUpload, false);
  assert.equal(evaluation.skippedUpload, true);
});

test('a different second scene cancels the empty candidate', () => {
  const empty = sample([40, 42, 44, 46]);
  const changed = sample([160, 170, 180, 190]);
  const candidate = confirmEmptyScene({ status: 'inactive' }, empty, 1_000, emptyConfig);
  const evaluation = evaluateEmptySceneGuard(candidate, changed, 2_000, emptyConfig);
  assert.equal(evaluation.state.status, 'inactive');
  assert.equal(evaluation.sceneChanged, true);
  assert.equal(evaluation.shouldUpload, false, 'changed sample starts a fresh stability window');
});

test('confirmed empty scenes force a periodic probe and refresh after another no-person result', () => {
  const empty = sample([40, 42, 44, 46]);
  let state: EmptySceneGuardState = confirmEmptyScene({ status: 'inactive' }, empty, 1_000, emptyConfig);
  state = confirmEmptyScene(state, empty, 11_000, emptyConfig);
  assert.equal(state.status, 'confirmed');
  const beforeTtl = evaluateEmptySceneGuard(state, empty, 100_999, emptyConfig);
  assert.equal(beforeTtl.shouldUpload, false);
  const atTtl = evaluateEmptySceneGuard(state, empty, 101_000, emptyConfig);
  assert.equal(atTtl.shouldUpload, true);
  assert.equal(atTtl.forcedProbe, true);
  const refreshed = confirmEmptyScene(state, empty, 101_500, emptyConfig);
  assert.equal(refreshed.status, 'confirmed');
  if (refreshed.status === 'confirmed') assert.equal(refreshed.nextForcedProbeAt, 191_500);
});

test('a person or changed scene clears confirmed suppression immediately', () => {
  const empty = sample([40, 42, 44, 46]);
  const person = sample([160, 170, 180, 190]);
  let state: EmptySceneGuardState = confirmEmptyScene({ status: 'inactive' }, empty, 1_000, emptyConfig);
  state = confirmEmptyScene(state, empty, 11_000, emptyConfig);
  const reentry = evaluateEmptySceneGuard(state, person, 12_000, emptyConfig);
  assert.equal(reentry.state.status, 'inactive');
  assert.equal(reentry.sceneChanged, true);
  assert.equal(resolveEmptySceneObservation(state, person, 12_500, emptyConfig, false).status, 'inactive');
});

function sample(values: number[]): { pixels: Uint8ClampedArray; sourceWidth: number; sourceHeight: number } {
  return { pixels: new Uint8ClampedArray(values), sourceWidth: 1280, sourceHeight: 720 };
}

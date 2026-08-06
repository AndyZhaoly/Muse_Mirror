import assert from 'node:assert/strict';
import test from 'node:test';
import type { GarmentAppearanceDescriptor } from '../src/domain/ambientCapture.js';
import { trackDescriptorSimilarity, TRACK_CONTINUITY_THRESHOLD } from '../src/runtime/ambientCaptureCoordinator.js';
import {
  canonicalizeColor,
  canonicalizeFit,
  canonicalizeGarmentSlot,
  canonicalizePattern,
  colorSimilarity,
} from '../src/services/garmentVocabulary.js';

test('color vocabulary canonicalizes English, Chinese, and longest complete phrases', () => {
  assert.equal(canonicalizeColor('navy'), 'navy');
  assert.equal(canonicalizeColor('Dark Blue'), 'navy');
  assert.equal(canonicalizeColor('深蓝色'), 'navy');
  assert.equal(canonicalizeColor('warm light khaki jacket'), 'beige');
  assert.equal(canonicalizeColor('off white'), 'off_white');
  assert.equal(canonicalizeColor('tangerine'), 'unknown', 'substring tan must not match tangerine');
  assert.equal(canonicalizeColor('mystery shade'), 'unknown');
});

test('color similarity distinguishes same, neighboring, unknown, and unrelated buckets', () => {
  assert.equal(colorSimilarity('navy', 'deep blue'), 1);
  assert.equal(colorSimilarity('深蓝', 'navy'), 1);
  assert.equal(colorSimilarity('navy', 'blue'), 0.6);
  assert.equal(colorSimilarity('unknown', 'navy'), 0);
  assert.equal(colorSimilarity('navy', 'red'), 0);
});

test('pattern and fit vocabulary preserve uncertainty instead of forcing a guess', () => {
  assert.equal(canonicalizePattern('Striped'), 'stripe');
  assert.equal(canonicalizePattern('条纹'), 'stripe');
  assert.equal(canonicalizePattern('plaid'), 'check');
  assert.equal(canonicalizeFit('loose'), 'relaxed');
  assert.equal(canonicalizeFit('修身'), 'slim');
  assert.equal(canonicalizeFit('not visible'), 'unknown');
});

test('jumpsuit category consistently uses the one-piece dress slot', () => {
  assert.equal(canonicalizeGarmentSlot('jumpsuit', 'jumpsuit'), 'dress');
  assert.equal(canonicalizeGarmentSlot('accessory', 'jumpsuit'), 'dress');
  assert.equal(canonicalizeGarmentSlot('dress', 'jumpsuit'), 'dress');
});

test('same garment wording drift keeps continuity while near color alone cannot', () => {
  const original = descriptor({
    dominantColor: 'navy',
    silhouette: 'straight relaxed tee',
    distinctiveFeatures: ['ribbed collar'],
  });
  const wordingDrift = descriptor({
    dominantColor: 'dark blue',
    silhouette: 'relaxed straight tee',
    distinctiveFeatures: ['ribbed collar'],
  });
  assert.ok(trackDescriptorSimilarity(original, wordingDrift) >= TRACK_CONTINUITY_THRESHOLD);

  const blackGeneric = descriptor({ dominantColor: 'black' });
  const navyGeneric = descriptor({ dominantColor: 'navy' });
  assert.ok(
    trackDescriptorSimilarity(blackGeneric, navyGeneric) < TRACK_CONTINUITY_THRESHOLD,
    'neighboring color plus generic solid/regular metadata must not preserve a track',
  );

  const changed = descriptor({
    dominantColor: 'red', pattern: 'check', fit: 'oversized',
    silhouette: 'cropped boxy jacket', distinctiveFeatures: ['large patch pockets'],
  });
  assert.ok(trackDescriptorSimilarity(original, changed) < TRACK_CONTINUITY_THRESHOLD);
});

function descriptor(overrides: Partial<GarmentAppearanceDescriptor> = {}): GarmentAppearanceDescriptor {
  return {
    slot: 'top', category: 'top', dominantColor: 'black', secondaryColors: [],
    pattern: 'solid', silhouette: 'unknown', fit: 'regular', distinctiveFeatures: [],
    ...overrides,
  };
}

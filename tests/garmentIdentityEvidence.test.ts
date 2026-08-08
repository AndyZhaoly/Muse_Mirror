import assert from 'node:assert/strict';
import test from 'node:test';
import type { GarmentAppearanceDescriptor, PairwiseGarmentVerification } from '../src/domain/ambientCapture.js';
import {
  attributeCompatibility,
  compareCoreIdentityTags,
  hardAttributeExclusion,
  identityEvidenceClass,
  normalizePairwiseVerification,
} from '../src/services/garmentIdentityEvidence.js';

test('core tags directly distinguish an obviously different shirt', () => {
  const comparison = compareCoreIdentityTags(
    descriptor({ dominantColor: 'black', pattern: 'solid', sleeve: 'short', neckline: 'crew' }),
    descriptor({ dominantColor: 'beige', pattern: 'graphic', sleeve: 'short', neckline: 'crew' }),
  );
  assert.deepEqual(comparison.contradictions.sort(), ['dominant_color', 'pattern_family']);
  assert.ok(comparison.agreements.includes('category'));
  assert.ok(comparison.agreements.includes('sleeve_length'));
  assert.ok(comparison.agreements.includes('neckline_family'));
});

test('secondary color overlap prevents lighting drift from splitting the same shorts', () => {
  const comparison = compareCoreIdentityTags(
    descriptor({ slot: 'bottom', category: 'bottom', dominantColor: 'pink', pattern: 'solid', lengthClass: 'short' }),
    descriptor({
      slot: 'bottom', category: 'bottom', dominantColor: 'off_white', secondaryColors: ['pink'],
      pattern: 'solid', lengthClass: 'medium',
    }),
  );
  assert.deepEqual(comparison.contradictions, []);
  assert.ok(comparison.agreements.includes('dominant_color'));
  assert.ok(comparison.agreements.includes('pattern_family'));
});

test('texture wording drift is not treated as an obvious pattern contradiction', () => {
  const comparison = compareCoreIdentityTags(
    descriptor({ pattern: 'solid' }),
    descriptor({ pattern: 'knit_texture' }),
  );
  assert.deepEqual(comparison.contradictions, []);
});

test('color pattern sleeve neckline and length contradictions are soft evidence', () => {
  assert.equal(hardAttributeExclusion(
    descriptor({ dominantColor: 'black', pattern: 'solid' }),
    descriptor({ dominantColor: 'white', pattern: 'solid' }),
  ), undefined);
  const result = attributeCompatibility(
    descriptor({ dominantColor: 'black', pattern: 'stripe' }),
    descriptor({ dominantColor: 'white', pattern: 'check' }),
  );
  assert.ok(result.softContradictions.includes('COLOR_FAMILY_CONTRADICTION'));
  assert.ok(result.softContradictions.includes('PATTERN_FAMILY_CONTRADICTION'));
});

test('only physically incompatible slot or category is hard excluded', () => {
  assert.equal(hardAttributeExclusion(
    descriptor({ slot: 'top', category: 'top' }),
    descriptor({ slot: 'bottom', category: 'bottom' }),
  ), 'PHYSICAL_CATEGORY_OR_SLOT_CONTRADICTION');
});

test('evidence taxonomy is server controlled', () => {
  assert.equal(identityEvidenceClass('color'), 'class_level');
  assert.equal(identityEvidenceClass('pattern_family'), 'class_level');
  assert.equal(identityEvidenceClass('pocket_geometry'), 'instance_specific');
  assert.equal(identityEvidenceClass('stitching_layout'), 'instance_specific');
});

test('verifier current-garment reading cannot contradict the locked observation', () => {
  const raw = verification({ currentColor: 'black', currentSleeve: 'long', currentNeckline: 'turtleneck' });
  const normalized = normalizePairwiseVerification(raw, descriptor({
    dominantColor: 'light_blue', sleeve: 'short', neckline: 'v',
  }));
  assert.equal(normalized.verification.verdict, 'uncertain');
  assert.ok(normalized.downgradeReasons.includes('VERIFIER_INCONSISTENT_CURRENT_READ'));
});

function descriptor(overrides: Partial<GarmentAppearanceDescriptor> = {}): GarmentAppearanceDescriptor {
  return {
    slot: 'top', category: 'top', dominantColor: 'gray', secondaryColors: [], pattern: 'other',
    sleeve: 'unknown', neckline: 'unknown', lengthClass: 'unknown', materialClass: 'unknown',
    silhouette: 'unknown', fit: 'unknown', distinctiveFeatures: [],
    ...overrides,
  };
}

function verification(overrides: Partial<PairwiseGarmentVerification> = {}): PairwiseGarmentVerification {
  return {
    verdict: 'same', confidence: 0.95, currentColor: 'gray', currentSleeve: 'short', currentNeckline: 'crew',
    featureComparisons: [{
      feature: 'pocket_geometry', currentVisibility: 'visible', referenceVisibility: 'visible', relation: 'same',
      discriminativeStrength: 'strong', note: 'fixture',
    }],
    occlusions: [], jointlyVisibleEvidence: ['pocket'], model: 'fixture', ...overrides,
  };
}

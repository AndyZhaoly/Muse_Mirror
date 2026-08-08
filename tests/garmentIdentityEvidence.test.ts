import assert from 'node:assert/strict';
import test from 'node:test';
import type { GarmentAppearanceDescriptor, PairwiseGarmentVerification } from '../src/domain/ambientCapture.js';
import {
  hardAttributeExclusion,
  normalizePairwiseVerification,
} from '../src/services/garmentIdentityEvidence.js';

test('hard attribute exclusion catches only explicit color and pattern contradictions', () => {
  assert.equal(hardAttributeExclusion(
    descriptor({ dominantColor: 'black', pattern: 'solid' }),
    descriptor({ dominantColor: 'white', pattern: 'solid' }),
  ), 'COLOR_FAMILY_CONTRADICTION');
  assert.equal(hardAttributeExclusion(
    descriptor({ dominantColor: 'black', pattern: 'stripe' }),
    descriptor({ dominantColor: 'white', pattern: 'check' }),
  ), 'COLOR_AND_PATTERN_CONTRADICTION');
  assert.equal(hardAttributeExclusion(
    descriptor({ dominantColor: 'unknown', pattern: 'solid' }),
    descriptor({ dominantColor: 'white', pattern: 'solid' }),
  ), undefined);
  assert.equal(hardAttributeExclusion(
    descriptor({ dominantColor: 'black', pattern: 'other' }),
    descriptor({ dominantColor: 'white', pattern: 'check' }),
  ), undefined);
});

test('hard attribute exclusion handles sleeve, neckline, and length conservatively', () => {
  assert.equal(hardAttributeExclusion(
    descriptor({ sleeve: 'sleeveless' }),
    descriptor({ sleeve: 'long' }),
  ), 'SLEEVE_CLASS_CONTRADICTION');
  assert.equal(hardAttributeExclusion(
    descriptor({ sleeve: 'short' }),
    descriptor({ sleeve: 'three_quarter' }),
  ), undefined);
  assert.equal(hardAttributeExclusion(
    descriptor({ neckline: 'turtleneck' }),
    descriptor({ neckline: 'v' }),
  ), 'NECKLINE_FAMILY_CONTRADICTION');
  assert.equal(hardAttributeExclusion(
    descriptor({ neckline: 'crew' }),
    descriptor({ neckline: 'v' }),
  ), undefined);
  assert.equal(hardAttributeExclusion(
    descriptor({ lengthClass: 'short' }),
    descriptor({ lengthClass: 'long' }),
  ), 'LENGTH_CLASS_CONTRADICTION');
  assert.equal(hardAttributeExclusion(
    descriptor({ lengthClass: 'medium' }),
    descriptor({ lengthClass: 'long' }),
  ), undefined);
  assert.equal(hardAttributeExclusion(
    descriptor({ sleeve: 'unknown', neckline: 'unknown', lengthClass: 'unknown' }),
    descriptor({ sleeve: 'long', neckline: 'hooded', lengthClass: 'long' }),
  ), undefined);
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
      feature: 'pocket', currentVisibility: 'visible', referenceVisibility: 'visible', relation: 'same',
      discriminativeStrength: 'strong', note: 'fixture',
    }],
    occlusions: [], jointlyVisibleEvidence: ['pocket'], model: 'fixture', ...overrides,
  };
}

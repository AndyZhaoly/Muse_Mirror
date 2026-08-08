import type {
  GarmentAppearanceDescriptor,
  GarmentFeatureComparison,
  PairwiseGarmentVerification,
} from '../domain/ambientCapture.js';
import type { GarmentIdentityCandidate } from './garmentIdentityProvider.js';
import {
  canonicalizeColor,
  canonicalizeLengthClass,
  canonicalizeNeckline,
  canonicalizePattern,
  colorSimilarity,
  sleeveClassDistance,
} from './garmentVocabulary.js';

const WEAK_ONLY_FEATURES = new Set(['length', 'fit', 'silhouette']);
const GENERIC_SAME_FEATURES = new Set(['color', 'length', 'fit', 'silhouette']);
const NON_DECISIVE_DIFFERENT_FEATURES = new Set(['color', 'length', 'fit', 'silhouette']);

export interface NormalizedPairwiseVerification {
  verification: PairwiseGarmentVerification;
  downgradeReasons: string[];
}

export interface IdentityEvidenceThresholds {
  matchConfidence: number;
  baseNewConfidence: number;
  safeSameMinPrior: number;
}

export type HardAttributeExclusionReason =
  | 'COLOR_FAMILY_CONTRADICTION'
  | 'COLOR_AND_PATTERN_CONTRADICTION'
  | 'SLEEVE_CLASS_CONTRADICTION'
  | 'NECKLINE_FAMILY_CONTRADICTION'
  | 'LENGTH_CLASS_CONTRADICTION';

export function requiredDifferentConfidence(
  effectivePrior: number,
  baseNewConfidence = 0.78,
): number {
  const priorPenalty = Math.max(0, effectivePrior - 0.6) * 0.5;
  return Math.min(0.95, baseNewConfidence + priorPenalty);
}

export function normalizePairwiseVerification(
  raw: PairwiseGarmentVerification,
  lockedDescriptor?: GarmentAppearanceDescriptor,
): NormalizedPairwiseVerification {
  const downgradeReasons: string[] = [];
  const featureComparisons = raw.featureComparisons.map((comparison) => normalizeComparison(
    comparison,
    downgradeReasons,
  ));
  const hasUsableSame = featureComparisons.some((comparison) =>
    jointlyVisible(comparison) && comparison.relation === 'same');
  const hasUsableDifferent = featureComparisons.some((comparison) =>
    jointlyVisible(comparison) && comparison.relation === 'different' &&
    comparison.discriminativeStrength !== 'weak' && !WEAK_ONLY_FEATURES.has(comparison.feature));
  let verdict = raw.verdict;
  if (verdict === 'same' && !hasUsableSame) {
    verdict = 'uncertain';
    downgradeReasons.push('SAME_WITHOUT_JOINTLY_VISIBLE_EVIDENCE');
  }
  if (verdict === 'different' && !hasUsableDifferent) {
    verdict = 'uncertain';
    downgradeReasons.push('DIFFERENT_WITHOUT_JOINTLY_VISIBLE_EVIDENCE');
  }
  if (lockedDescriptor && verifierReadConflictsWithLockedDescriptor(raw, lockedDescriptor)) {
    verdict = 'uncertain';
    downgradeReasons.push('VERIFIER_INCONSISTENT_CURRENT_READ');
  }
  return {
    verification: {
      ...raw,
      verdict,
      confidence: clamp(raw.confidence),
      featureComparisons,
    },
    downgradeReasons: [...new Set(downgradeReasons)],
  };
}

export function isSafeSame(
  candidate: GarmentIdentityCandidate,
  verification: PairwiseGarmentVerification,
  thresholds: Pick<IdentityEvidenceThresholds, 'matchConfidence' | 'safeSameMinPrior'>,
): boolean {
  if (candidate.tier === 'fallback' || verification.verdict !== 'same' ||
      verification.confidence < thresholds.matchConfidence ||
      candidate.effectivePrior < thresholds.safeSameMinPrior) return false;
  const evidence = verification.featureComparisons.filter(jointlyVisible);
  const hasDiscriminativeMatch = evidence.some((comparison) =>
    comparison.relation === 'same' &&
    comparison.discriminativeStrength !== 'weak' &&
    !GENERIC_SAME_FEATURES.has(comparison.feature));
  const hasStrongContradiction = evidence.some((comparison) =>
    comparison.relation === 'different' && comparison.discriminativeStrength === 'strong');
  return hasDiscriminativeMatch && !hasStrongContradiction;
}

export function isSafeDifferent(
  candidate: GarmentIdentityCandidate,
  verification: PairwiseGarmentVerification,
  thresholds: Pick<IdentityEvidenceThresholds, 'baseNewConfidence'>,
): boolean {
  if (candidate.tier === 'fallback' || verification.verdict !== 'different' ||
      verification.confidence < requiredDifferentConfidence(candidate.effectivePrior, thresholds.baseNewConfidence)) {
    return false;
  }
  if (candidate.effectivePrior >= 0.7 && verification.occlusions.length > 0) return false;
  return verification.featureComparisons.some((comparison) =>
    jointlyVisible(comparison) &&
    comparison.relation === 'different' &&
    comparison.discriminativeStrength !== 'weak' &&
    !NON_DECISIVE_DIFFERENT_FEATURES.has(comparison.feature));
}

export function hardAttributeExclusion(
  current: GarmentAppearanceDescriptor,
  candidate: GarmentAppearanceDescriptor,
): HardAttributeExclusionReason | undefined {
  const currentColor = canonicalizeColor(current.dominantColor);
  const candidateColor = canonicalizeColor(candidate.dominantColor);
  const colorsKnown = currentColor !== 'unknown' && candidateColor !== 'unknown' &&
    currentColor !== 'multicolor' && candidateColor !== 'multicolor';
  const currentPattern = canonicalizePattern(current.pattern);
  const candidatePattern = canonicalizePattern(candidate.pattern);
  const patternsKnown = currentPattern !== 'other' && candidatePattern !== 'other';
  const colorsContradict = colorsKnown && colorSimilarity(currentColor, candidateColor) === 0;

  if (colorsContradict && currentPattern === 'solid' && candidatePattern === 'solid') {
    return 'COLOR_FAMILY_CONTRADICTION';
  }
  if (colorsContradict && patternsKnown && currentPattern !== candidatePattern) {
    return 'COLOR_AND_PATTERN_CONTRADICTION';
  }
  const sleeveDistance = sleeveClassDistance(current.sleeve, candidate.sleeve);
  if (sleeveDistance !== undefined && sleeveDistance >= 2) return 'SLEEVE_CLASS_CONTRADICTION';
  if (necklineFamilyContradiction(current.neckline, candidate.neckline)) {
    return 'NECKLINE_FAMILY_CONTRADICTION';
  }
  const currentLength = canonicalizeLengthClass(current.lengthClass);
  const candidateLength = canonicalizeLengthClass(candidate.lengthClass);
  if ((currentLength === 'short' && candidateLength === 'long') ||
      (currentLength === 'long' && candidateLength === 'short')) {
    return 'LENGTH_CLASS_CONTRADICTION';
  }
  return undefined;
}

export function necklineFamilyContradiction(left: string | undefined, right: string | undefined): boolean {
  const a = canonicalizeNeckline(left);
  const b = canonicalizeNeckline(right);
  if (a === 'unknown' || b === 'unknown' || a === b) return false;
  const pair = new Set([a, b]);
  if (pair.has('turtleneck') && (pair.has('v') || pair.has('square') || pair.has('boat'))) return true;
  if (pair.has('hooded') && (pair.has('v') || pair.has('square') || pair.has('collar') || pair.has('turtleneck'))) {
    return true;
  }
  return false;
}

function verifierReadConflictsWithLockedDescriptor(
  raw: PairwiseGarmentVerification,
  locked: GarmentAppearanceDescriptor,
): boolean {
  const lockedColor = canonicalizeColor(locked.dominantColor);
  const reportedColor = canonicalizeColor(raw.currentColor ?? 'unknown');
  if (lockedColor !== 'unknown' && reportedColor !== 'unknown' && colorSimilarity(lockedColor, reportedColor) === 0) {
    return true;
  }
  const sleeveDistance = sleeveClassDistance(locked.sleeve, raw.currentSleeve);
  if (sleeveDistance !== undefined && sleeveDistance >= 2) return true;
  return necklineFamilyContradiction(locked.neckline, raw.currentNeckline);
}

function normalizeComparison(
  comparison: GarmentFeatureComparison,
  downgradeReasons: string[],
): GarmentFeatureComparison {
  let relation = comparison.relation;
  let discriminativeStrength = comparison.discriminativeStrength;
  if (!jointlyVisible(comparison) && relation !== 'unknown') {
    relation = 'unknown';
    downgradeReasons.push(`NON_JOINT_VISIBILITY:${comparison.feature}`);
  }
  if (WEAK_ONLY_FEATURES.has(comparison.feature) && discriminativeStrength !== 'weak') {
    discriminativeStrength = 'weak';
    downgradeReasons.push(`WEAK_ONLY_FEATURE:${comparison.feature}`);
  }
  return { ...comparison, relation, discriminativeStrength };
}

function jointlyVisible(comparison: GarmentFeatureComparison): boolean {
  return comparison.currentVisibility === 'visible' && comparison.referenceVisibility === 'visible';
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

import type { GarmentFeatureComparison, PairwiseGarmentVerification } from '../domain/ambientCapture.js';
import type { GarmentIdentityCandidate } from './garmentIdentityProvider.js';

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
}

export function requiredDifferentConfidence(
  effectivePrior: number,
  baseNewConfidence = 0.78,
): number {
  const priorPenalty = Math.max(0, effectivePrior - 0.6) * 0.5;
  return Math.min(0.95, baseNewConfidence + priorPenalty);
}

export function normalizePairwiseVerification(
  raw: PairwiseGarmentVerification,
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
  thresholds: Pick<IdentityEvidenceThresholds, 'matchConfidence'>,
): boolean {
  if (candidate.tier === 'fallback' || verification.verdict !== 'same' ||
      verification.confidence < thresholds.matchConfidence) return false;
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
  return verification.featureComparisons.some((comparison) =>
    jointlyVisible(comparison) &&
    comparison.relation === 'different' &&
    comparison.discriminativeStrength !== 'weak' &&
    !NON_DECISIVE_DIFFERENT_FEATURES.has(comparison.feature));
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

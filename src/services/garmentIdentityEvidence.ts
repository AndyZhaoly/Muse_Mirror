import type {
  GarmentAppearanceDescriptor,
  GarmentFeatureComparison,
  GarmentIdentityFeature,
  IdentityEvidenceClass,
  PairwiseGarmentVerification,
  TemporalEvidenceConsistency,
} from '../domain/ambientCapture.js';
import type { GarmentIdentityCandidate } from './garmentIdentityProvider.js';
import {
  canonicalizeColor,
  canonicalizeLengthClass,
  canonicalizeNeckline,
  canonicalizePattern,
  canonicalizeSleeve,
  colorSimilarity,
  sleeveClassDistance,
} from './garmentVocabulary.js';

export const IDENTITY_EVIDENCE_TAXONOMY_VERSION = 1;

const CLASS_LEVEL_FEATURES = new Set<GarmentIdentityFeature>([
  'color', 'pattern_family', 'category', 'sleeve_length', 'neckline_family', 'texture_family',
  'fit', 'silhouette', 'length', 'general_shape',
]);
const INSTANCE_SPECIFIC_FEATURES = new Set<GarmentIdentityFeature>([
  'pattern_placement', 'print_placement', 'logo_placement', 'pocket_geometry',
  'drawstring_construction', 'closure_layout', 'button_layout', 'zipper_details',
  'unique_decoration', 'stitching_layout', 'waistband_construction', 'hem_construction',
  'cuff_construction', 'unique_texture_detail', 'distinctive_hardware',
]);
const WEAK_ONLY_FEATURES = new Set<GarmentIdentityFeature>(['color', 'length', 'fit', 'silhouette', 'general_shape']);

export interface NormalizedPairwiseVerification {
  verification: PairwiseGarmentVerification;
  downgradeReasons: string[];
}

export interface IdentityEvidenceThresholds {
  matchConfidence: number;
  baseNewConfidence: number;
}

export interface SafeSameAssessment {
  safe: boolean;
  rejectReasons: string[];
  classLevelSameFeatures: GarmentIdentityFeature[];
  instanceSpecificSameFeatures: GarmentIdentityFeature[];
  temporalEvidenceConsistency: TemporalEvidenceConsistency;
}

export type CoreIdentityTag =
  | 'category'
  | 'dominant_color'
  | 'pattern_family'
  | 'sleeve_length'
  | 'garment_length'
  | 'neckline_family';

export interface CoreIdentityTagComparison {
  agreements: CoreIdentityTag[];
  contradictions: CoreIdentityTag[];
}

export type HardAttributeExclusionReason = 'PHYSICAL_CATEGORY_OR_SLOT_CONTRADICTION';

export interface AttributeCompatibilityResult {
  hardExclusion?: HardAttributeExclusionReason;
  softContradictions: string[];
}

export function identityEvidenceClass(feature: GarmentIdentityFeature): IdentityEvidenceClass {
  if (INSTANCE_SPECIFIC_FEATURES.has(feature)) return 'instance_specific';
  if (CLASS_LEVEL_FEATURES.has(feature)) return 'class_level';
  return 'supporting_identity';
}

export function isInstanceSpecificFeature(feature: GarmentIdentityFeature): boolean {
  return identityEvidenceClass(feature) === 'instance_specific';
}

export function isClassLevelFeature(feature: GarmentIdentityFeature): boolean {
  return identityEvidenceClass(feature) === 'class_level';
}

export function requiredDifferentConfidence(
  _effectivePrior: number,
  baseNewConfidence = 0.78,
): number {
  return baseNewConfidence;
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
  const currentFrameEvidence = (raw.currentFrameEvidence ?? []).map((frame) => ({
    ...frame,
    featureComparisons: frame.featureComparisons.map((comparison) => normalizeComparison(comparison, downgradeReasons)),
  }));
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
      currentFrameEvidence,
      temporalEvidenceConsistency: deriveTemporalEvidenceConsistency(
        currentFrameEvidence,
        raw.temporalEvidenceConsistency ?? 'insufficient',
      ),
    },
    downgradeReasons: [...new Set(downgradeReasons)],
  };
}

export function assessSafeSame(
  candidate: GarmentIdentityCandidate,
  verification: PairwiseGarmentVerification,
  thresholds: Pick<IdentityEvidenceThresholds, 'matchConfidence'>,
  _currentEvidenceCount = 1,
): SafeSameAssessment {
  const rejectReasons: string[] = [];
  const jointlyVisibleEvidence = verification.featureComparisons.filter(jointlyVisible);
  const same = jointlyVisibleEvidence.filter((comparison) => comparison.relation === 'same');
  const classLevelSameFeatures = uniqueFeatures(same.filter((comparison) =>
    isClassLevelFeature(comparison.feature)));
  const instanceSpecific = same.filter((comparison) => isInstanceSpecificFeature(comparison.feature));
  const instanceSpecificSameFeatures = uniqueFeatures(instanceSpecific);
  const hasStrongContradiction = jointlyVisibleEvidence.some((comparison) =>
    comparison.relation === 'different' &&
    comparison.discriminativeStrength === 'strong' &&
    isInstanceSpecificFeature(comparison.feature));
  const temporalEvidenceConsistency = verification.temporalEvidenceConsistency ?? 'insufficient';

  if (candidate.tier === 'fallback') rejectReasons.push('FALLBACK_CANDIDATE_NOT_MATCH_ELIGIBLE');
  if (verification.verdict !== 'same') rejectReasons.push('VERDICT_NOT_SAME');
  if (verification.confidence < thresholds.matchConfidence) rejectReasons.push('MATCH_CONFIDENCE_BELOW_THRESHOLD');
  if (hasStrongContradiction) rejectReasons.push('STRONG_INSTANCE_CONTRADICTION');

  if (temporalEvidenceConsistency === 'mixed') rejectReasons.push('MIXED_TEMPORAL_EVIDENCE');

  return {
    safe: rejectReasons.length === 0,
    rejectReasons: [...new Set(rejectReasons)],
    classLevelSameFeatures,
    instanceSpecificSameFeatures,
    temporalEvidenceConsistency,
  };
}

export function isSafeSame(
  candidate: GarmentIdentityCandidate,
  verification: PairwiseGarmentVerification,
  thresholds: Pick<IdentityEvidenceThresholds, 'matchConfidence'>,
  currentEvidenceCount = 1,
): boolean {
  return assessSafeSame(candidate, verification, thresholds, currentEvidenceCount).safe;
}

export function isSafeDifferent(
  candidate: GarmentIdentityCandidate,
  verification: PairwiseGarmentVerification,
  thresholds: Pick<IdentityEvidenceThresholds, 'baseNewConfidence'>,
): boolean {
  if (candidate.tier === 'fallback' || verification.verdict !== 'different' ||
      verification.confidence < thresholds.baseNewConfidence) {
    return false;
  }
  return verification.featureComparisons.some((comparison) =>
    jointlyVisible(comparison) &&
    comparison.relation === 'different' &&
    comparison.discriminativeStrength !== 'weak');
}

/**
 * Compares only coarse, visually stable garment tags. A contradiction is
 * useful for proving two garments are different; agreements are supporting
 * evidence and never prove identity on their own without continuity or VLM.
 */
export function compareCoreIdentityTags(
  current: GarmentAppearanceDescriptor,
  candidate: GarmentAppearanceDescriptor,
): CoreIdentityTagComparison {
  const agreements: CoreIdentityTag[] = [];
  const contradictions: CoreIdentityTag[] = [];

  if (current.slot === candidate.slot && samePhysicalCategory(current.category, candidate.category)) {
    agreements.push('category');
  } else {
    contradictions.push('category');
  }

  const currentColors = identityPalette(current);
  const candidateColors = identityPalette(candidate);
  if (currentColors.length && candidateColors.length) {
    const similarities = currentColors.flatMap((left) =>
      candidateColors.map((right) => colorSimilarity(left, right)));
    if (similarities.some((similarity) => similarity > 0)) agreements.push('dominant_color');
    else contradictions.push('dominant_color');
  }

  const currentPattern = canonicalizePattern(current.pattern);
  const candidatePattern = canonicalizePattern(candidate.pattern);
  if (currentPattern !== 'other' && candidatePattern !== 'other') {
    if (currentPattern === candidatePattern) agreements.push('pattern_family');
    else if (obviousPatternContradiction(currentPattern, candidatePattern)) contradictions.push('pattern_family');
  }

  const currentSleeve = canonicalizeSleeve(current.sleeve);
  const candidateSleeve = canonicalizeSleeve(candidate.sleeve);
  if (currentSleeve !== 'unknown' && candidateSleeve !== 'unknown') {
    if (currentSleeve === candidateSleeve) agreements.push('sleeve_length');
    else if (obviousSleeveContradiction(currentSleeve, candidateSleeve)) contradictions.push('sleeve_length');
  }

  const currentLength = canonicalizeLengthClass(current.lengthClass);
  const candidateLength = canonicalizeLengthClass(candidate.lengthClass);
  if (currentLength !== 'unknown' && candidateLength !== 'unknown') {
    if (currentLength === candidateLength) agreements.push('garment_length');
    else if (new Set([currentLength, candidateLength]).has('short') &&
      new Set([currentLength, candidateLength]).has('long')) contradictions.push('garment_length');
  }

  const currentNeckline = canonicalizeNeckline(current.neckline);
  const candidateNeckline = canonicalizeNeckline(candidate.neckline);
  if (currentNeckline !== 'unknown' && candidateNeckline !== 'unknown') {
    if (currentNeckline === candidateNeckline) agreements.push('neckline_family');
    else if (obviousNecklineContradiction(currentNeckline, candidateNeckline)) contradictions.push('neckline_family');
  }

  return {
    agreements: [...new Set(agreements)],
    contradictions: [...new Set(contradictions)],
  };
}

export function attributeCompatibility(
  current: GarmentAppearanceDescriptor,
  candidate: GarmentAppearanceDescriptor,
): AttributeCompatibilityResult {
  const softContradictions: string[] = [];
  if (current.slot !== candidate.slot || !samePhysicalCategory(current.category, candidate.category)) {
    return { hardExclusion: 'PHYSICAL_CATEGORY_OR_SLOT_CONTRADICTION', softContradictions };
  }
  const currentColor = canonicalizeColor(current.dominantColor);
  const candidateColor = canonicalizeColor(candidate.dominantColor);
  if (currentColor !== 'unknown' && candidateColor !== 'unknown' &&
      currentColor !== 'multicolor' && candidateColor !== 'multicolor' &&
      colorSimilarity(currentColor, candidateColor) === 0) {
    softContradictions.push('COLOR_FAMILY_CONTRADICTION');
  }
  const currentPattern = canonicalizePattern(current.pattern);
  const candidatePattern = canonicalizePattern(candidate.pattern);
  if (currentPattern !== 'other' && candidatePattern !== 'other' && currentPattern !== candidatePattern) {
    softContradictions.push('PATTERN_FAMILY_CONTRADICTION');
  }
  if (sleeveClassDistance(current.sleeve, candidate.sleeve) === 2) {
    softContradictions.push('SLEEVE_CLASS_CONTRADICTION');
  }
  if (necklineFamilyContradiction(current.neckline, candidate.neckline)) {
    softContradictions.push('NECKLINE_FAMILY_CONTRADICTION');
  }
  const currentLength = canonicalizeLengthClass(current.lengthClass);
  const candidateLength = canonicalizeLengthClass(candidate.lengthClass);
  if ((currentLength === 'short' && candidateLength === 'long') ||
      (currentLength === 'long' && candidateLength === 'short')) {
    softContradictions.push('LENGTH_CLASS_CONTRADICTION');
  }
  return { softContradictions };
}

function identityPalette(descriptor: GarmentAppearanceDescriptor): string[] {
  return [...new Set([descriptor.dominantColor, ...descriptor.secondaryColors]
    .map(canonicalizeColor)
    .filter((color) => color !== 'unknown' && color !== 'multicolor'))];
}

function obviousPatternContradiction(left: string, right: string): boolean {
  if (left === right) return false;
  const stableFamilies = new Set(['stripe', 'check', 'floral', 'print', 'graphic', 'colorblock']);
  if (left === 'solid' || right === 'solid') {
    return stableFamilies.has(left === 'solid' ? right : left);
  }
  return stableFamilies.has(left) && stableFamilies.has(right);
}

function obviousSleeveContradiction(left: string, right: string): boolean {
  if (left === right || left === 'three_quarter' || right === 'three_quarter') return false;
  return true;
}

function obviousNecklineContradiction(left: string, right: string): boolean {
  if (left === right) return false;
  const stableFamilies = new Set(['crew', 'v', 'collar', 'turtleneck', 'hooded']);
  return stableFamilies.has(left) && stableFamilies.has(right);
}

export function hardAttributeExclusion(
  current: GarmentAppearanceDescriptor,
  candidate: GarmentAppearanceDescriptor,
): HardAttributeExclusionReason | undefined {
  return attributeCompatibility(current, candidate).hardExclusion;
}

export function necklineFamilyContradiction(left: string | undefined, right: string | undefined): boolean {
  const a = canonicalizeNeckline(left);
  const b = canonicalizeNeckline(right);
  if (a === 'unknown' || b === 'unknown' || a === b) return false;
  const pair = new Set([a, b]);
  if (pair.has('turtleneck') && (pair.has('v') || pair.has('square') || pair.has('boat'))) return true;
  return pair.has('hooded') && (pair.has('v') || pair.has('square') || pair.has('collar') || pair.has('turtleneck'));
}

function samePhysicalCategory(left: string, right: string): boolean {
  if (left === right) return true;
  const topFamily = new Set(['top', 'outerwear']);
  return topFamily.has(left) && topFamily.has(right);
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
  if (isClassLevelFeature(comparison.feature) && discriminativeStrength === 'strong') {
    discriminativeStrength = 'medium';
    downgradeReasons.push(`CLASS_LEVEL_FEATURE_CANNOT_BE_STRONG:${comparison.feature}`);
  }
  return { ...comparison, relation, discriminativeStrength };
}

function jointlyVisible(comparison: GarmentFeatureComparison): boolean {
  return comparison.currentVisibility === 'visible' && comparison.referenceVisibility === 'visible';
}

function uniqueFeatures(comparisons: GarmentFeatureComparison[]): GarmentIdentityFeature[] {
  return [...new Set(comparisons.map((comparison) => comparison.feature))];
}

function deriveTemporalEvidenceConsistency(
  frames: NonNullable<PairwiseGarmentVerification['currentFrameEvidence']>,
  declared: TemporalEvidenceConsistency,
): TemporalEvidenceConsistency {
  if (declared === 'mixed') return 'mixed';
  const distinctFrames = [...new Map(frames.map((frame) => [frame.frameIndex, frame])).values()];
  if (distinctFrames.length < 2) return 'insufficient';
  const evidenceByFrame = distinctFrames.map((frame) => frame.featureComparisons.filter((comparison) =>
    jointlyVisible(comparison) &&
    isInstanceSpecificFeature(comparison.feature) &&
    comparison.discriminativeStrength !== 'weak' &&
    comparison.relation !== 'unknown'));
  const relations = new Map<GarmentIdentityFeature, Set<'same' | 'different'>>();
  for (const comparisons of evidenceByFrame) {
    for (const comparison of comparisons) {
      const values = relations.get(comparison.feature) ?? new Set<'same' | 'different'>();
      values.add(comparison.relation as 'same' | 'different');
      relations.set(comparison.feature, values);
    }
  }
  if ([...relations.values()].some((values) => values.has('same') && values.has('different'))) return 'mixed';
  const sameFeatureSets = evidenceByFrame.map((comparisons) => new Set(
    comparisons.filter((comparison) => comparison.relation === 'same').map((comparison) => comparison.feature),
  ));
  if (sameFeatureSets.some((features) => features.size === 0)) return 'insufficient';
  const shared = [...sameFeatureSets[0]!].filter((feature) => sameFeatureSets.every((features) => features.has(feature)));
  return shared.length > 0 && declared === 'consistent' ? 'consistent' : 'insufficient';
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

import { createHash } from 'node:crypto';
import type {
  AmbientClosetItem,
  GarmentAppearance,
  GarmentAppearanceDescriptor,
  GarmentIdentityDecisionTrace,
  GarmentIdentityHypothesis,
  GarmentImageAsset,
  IdentityCandidateTier,
  IdentityCategoryCompatibility,
  OutfitCapture,
  PairwiseGarmentVerification,
  ReferenceEvidenceType,
  WearEvent,
  WornGarmentObservation,
} from '../domain/ambientCapture.js';
import type { ClosetItem } from '../types.js';
import { makeId } from '../utils/ids.js';
import {
  assessSafeSame,
  attributeCompatibility,
  hardAttributeExclusion,
  isSafeDifferent,
  isSafeSame,
  normalizePairwiseVerification,
  requiredDifferentConfidence,
} from './garmentIdentityEvidence.js';
import type { GarmentPairwiseVerifier } from './garmentVisualVerifier.js';
import { GARMENT_PAIRWISE_PROMPT_VERSION } from './garmentVisualVerifier.js';
import {
  canonicalizeColor,
  canonicalizeFit,
  canonicalizeGarmentSlot,
  canonicalizeLengthClass,
  canonicalizeMaterialClass,
  canonicalizeNeckline,
  canonicalizePattern,
  canonicalizeSleeve,
  colorSimilarity,
} from './garmentVocabulary.js';

export interface GarmentIdentityInput {
  userId: string;
  episodeId?: string;
  capturedAt?: string;
  garment: WornGarmentObservation;
  currentAppearances: GarmentImageAsset[];
  baseClosetItems: ClosetItem[];
  userClosetItems: AmbientClosetItem[];
  appearances: GarmentAppearance[];
  assets: GarmentImageAsset[];
  captures?: OutfitCapture[];
  wearEvents?: WearEvent[];
  baseCatalogAssets?: Map<string, GarmentImageAsset>;
}

export interface GarmentIdentityProvider {
  readonly ready?: boolean;
  recall?(input: GarmentIdentityInput): GarmentRecallResult;
  resolve(input: GarmentIdentityInput): Promise<GarmentIdentityHypothesis>;
}

export interface GarmentIdentityCandidate {
  closetItemId: string;
  source: 'base' | 'user';
  metadataScore: number;
  continuityPrior: number;
  effectivePrior: number;
  tier: IdentityCandidateTier;
  categoryCompatibility: IdentityCategoryCompatibility;
  referenceEvidenceType: ReferenceEvidenceType;
  softContradictions: string[];
  descriptor: GarmentAppearanceDescriptor;
  referenceAppearanceAssetIds: string[];
  closetItem: ClosetItem;
  referenceAppearances: GarmentImageAsset[];
  catalogFallbackImage?: GarmentImageAsset;
}

export interface GarmentRecallCandidate extends Omit<
  GarmentIdentityCandidate,
  'closetItem' | 'descriptor' | 'referenceAppearances' | 'catalogFallbackImage'
> {
  appearanceCount: number;
  hasCatalogFallbackImage: boolean;
}

export interface GarmentRecallResult {
  candidates: GarmentRecallCandidate[];
  strategy:
    | 'metadata'
    | 'slot_category_fallback'
    | 'empty_compatible_closet'
    | 'potential_match_without_visual_reference';
  evidence: string[];
}

interface VerificationRecord {
  candidate: GarmentIdentityCandidate;
  evaluation: 'verified' | 'excluded';
  exclusionReason?: string;
  raw: PairwiseGarmentVerification;
  normalized: PairwiseGarmentVerification;
  downgradeReasons: string[];
  latencyMs: number;
}

export class VisualGarmentIdentityProvider implements GarmentIdentityProvider {
  readonly ready: boolean;

  constructor(
    private readonly options: {
      verifier: GarmentPairwiseVerifier;
      topK?: number;
      matchConfidence?: number;
      baseNewConfidence?: number;
      newConfidence?: number;
      strongPriorVeto?: number;
      vetoMinPrior?: number;
      maxVisualCandidates?: number;
      newConfidenceCeiling?: number;
      strongContinuityWindowMs?: number;
      weakContinuityWindowMs?: number;
      strongContinuityWeight?: number;
      weakContinuityWeight?: number;
      trace?: boolean;
    },
  ) {
    this.ready = options.verifier.ready;
  }

  recall(input: GarmentIdentityInput): GarmentRecallResult {
    return recallGarmentIdentityCandidates(input, this.options.topK ?? 4);
  }

  async resolve(input: GarmentIdentityInput): Promise<GarmentIdentityHypothesis> {
    const descriptor = descriptorFromObservation(input.garment);
    const fingerprint = appearanceFingerprint(descriptor);
    const thresholds = {
      matchConfidence: this.options.matchConfidence ?? 0.88,
      baseNewConfidence: this.options.baseNewConfidence ?? this.options.newConfidence ?? 0.78,
      strongPriorVeto: this.options.strongPriorVeto ?? 0.85,
      vetoMinPrior: this.options.vetoMinPrior ?? 0.6,
    };
    const traceBase = {
      traceId: makeId('identity_trace'),
      episodeId: input.episodeId ?? 'unknown_episode',
      observationItemId: input.garment.observationItemId,
      currentAppearanceAssetId: input.currentAppearances.at(-1)!.assetId,
      currentAppearanceAssetIds: input.currentAppearances.map((asset) => asset.assetId),
      thresholds,
      promptVersion: GARMENT_PAIRWISE_PROMPT_VERSION,
      schemaVersion: 1,
      createdAt: input.capturedAt ?? input.currentAppearances.at(-1)!.createdAt,
    } as const;

    if (input.garment.confidence < 0.72 || !usableDescriptor(descriptor)) {
      return this.finalize(input, fingerprint, [], [], traceBase, 'insufficient_evidence', 0, [
        'LOW_GARMENT_EVIDENCE',
      ]);
    }

    const candidates = buildIdentityCandidates(input, this.options);
    const recall = recallFromCandidates(candidates, this.options.topK ?? 4);
    if (recall.strategy === 'empty_compatible_closet') {
      return this.finalize(input, fingerprint, [], [], traceBase, 'new_to_closet', newIdentityConfidence(
        input,
        input.garment.confidence,
        this.options.newConfidenceCeiling,
      ), ['COMPATIBLE_CLOSET_TRULY_EMPTY', ...recall.evidence], recall);
    }
    const selected = candidatesForRecall(candidates, recall);
    const decisionCandidates = selected.filter((candidate) => candidate.tier !== 'fallback');
    if (!decisionCandidates.length) {
      return this.finalize(input, fingerprint, selected, [], traceBase, 'ambiguous', 0, [
        'ONLY_FALLBACK_CANDIDATES',
        ...recall.evidence,
      ], recall);
    }
    const excludedResults = decisionCandidates.flatMap((candidate) => {
      const reason = hardAttributeExclusion(descriptor, candidate.descriptor);
      return reason ? [excludedVerificationRecord(candidate, descriptor, reason)] : [];
    });
    const excludedIds = new Set(excludedResults.map((result) => result.candidate.closetItemId));
    const survivors = decisionCandidates.filter((candidate) => !excludedIds.has(candidate.closetItemId));
    const vetoSet = survivors.filter((candidate) => candidate.effectivePrior >= thresholds.vetoMinPrior);
    const topPrior = decisionCandidates[0]?.effectivePrior ?? 0;

    if (!this.options.verifier.ready && vetoSet.length > 0) {
      return this.finalize(input, fingerprint, selected, excludedResults, traceBase, 'ambiguous', 0, [
        'REAL_VISUAL_VERIFIER_UNAVAILABLE',
        ...recall.evidence,
      ], recall);
    }

    const candidatesWithReferences = survivors.filter((candidate) =>
      candidate.referenceAppearances.length > 0 || candidate.catalogFallbackImage);
    const missingVetoReferences = vetoSet.filter((candidate) =>
      candidate.referenceAppearances.length === 0 && !candidate.catalogFallbackImage);
    const missingReferenceReasonCodes = missingVetoReferences.flatMap((candidate) => [
      'NO_VISUAL_REFERENCE_FOR_POTENTIAL_MATCH',
      `MISSING_VISUAL_REFERENCE:${candidate.closetItemId}`,
    ]);
    const maxVisualCandidates = Math.max(1, this.options.maxVisualCandidates ?? 3);
    const toVerify = candidatesWithReferences.slice(0, maxVisualCandidates);
    const verifiedResults: VerificationRecord[] = [];
    if (toVerify.length > 0 && this.options.verifier.ready) {
      const top = toVerify[0]!;
      verifiedResults.push(await this.verifyCandidate(input.currentAppearances, descriptor, top));
      verifiedResults.push(...await Promise.all(toVerify.slice(1).map((candidate) =>
        this.verifyCandidate(input.currentAppearances, descriptor, candidate))));
    }
    const results = [...excludedResults, ...verifiedResults];
    const safeMatches = verifiedResults.filter(({ candidate, normalized }) =>
      isSafeSame(candidate, normalized, thresholds, input.currentAppearances.length));
    if (safeMatches.length === 1) {
      const match = safeMatches[0]!;
      const verifiedIds = new Set(verifiedResults.map((result) => result.candidate.closetItemId));
      const unverifiedContender = survivors.some((candidate) =>
        candidate.tier !== 'fallback' &&
        !verifiedIds.has(candidate.closetItemId) &&
        (candidate.referenceAppearances.length > 0 || candidate.catalogFallbackImage));
      if (unverifiedContender) {
        return this.finalize(input, fingerprint, selected, results, traceBase, 'ambiguous',
          match.normalized.confidence, ['UNVERIFIED_MATCH_CONTENDER'], recall);
      }
      return this.finalize(input, fingerprint, selected, results, traceBase, 'matched_existing',
        match.normalized.confidence, [
          'REAL_VISUAL_APPEARANCE_MATCH',
          `RECALL_STRATEGY_${recall.strategy.toUpperCase()}`,
        ], recall, match.candidate.closetItemId);
    }
    if (safeMatches.length > 1) {
      return this.finalize(input, fingerprint, selected, results, traceBase, 'ambiguous',
        Math.max(...safeMatches.map((item) => item.normalized.confidence)), [
          'MULTIPLE_SAFE_MATCHES',
        ], recall);
    }

    if (topPrior >= thresholds.strongPriorVeto) {
      return this.finalize(input, fingerprint, selected, results, traceBase, 'ambiguous',
        verifiedResults[0]?.normalized.confidence ?? 0,
        [
          'HIGH_PRIOR_CANDIDATE_BLOCKS_NEW_ITEM',
          'STRONG_PRIOR_AUTO_CREATE_VETO',
          ...missingReferenceReasonCodes,
        ], recall);
    }

    const verifiedById = new Map(verifiedResults.map((result) => [result.candidate.closetItemId, result]));
    const allVetoCandidatesSafelyDifferent = missingVetoReferences.length === 0 && vetoSet.every((candidate) => {
      const result = verifiedById.get(candidate.closetItemId);
      return Boolean(result && isSafeDifferent(candidate, result.normalized, thresholds));
    });
    if (allVetoCandidatesSafelyDifferent) {
      const differentConfidences = vetoSet.flatMap((candidate) => {
        const result = verifiedById.get(candidate.closetItemId);
        return result ? [result.normalized.confidence] : [];
      });
      return this.finalize(input, fingerprint, selected, results, traceBase, 'new_to_closet', newIdentityConfidence(
        input,
        differentConfidences.length ? Math.min(...differentConfidences) : input.garment.confidence,
        this.options.newConfidenceCeiling,
      ), [
        vetoSet.length ? 'REAL_VISUAL_VETO_CANDIDATES_DIFFERENT' : 'NO_MATERIAL_VETO_CANDIDATES',
        `RECALL_STRATEGY_${recall.strategy.toUpperCase()}`,
      ], recall);
    }
    return this.finalize(input, fingerprint, selected, results, traceBase, 'ambiguous',
      verifiedResults[0]?.normalized.confidence ?? 0,
      ['INSUFFICIENT_SAFE_DIFFERENCE', ...missingReferenceReasonCodes], recall);
  }

  private async verifyCandidate(
    currentAppearances: GarmentImageAsset[],
    lockedDescriptor: GarmentAppearanceDescriptor,
    candidate: GarmentIdentityCandidate,
  ): Promise<VerificationRecord> {
    const startedAt = Date.now();
    const raw = await this.options.verifier.verifyPair({
      currentAppearances: currentAppearances.slice(-2),
      lockedDescriptor,
      candidate: {
        closetItem: candidate.closetItem,
        referenceAppearances: candidate.referenceAppearances.slice(0, 2),
        catalogFallbackImage: candidate.catalogFallbackImage,
      },
    });
    const normalized = normalizePairwiseVerification(raw, lockedDescriptor);
    return {
      candidate,
      evaluation: 'verified',
      raw,
      normalized: normalized.verification,
      downgradeReasons: normalized.downgradeReasons,
      latencyMs: Date.now() - startedAt,
    };
  }

  private finalize(
    input: GarmentIdentityInput,
    fingerprint: string,
    candidates: GarmentIdentityCandidate[],
    verificationResults: VerificationRecord[],
    traceBase: Omit<GarmentIdentityDecisionTrace, 'recall' | 'pairwiseVerifications' | 'finalDecision' | 'reasonCodes'>,
    status: GarmentIdentityHypothesis['status'],
    confidence: number,
    reasonCodes: string[],
    recall: GarmentRecallResult = { candidates: [], strategy: 'empty_compatible_closet', evidence: [] },
    matchedClosetItemId?: string,
  ): GarmentIdentityHypothesis {
    const trace: GarmentIdentityDecisionTrace = {
      ...traceBase,
      recall: {
        strategy: recall.strategy,
        candidates: candidates.map((candidate) => ({
          closetItemId: candidate.closetItemId,
          source: candidate.source,
          metadataScore: candidate.metadataScore,
          continuityPrior: candidate.continuityPrior,
          effectivePrior: candidate.effectivePrior,
          tier: candidate.tier,
          categoryCompatibility: candidate.categoryCompatibility,
          referenceEvidenceType: candidate.referenceEvidenceType,
          referenceAssetIds: candidate.referenceAppearanceAssetIds,
          softContradictions: candidate.softContradictions,
        })),
      },
      pairwiseVerifications: verificationResults.map((result) => {
        const gate = assessSafeSame(
          result.candidate,
          result.normalized,
          traceBase.thresholds,
          traceBase.currentAppearanceAssetIds?.length ?? 1,
        );
        return ({
        candidateClosetItemId: result.candidate.closetItemId,
        evaluation: result.evaluation,
        exclusionReason: result.exclusionReason,
        rawResult: result.raw,
        normalizedResult: result.normalized,
        serverDowngradeReasons: result.downgradeReasons,
        requiredDifferentConfidence: requiredDifferentConfidence(
          result.candidate.effectivePrior,
          traceBase.thresholds.baseNewConfidence,
        ),
        autoCreateVeto: result.candidate.effectivePrior >= traceBase.thresholds.strongPriorVeto,
        referenceEvidenceType: result.candidate.referenceEvidenceType,
        evidenceTaxonomyVersion: 1,
        classLevelSameFeatures: gate.classLevelSameFeatures,
        instanceSpecificSameFeatures: gate.instanceSpecificSameFeatures,
        safeSameGateResult: gate.safe,
        safeSameRejectReasons: gate.rejectReasons,
        multiFrameEvidenceCount: traceBase.currentAppearanceAssetIds?.length ?? 1,
        temporalEvidenceConsistency: gate.temporalEvidenceConsistency,
        model: result.raw.model,
        latencyMs: result.latencyMs,
      }); }),
      finalDecision: status,
      matchedClosetItemId,
      reasonCodes,
    };
    if (this.options.trace) {
      console.info('[GarmentIdentityTrace]', JSON.stringify({
        traceId: trace.traceId,
        episodeId: trace.episodeId,
        observationItemId: trace.observationItemId,
        recall: trace.recall.candidates.map((candidate) => ({
          closetItemId: candidate.closetItemId,
          metadataScore: candidate.metadataScore,
          continuityPrior: candidate.continuityPrior,
          effectivePrior: candidate.effectivePrior,
          tier: candidate.tier,
        })),
        pairwise: trace.pairwiseVerifications.map((verification) => ({
          candidateClosetItemId: verification.candidateClosetItemId,
          evaluation: verification.evaluation ?? 'verified',
          exclusionReason: verification.exclusionReason,
          verdict: verification.normalizedResult.verdict,
          confidence: verification.normalizedResult.confidence,
          downgradeReasons: verification.serverDowngradeReasons,
          requiredDifferentConfidence: verification.requiredDifferentConfidence,
          autoCreateVeto: verification.autoCreateVeto,
          referenceEvidenceType: verification.referenceEvidenceType,
          safeSameGateResult: verification.safeSameGateResult,
          safeSameRejectReasons: verification.safeSameRejectReasons,
        })),
        thresholds: trace.thresholds,
        finalDecision: trace.finalDecision,
        reasonCodes: trace.reasonCodes,
      }));
    }
    return {
      observationItemId: input.garment.observationItemId,
      status,
      matchedClosetItemId,
      appearanceFingerprint: fingerprint,
      confidence: clamp(confidence),
      candidateItemIds: candidates.map((candidate) => candidate.closetItemId),
      reasonCodes,
      decisionTrace: trace,
    };
  }
}

export function recallGarmentIdentityCandidates(
  input: GarmentIdentityInput,
  topK = 4,
): GarmentRecallResult {
  return recallFromCandidates(buildIdentityCandidates(input, {}), topK);
}

/** Metadata-only provider retained for deterministic policy fixtures. */
export class DeterministicGarmentIdentityProvider implements GarmentIdentityProvider {
  async resolve(input: GarmentIdentityInput): Promise<GarmentIdentityHypothesis> {
    const descriptor = descriptorFromObservation(input.garment);
    return hypothesis(
      input.garment.observationItemId,
      'new_to_closet',
      appearanceFingerprint(descriptor),
      Math.min(input.garment.confidence, 0.9),
      [],
      ['TEST_METADATA_PROVIDER'],
    );
  }
}

export function descriptorFromObservation(garment: WornGarmentObservation): GarmentAppearanceDescriptor {
  return {
    slot: canonicalizeGarmentSlot(garment.slot, garment.category),
    category: garment.category,
    dominantColor: canonicalizeColor(garment.dominantColor),
    secondaryColors: garment.secondaryColors.map(canonicalizeColor).filter((color) => color !== 'unknown').sort(),
    pattern: canonicalizePattern(garment.pattern),
    sleeve: canonicalizeSleeve(garment.sleeve),
    neckline: canonicalizeNeckline(garment.neckline),
    lengthClass: canonicalizeLengthClass(garment.lengthClass),
    materialClass: canonicalizeMaterialClass(garment.materialClass),
    silhouette: normalize(garment.silhouette),
    fit: canonicalizeFit(garment.fit),
    distinctiveFeatures: garment.distinctiveFeatures.map(normalize).filter(Boolean).sort(),
  };
}

export function appearanceFingerprint(descriptor: GarmentAppearanceDescriptor): string {
  return createHash('sha256').update(JSON.stringify(descriptor)).digest('hex').slice(0, 24);
}

interface CandidateRecord {
  item: ClosetItem;
  source: 'base' | 'user';
  descriptor: GarmentAppearanceDescriptor;
  metadataScore: number;
  continuityPrior: number;
  effectivePrior: number;
  categoryCompatibility: IdentityCategoryCompatibility;
  tier: IdentityCandidateTier;
  referenceEvidenceType: ReferenceEvidenceType;
  softContradictions: string[];
  referenceAppearances: GarmentImageAsset[];
  catalogFallbackImage?: GarmentImageAsset;
}

function buildIdentityCandidates(
  input: GarmentIdentityInput,
  options: {
    strongContinuityWindowMs?: number;
    weakContinuityWindowMs?: number;
    strongContinuityWeight?: number;
    weakContinuityWeight?: number;
  },
): GarmentIdentityCandidate[] {
  const observed = descriptorFromObservation(input.garment);
  const records = [
    ...input.userClosetItems
      .filter((entry) => entry.status === 'active' && entry.item.identityStatus !== 'merged')
      .map(({ item }) => candidateRecord(input, item, 'user', observed, options)),
    ...input.baseClosetItems.map((item) => candidateRecord(input, item, 'base', observed, options)),
  ].filter((record) => compatibleCategoryFamily(observed, record.descriptor));
  return records
    .sort((left, right) =>
      tierRank(left.tier) - tierRank(right.tier) ||
      right.effectivePrior - left.effectivePrior ||
      right.referenceAppearances.length - left.referenceAppearances.length ||
      left.item.id.localeCompare(right.item.id))
    .map((record) => ({
      closetItemId: record.item.id,
      source: record.source,
      metadataScore: record.metadataScore,
      continuityPrior: record.continuityPrior,
      effectivePrior: record.effectivePrior,
      tier: record.tier,
      categoryCompatibility: record.categoryCompatibility,
      referenceEvidenceType: record.referenceEvidenceType,
      softContradictions: record.softContradictions,
      descriptor: record.descriptor,
      referenceAppearanceAssetIds: record.referenceAppearances.map((asset) => asset.assetId),
      closetItem: record.item,
      referenceAppearances: record.referenceAppearances,
      catalogFallbackImage: record.catalogFallbackImage,
    }));
}

function recallFromCandidates(candidates: GarmentIdentityCandidate[], topK: number): GarmentRecallResult {
  const metadata = candidates.filter((candidate) => candidate.metadataScore >= 0.45).slice(0, topK);
  if (metadata.length) {
    return { candidates: metadata.map(recallCandidate), strategy: 'metadata', evidence: ['METADATA_RECALL_THRESHOLD_MET'] };
  }
  const visualFallback = candidates.filter((candidate) =>
    candidate.referenceAppearances.length > 0 || candidate.catalogFallbackImage).slice(0, topK);
  if (visualFallback.length) {
    return {
      candidates: visualFallback.map(recallCandidate),
      strategy: 'slot_category_fallback',
      evidence: ['METADATA_RECALL_MISS', 'COMPATIBLE_VISUAL_FALLBACK_AVAILABLE'],
    };
  }
  if (candidates.length) {
    return {
      candidates: candidates.slice(0, topK).map(recallCandidate),
      strategy: 'potential_match_without_visual_reference',
      evidence: ['METADATA_RECALL_MISS', 'COMPATIBLE_ITEMS_LACK_VISUAL_REFERENCE'],
    };
  }
  return { candidates: [], strategy: 'empty_compatible_closet', evidence: ['NO_COMPATIBLE_SLOT_OR_CATEGORY_FAMILY'] };
}

function candidatesForRecall(
  candidates: GarmentIdentityCandidate[],
  recall: GarmentRecallResult,
): GarmentIdentityCandidate[] {
  const ids = new Set(recall.candidates.map((candidate) => candidate.closetItemId));
  return candidates.filter((candidate) => ids.has(candidate.closetItemId));
}

function candidateRecord(
  input: GarmentIdentityInput,
  item: ClosetItem,
  source: CandidateRecord['source'],
  observed: GarmentAppearanceDescriptor,
  options: {
    strongContinuityWindowMs?: number;
    weakContinuityWindowMs?: number;
    strongContinuityWeight?: number;
    weakContinuityWeight?: number;
  },
): CandidateRecord {
  const descriptor = descriptorForItem(item, source === 'user' ? input.appearances : []);
  const appearanceIds = new Set(input.appearances
    .filter((appearance) => appearance.closetItemId === item.id)
    .map((appearance) => appearance.appearanceAssetId));
  const referenceAppearances = input.assets
    .filter((asset) => asset.role === 'garment_appearance' && appearanceIds.has(asset.assetId) && asset.verificationStatus !== 'failed')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 2);
  const categoryCompatibility = compareGarmentKinds(input.garment, item, descriptor);
  const metadataScore = scoreDescriptor(observed, descriptor);
  const continuityPrior = source === 'user'
    ? continuityPriorFor(input, item.id, categoryCompatibility, options)
    : 0;
  const effectivePrior = Math.min(1, metadataScore + continuityPrior);
  const tier: IdentityCandidateTier = categoryCompatibility === 'conflicting'
    ? 'fallback'
    : effectivePrior >= 0.8 ? 'strong' : 'plausible';
  const compatibility = attributeCompatibility(observed, descriptor);
  return {
    item,
    source,
    descriptor,
    metadataScore,
    continuityPrior,
    effectivePrior,
    categoryCompatibility,
    tier,
    referenceEvidenceType: referenceAppearances.length > 0 ? 'historical_appearance' : 'catalog_only',
    softContradictions: compatibility.softContradictions,
    referenceAppearances,
    catalogFallbackImage: source === 'base' ? input.baseCatalogAssets?.get(item.id) : undefined,
  };
}

function recallCandidate(candidate: GarmentIdentityCandidate): GarmentRecallCandidate {
  return {
    closetItemId: candidate.closetItemId,
    source: candidate.source,
    metadataScore: candidate.metadataScore,
    continuityPrior: candidate.continuityPrior,
    effectivePrior: candidate.effectivePrior,
    tier: candidate.tier,
    categoryCompatibility: candidate.categoryCompatibility,
    referenceEvidenceType: candidate.referenceEvidenceType,
    softContradictions: candidate.softContradictions,
    referenceAppearanceAssetIds: candidate.referenceAppearanceAssetIds,
    appearanceCount: candidate.referenceAppearances.length,
    hasCatalogFallbackImage: Boolean(candidate.catalogFallbackImage),
  };
}

function continuityPriorFor(
  input: GarmentIdentityInput,
  closetItemId: string,
  compatibility: IdentityCategoryCompatibility,
  options: {
    strongContinuityWindowMs?: number;
    weakContinuityWindowMs?: number;
    strongContinuityWeight?: number;
    weakContinuityWeight?: number;
  },
): number {
  if (compatibility === 'conflicting') return 0;
  const now = Date.parse(input.capturedAt ?? input.currentAppearances.at(-1)!.createdAt);
  if (!Number.isFinite(now)) return 0;
  const strongWindow = options.strongContinuityWindowMs ?? 60 * 60 * 1000;
  const weakWindow = options.weakContinuityWindowMs ?? 12 * 60 * 60 * 1000;
  const previousCapture = [...(input.captures ?? [])]
    .filter((capture) => Date.parse(capture.capturedAt) < now)
    .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))[0];
  if (previousCapture && now - Date.parse(previousCapture.capturedAt) <= strongWindow &&
      previousCapture.closetItemIds.includes(closetItemId)) {
    return options.strongContinuityWeight ?? 0.08;
  }
  const recentlyWorn = (input.wearEvents ?? []).some((event) =>
    event.closetItemId === closetItemId && now >= Date.parse(event.wornAt) && now - Date.parse(event.wornAt) <= weakWindow);
  return recentlyWorn ? options.weakContinuityWeight ?? 0.02 : 0;
}

function compareGarmentKinds(
  observed: WornGarmentObservation,
  item: ClosetItem,
  descriptor: GarmentAppearanceDescriptor,
): IdentityCategoryCompatibility {
  const observedKind = garmentKind([observed.description, observed.silhouette, ...observed.distinctiveFeatures].join(' '));
  const candidateKind = garmentKind([item.name, ...item.styleTags, descriptor.silhouette, ...descriptor.distinctiveFeatures].join(' '));
  if (observedKind && candidateKind) return observedKind === candidateKind ? 'exact' : 'conflicting';
  return observed.category === item.category ? 'compatible' : categoryFamily(observed.category) === categoryFamily(item.category)
    ? 'compatible'
    : 'conflicting';
}

function garmentKind(value: string): string | undefined {
  const normalized = normalize(value);
  if (/\bshorts\b|短裤/.test(normalized)) return 'shorts';
  if (/skirts?|半身裙|短裙|长裙/.test(normalized)) return 'skirt';
  if (/trousers?|pants?|jeans?|牛仔裤|长裤|西裤|休闲裤/.test(normalized)) return 'trousers';
  if (/dress|连衣裙/.test(normalized)) return 'dress';
  if (/jacket|coat|blazer|外套|夹克|西装/.test(normalized)) return 'outerwear';
  if (/shirt|t-?shirt|tee|衬衫|t恤|上衣/.test(normalized)) return 'top';
  if (/shoe|sneaker|loafer|boot|鞋|靴/.test(normalized)) return 'shoes';
  return undefined;
}

function tierRank(tier: IdentityCandidateTier): number {
  return tier === 'strong' ? 0 : tier === 'plausible' ? 1 : 2;
}

function compatibleCategoryFamily(observed: GarmentAppearanceDescriptor, candidate: GarmentAppearanceDescriptor): boolean {
  if (observed.slot === candidate.slot) return true;
  return categoryFamily(observed.category) === categoryFamily(candidate.category);
}

function categoryFamily(category: ClosetItem['category']): string {
  if (category === 'top' || category === 'outerwear') return 'upper_body';
  if (category === 'bottom') return 'lower_body';
  if (category === 'dress' || category === 'jumpsuit') return 'one_piece';
  return category;
}

function newIdentityConfidence(input: GarmentIdentityInput, evidenceConfidence: number, configuredCeiling = 0.9): number {
  return Math.max(0, Math.min(input.garment.confidence, evidenceConfidence, configuredCeiling, 0.99));
}

function descriptorForItem(item: ClosetItem, appearances: GarmentAppearance[]): GarmentAppearanceDescriptor {
  const latest = appearances.filter((appearance) => appearance.closetItemId === item.id)
    .sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))[0];
  if (latest) {
    return {
      ...latest.descriptor,
      slot: canonicalizeGarmentSlot(latest.descriptor.slot, latest.descriptor.category),
      dominantColor: canonicalizeColor(latest.descriptor.dominantColor),
      secondaryColors: latest.descriptor.secondaryColors.map(canonicalizeColor).filter((color) => color !== 'unknown').sort(),
      pattern: canonicalizePattern(latest.descriptor.pattern),
      fit: canonicalizeFit(latest.descriptor.fit),
      sleeve: canonicalizeSleeve(latest.descriptor.sleeve),
      neckline: canonicalizeNeckline(latest.descriptor.neckline),
      lengthClass: canonicalizeLengthClass(latest.descriptor.lengthClass),
      materialClass: canonicalizeMaterialClass(latest.descriptor.materialClass),
    };
  }
  const itemVocabulary = [item.name, item.fit, item.color, ...item.styleTags].join(' ');
  return {
    slot: canonicalizeGarmentSlot(item.category, item.category),
    category: item.category,
    dominantColor: canonicalizeColor(item.color),
    secondaryColors: [],
    pattern: canonicalizePattern(item.styleTags.find((tag) => /stripe|check|print|solid|条纹|格纹|印花|纯色/i.test(tag)) ?? 'other'),
    sleeve: canonicalizeSleeve(itemVocabulary),
    neckline: canonicalizeNeckline(itemVocabulary),
    lengthClass: canonicalizeLengthClass(itemVocabulary),
    materialClass: canonicalizeMaterialClass(itemVocabulary),
    silhouette: normalize(item.fit),
    fit: canonicalizeFit(item.fit),
    distinctiveFeatures: item.styleTags.map(normalize).filter(Boolean).sort(),
  };
}

function scoreDescriptor(left: GarmentAppearanceDescriptor, right: GarmentAppearanceDescriptor): number {
  if (left.category !== right.category || left.slot !== right.slot) return 0;
  let score = 0.35;
  score += 0.25 * colorSimilarity(left.dominantColor, right.dominantColor);
  if (left.pattern !== 'other' && left.pattern === right.pattern) score += 0.12;
  if (left.silhouette !== 'unknown' && left.silhouette === right.silhouette) score += 0.1;
  if (left.fit !== 'unknown' && right.fit !== 'unknown' && left.fit === right.fit) score += 0.08;
  score += intersectionRatio(left.distinctiveFeatures, right.distinctiveFeatures) * 0.1;
  if (canonicalizeSleeve(left.sleeve) !== 'unknown' && canonicalizeSleeve(left.sleeve) === canonicalizeSleeve(right.sleeve)) score += 0.08;
  if (canonicalizeNeckline(left.neckline) !== 'unknown' && canonicalizeNeckline(left.neckline) === canonicalizeNeckline(right.neckline)) score += 0.06;
  if (canonicalizeLengthClass(left.lengthClass) !== 'unknown' && canonicalizeLengthClass(left.lengthClass) === canonicalizeLengthClass(right.lengthClass)) score += 0.04;
  if (canonicalizeMaterialClass(left.materialClass) !== 'unknown' && canonicalizeMaterialClass(left.materialClass) === canonicalizeMaterialClass(right.materialClass)) score += 0.04;
  return Math.min(1, score);
}

function excludedVerificationRecord(
  candidate: GarmentIdentityCandidate,
  currentDescriptor: GarmentAppearanceDescriptor,
  exclusionReason: string,
): VerificationRecord {
  const verification: PairwiseGarmentVerification = {
    verdict: 'different',
    confidence: 1,
    currentColor: currentDescriptor.dominantColor,
    currentSleeve: currentDescriptor.sleeve ?? 'unknown',
    currentNeckline: currentDescriptor.neckline ?? 'unknown',
    featureComparisons: [],
    currentFrameEvidence: [],
    temporalEvidenceConsistency: 'insufficient',
    occlusions: [],
    jointlyVisibleEvidence: [],
    model: 'deterministic_attribute_exclusion',
  };
  return {
    candidate,
    evaluation: 'excluded',
    exclusionReason,
    raw: verification,
    normalized: verification,
    downgradeReasons: [exclusionReason],
    latencyMs: 0,
  };
}

function intersectionRatio(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  return left.filter((item) => rightSet.has(item)).length / Math.max(left.length, right.length);
}

function usableDescriptor(descriptor: GarmentAppearanceDescriptor): boolean {
  return descriptor.dominantColor !== 'unknown' && descriptor.silhouette !== 'unknown';
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 240);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function hypothesis(
  observationItemId: string,
  status: GarmentIdentityHypothesis['status'],
  appearanceFingerprintValue: string,
  confidence: number,
  candidateItemIds: string[],
  reasonCodes: string[],
): GarmentIdentityHypothesis {
  return {
    observationItemId,
    status,
    appearanceFingerprint: appearanceFingerprintValue,
    confidence: clamp(confidence),
    candidateItemIds,
    reasonCodes,
  };
}

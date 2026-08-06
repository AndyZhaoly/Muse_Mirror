import { createHash } from 'node:crypto';
import type {
  AmbientClosetItem,
  GarmentAppearance,
  GarmentAppearanceDescriptor,
  GarmentImageAsset,
  GarmentIdentityHypothesis,
  WornGarmentObservation,
} from '../domain/ambientCapture.js';
import type { ClosetItem } from '../types.js';
import type { GarmentVisualVerifier } from './garmentVisualVerifier.js';
import {
  canonicalizeColor,
  canonicalizeFit,
  canonicalizeGarmentSlot,
  canonicalizePattern,
  colorSimilarity,
} from './garmentVocabulary.js';

export interface GarmentIdentityInput {
  userId: string;
  garment: WornGarmentObservation;
  currentAppearance: GarmentImageAsset;
  baseClosetItems: ClosetItem[];
  userClosetItems: AmbientClosetItem[];
  appearances: GarmentAppearance[];
  assets: GarmentImageAsset[];
  baseCatalogAssets?: Map<string, GarmentImageAsset>;
}

export interface GarmentIdentityProvider {
  readonly ready?: boolean;
  resolve(input: GarmentIdentityInput): Promise<GarmentIdentityHypothesis>;
}

export interface GarmentRecallCandidate {
  closetItemId: string;
  source: 'base' | 'user';
  metadataScore: number;
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

export class VisualGarmentIdentityProvider implements GarmentIdentityProvider {
  readonly ready: boolean;

  constructor(
    private readonly options: {
      verifier: GarmentVisualVerifier;
      topK?: number;
      matchConfidence?: number;
      newConfidence?: number;
      newConfidenceCeiling?: number;
    },
  ) {
    this.ready = options.verifier.ready;
  }

  async resolve(input: GarmentIdentityInput): Promise<GarmentIdentityHypothesis> {
    const descriptor = descriptorFromObservation(input.garment);
    const fingerprint = appearanceFingerprint(descriptor);
    if (input.garment.confidence < 0.72 || !usableDescriptor(descriptor)) {
      return hypothesis(input.garment.observationItemId, 'insufficient_evidence', fingerprint, 0, [], [
        'LOW_GARMENT_EVIDENCE',
      ]);
    }

    const recall = recallGarmentIdentityCandidates(input, this.options.topK ?? 4);
    const recalledIds = recall.candidates.map((candidate) => candidate.closetItemId);
    if (recall.strategy === 'empty_compatible_closet') {
      return hypothesis(input.garment.observationItemId, 'new_to_closet', fingerprint, newIdentityConfidence(
        input,
        input.garment.confidence,
        this.options.newConfidenceCeiling,
      ), [], [
        'COMPATIBLE_CLOSET_TRULY_EMPTY',
        ...recall.evidence,
      ]);
    }
    if (recall.strategy === 'potential_match_without_visual_reference') {
      return hypothesis(input.garment.observationItemId, 'ambiguous', fingerprint, 0, recalledIds, [
        'NO_VISUAL_REFERENCE_FOR_POTENTIAL_MATCH',
        ...recall.evidence,
      ]);
    }
    if (!this.options.verifier.ready) {
      return hypothesis(input.garment.observationItemId, 'ambiguous', fingerprint, 0, recalledIds, [
        'REAL_VISUAL_VERIFIER_UNAVAILABLE',
        ...recall.evidence,
      ]);
    }
    const allItems = new Map([
      ...input.baseClosetItems.map((item) => [item.id, item] as const),
      ...input.userClosetItems.map((entry) => [entry.item.id, entry.item] as const),
    ]);
    const missingVisualReferences: string[] = [];
    const candidates = recall.candidates.flatMap((recalled) => {
      const closetItem = allItems.get(recalled.closetItemId);
      if (!closetItem) return [];
      const appearanceIds = new Set(input.appearances
        .filter((appearance) => appearance.closetItemId === recalled.closetItemId)
        .map((appearance) => appearance.appearanceAssetId));
      const appearanceAssets = input.assets
        .filter((asset) => asset.role === 'garment_appearance' && appearanceIds.has(asset.assetId))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const fallbackCatalogImage = recalled.source === 'base'
        ? input.baseCatalogAssets?.get(recalled.closetItemId)
        : undefined;
      if (!appearanceAssets.length && !fallbackCatalogImage) {
        missingVisualReferences.push(recalled.closetItemId);
        return [];
      }
      return [{ closetItem, appearanceAssets, fallbackCatalogImage }];
    });
    if (!candidates.length) {
      return hypothesis(input.garment.observationItemId, 'ambiguous', fingerprint, 0, recalledIds, [
        'NO_VISUAL_REFERENCE_FOR_POTENTIAL_MATCH',
        ...recall.evidence,
      ]);
    }
    const verification = await this.options.verifier.verify({
      currentAppearance: input.currentAppearance,
      candidates,
    });
    if (
      verification.result === 'same' &&
      verification.matchedClosetItemId &&
      recalledIds.includes(verification.matchedClosetItemId) &&
      verification.confidence >= (this.options.matchConfidence ?? 0.82)
    ) {
      return {
        ...hypothesis(input.garment.observationItemId, 'matched_existing', fingerprint, verification.confidence, recalledIds, [
          'REAL_VISUAL_APPEARANCE_MATCH',
          `RECALL_STRATEGY_${recall.strategy.toUpperCase()}`,
          ...verification.evidence,
        ]),
        matchedClosetItemId: verification.matchedClosetItemId,
      };
    }
    if (verification.result === 'different' && verification.confidence >= (this.options.newConfidence ?? 0.78)) {
      if (missingVisualReferences.length) {
        return hypothesis(input.garment.observationItemId, 'ambiguous', fingerprint, verification.confidence, recalledIds, [
          'NO_VISUAL_REFERENCE_FOR_POTENTIAL_MATCH',
          ...missingVisualReferences.map((itemId) => `MISSING_VISUAL_REFERENCE:${itemId}`),
        ]);
      }
      return hypothesis(input.garment.observationItemId, 'new_to_closet', fingerprint, newIdentityConfidence(
        input,
        verification.confidence,
        this.options.newConfidenceCeiling,
      ), recalledIds, [
        'REAL_VISUAL_CANDIDATES_DIFFERENT',
        `RECALL_STRATEGY_${recall.strategy.toUpperCase()}`,
        ...verification.mismatches,
      ]);
    }
    return hypothesis(input.garment.observationItemId, 'ambiguous', fingerprint, verification.confidence, recalledIds, [
      'REAL_VISUAL_IDENTITY_UNCERTAIN',
      `RECALL_STRATEGY_${recall.strategy.toUpperCase()}`,
      ...verification.mismatches,
    ]);
  }
}

export function recallGarmentIdentityCandidates(
  input: GarmentIdentityInput,
  topK = 4,
): GarmentRecallResult {
  const descriptor = descriptorFromObservation(input.garment);
  const records = [
    ...input.userClosetItems.map(({ item }) => candidateRecord(input, item, 'user', descriptor)),
    ...input.baseClosetItems.map((item) => candidateRecord(input, item, 'base', descriptor)),
  ].filter((record) => compatibleCategoryFamily(descriptor, record.descriptor));
  const ordered = records.sort((left, right) =>
    right.metadataScore - left.metadataScore ||
    right.appearanceCount - left.appearanceCount ||
    left.item.id.localeCompare(right.item.id),
  );
  const metadata = ordered.filter((record) => record.metadataScore >= 0.45).slice(0, topK);
  if (metadata.length) {
    return {
      candidates: metadata.map(recallCandidate),
      strategy: 'metadata',
      evidence: ['METADATA_RECALL_THRESHOLD_MET'],
    };
  }
  const visualFallback = ordered
    .filter((record) => record.appearanceCount > 0 || record.hasCatalogFallbackImage)
    .slice(0, topK);
  if (visualFallback.length) {
    return {
      candidates: visualFallback.map(recallCandidate),
      strategy: 'slot_category_fallback',
      evidence: ['METADATA_RECALL_MISS', 'COMPATIBLE_VISUAL_FALLBACK_AVAILABLE'],
    };
  }
  if (ordered.length) {
    return {
      candidates: ordered.slice(0, topK).map(recallCandidate),
      strategy: 'potential_match_without_visual_reference',
      evidence: ['METADATA_RECALL_MISS', 'COMPATIBLE_ITEMS_LACK_VISUAL_REFERENCE'],
    };
  }
  return {
    candidates: [],
    strategy: 'empty_compatible_closet',
    evidence: ['NO_COMPATIBLE_SLOT_OR_CATEGORY_FAMILY'],
  };
}

/** Metadata-only provider retained for policy fixtures; production capture never wires it. */
export class DeterministicGarmentIdentityProvider implements GarmentIdentityProvider {
  async resolve(input: GarmentIdentityInput): Promise<GarmentIdentityHypothesis> {
    const descriptor = descriptorFromObservation(input.garment);
    const fingerprint = appearanceFingerprint(descriptor);
    return hypothesis(
      input.garment.observationItemId,
      'new_to_closet',
      fingerprint,
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
  appearanceCount: number;
  hasCatalogFallbackImage: boolean;
}

function candidateRecord(
  input: GarmentIdentityInput,
  item: ClosetItem,
  source: CandidateRecord['source'],
  observed: GarmentAppearanceDescriptor,
): CandidateRecord {
  const descriptor = descriptorForItem(item, source === 'user' ? input.appearances : []);
  const appearanceIds = new Set(input.appearances
    .filter((appearance) => appearance.closetItemId === item.id)
    .map((appearance) => appearance.appearanceAssetId));
  const appearanceCount = input.assets.filter((asset) =>
    asset.role === 'garment_appearance' && appearanceIds.has(asset.assetId)
  ).length;
  return {
    item,
    source,
    descriptor,
    metadataScore: scoreDescriptor(observed, descriptor),
    appearanceCount,
    hasCatalogFallbackImage: source === 'base' && Boolean(input.baseCatalogAssets?.has(item.id)),
  };
}

function recallCandidate(record: CandidateRecord): GarmentRecallCandidate {
  return {
    closetItemId: record.item.id,
    source: record.source,
    metadataScore: record.metadataScore,
    appearanceCount: record.appearanceCount,
    hasCatalogFallbackImage: record.hasCatalogFallbackImage,
  };
}

function compatibleCategoryFamily(
  observed: GarmentAppearanceDescriptor,
  candidate: GarmentAppearanceDescriptor,
): boolean {
  if (observed.slot === candidate.slot) return true;
  return categoryFamily(observed.category) === categoryFamily(candidate.category);
}

function categoryFamily(category: ClosetItem['category']): string {
  if (category === 'top' || category === 'outerwear') return 'upper_body';
  if (category === 'bottom') return 'lower_body';
  if (category === 'dress' || category === 'jumpsuit') return 'one_piece';
  return category;
}

function newIdentityConfidence(
  input: GarmentIdentityInput,
  evidenceConfidence: number,
  configuredCeiling = 0.9,
): number {
  return Math.max(0, Math.min(input.garment.confidence, evidenceConfidence, configuredCeiling, 0.99));
}

function descriptorForItem(item: ClosetItem, appearances: GarmentAppearance[]): GarmentAppearanceDescriptor {
  const latest = appearances
    .filter((appearance) => appearance.closetItemId === item.id)
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
  if (latest) {
    return {
      ...latest.descriptor,
      slot: canonicalizeGarmentSlot(latest.descriptor.slot, latest.descriptor.category),
      dominantColor: canonicalizeColor(latest.descriptor.dominantColor),
      secondaryColors: latest.descriptor.secondaryColors.map(canonicalizeColor).filter((color) => color !== 'unknown').sort(),
      pattern: canonicalizePattern(latest.descriptor.pattern),
      fit: canonicalizeFit(latest.descriptor.fit),
    };
  }
  return {
    slot: canonicalizeGarmentSlot(item.category, item.category),
    category: item.category,
    dominantColor: canonicalizeColor(item.color),
    secondaryColors: [],
    pattern: canonicalizePattern(item.styleTags.find((tag) => /stripe|check|print|solid|条纹|格纹|印花|纯色/i.test(tag)) ?? 'other'),
    silhouette: normalize(item.fit),
    fit: canonicalizeFit(item.fit),
    distinctiveFeatures: item.styleTags.map(normalize).filter(Boolean).sort(),
  };
}

function scoreDescriptor(left: GarmentAppearanceDescriptor, right: GarmentAppearanceDescriptor): number {
  if (left.category !== right.category || left.slot !== right.slot) return 0;
  let score = 0.35;
  score += 0.25 * colorSimilarity(left.dominantColor, right.dominantColor);
  if (left.pattern === right.pattern) score += 0.12;
  if (left.silhouette === right.silhouette) score += 0.1;
  if (left.fit !== 'unknown' && right.fit !== 'unknown' && left.fit === right.fit) score += 0.08;
  const overlap = intersectionRatio(left.distinctiveFeatures, right.distinctiveFeatures);
  score += overlap * 0.1;
  return Math.min(1, score);
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
  return value.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
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
    confidence: Math.max(0, Math.min(1, confidence)),
    candidateItemIds,
    reasonCodes,
  };
}

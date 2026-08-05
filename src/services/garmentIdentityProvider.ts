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

export class VisualGarmentIdentityProvider implements GarmentIdentityProvider {
  readonly ready: boolean;

  constructor(
    private readonly options: {
      verifier: GarmentVisualVerifier;
      topK?: number;
      matchConfidence?: number;
      newConfidence?: number;
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

    const userScores = input.userClosetItems.map(({ item }) => ({
      itemId: item.id,
      score: scoreDescriptor(descriptor, descriptorForItem(item, input.appearances)),
      source: 'user' as const,
    }));
    const baseScores = input.baseClosetItems
      .filter((item) => item.category === descriptor.category)
      .map((item) => ({
        itemId: item.id,
        score: scoreDescriptor(descriptor, descriptorForItem(item, [])),
        source: 'base' as const,
      }));
    const scores = [...userScores, ...baseScores]
      .sort((a, b) => b.score - a.score || a.itemId.localeCompare(b.itemId));
    const recalled = scores.filter((item) => item.score >= 0.45).slice(0, this.options.topK ?? 4);
    if (!recalled.length) {
      return hypothesis(input.garment.observationItemId, 'new_to_closet', fingerprint, 1, [], [
        'NO_METADATA_RECALL_CANDIDATE',
      ]);
    }
    if (!this.options.verifier.ready) {
      return hypothesis(input.garment.observationItemId, 'ambiguous', fingerprint, 0, recalled.map((item) => item.itemId), [
        'REAL_VISUAL_VERIFIER_UNAVAILABLE',
      ]);
    }
    const allItems = new Map([
      ...input.baseClosetItems.map((item) => [item.id, item] as const),
      ...input.userClosetItems.map((entry) => [entry.item.id, entry.item] as const),
    ]);
    const candidates = recalled.flatMap(({ itemId, source }) => {
      const closetItem = allItems.get(itemId);
      if (!closetItem) return [];
      const appearanceIds = new Set(input.appearances.filter((appearance) => appearance.closetItemId === itemId).map((appearance) => appearance.appearanceAssetId));
      const appearanceAssets = input.assets
        .filter((asset) => asset.role === 'garment_appearance' && appearanceIds.has(asset.assetId))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const fallbackCatalogImage = source === 'base' ? input.baseCatalogAssets?.get(itemId) : undefined;
      if (!appearanceAssets.length && !fallbackCatalogImage) return [];
      return [{ closetItem, appearanceAssets, fallbackCatalogImage }];
    });
    if (!candidates.length) {
      return hypothesis(input.garment.observationItemId, 'new_to_closet', fingerprint, 1, recalled.map((item) => item.itemId), [
        'NO_REAL_VISUAL_REFERENCE_FOR_RECALLED_CANDIDATES',
      ]);
    }
    const verification = await this.options.verifier.verify({
      currentAppearance: input.currentAppearance,
      candidates,
    });
    if (
      verification.result === 'same' &&
      verification.matchedClosetItemId &&
      verification.confidence >= (this.options.matchConfidence ?? 0.82)
    ) {
      return {
        ...hypothesis(input.garment.observationItemId, 'matched_existing', fingerprint, verification.confidence, recalled.map((item) => item.itemId), [
          'REAL_VISUAL_APPEARANCE_MATCH',
          ...verification.evidence,
        ]),
        matchedClosetItemId: verification.matchedClosetItemId,
      };
    }
    if (verification.result === 'different' && verification.confidence >= (this.options.newConfidence ?? 0.78)) {
      return hypothesis(input.garment.observationItemId, 'new_to_closet', fingerprint, verification.confidence, recalled.map((item) => item.itemId), [
        'REAL_VISUAL_CANDIDATES_DIFFERENT',
        ...verification.mismatches,
      ]);
    }
    return hypothesis(input.garment.observationItemId, 'ambiguous', fingerprint, verification.confidence, recalled.map((item) => item.itemId), [
      'REAL_VISUAL_IDENTITY_UNCERTAIN',
      ...verification.mismatches,
    ]);
  }
}

/** Metadata-only provider retained for policy fixtures; production capture never wires it. */
export class DeterministicGarmentIdentityProvider implements GarmentIdentityProvider {
  async resolve(input: GarmentIdentityInput): Promise<GarmentIdentityHypothesis> {
    const descriptor = descriptorFromObservation(input.garment);
    const fingerprint = appearanceFingerprint(descriptor);
    return hypothesis(input.garment.observationItemId, 'new_to_closet', fingerprint, 1, [], ['TEST_METADATA_PROVIDER']);
  }
}

export function descriptorFromObservation(garment: WornGarmentObservation): GarmentAppearanceDescriptor {
  return {
    slot: garment.slot,
    category: garment.category,
    dominantColor: normalize(garment.dominantColor),
    secondaryColors: garment.secondaryColors.map(normalize).sort(),
    pattern: normalize(garment.pattern),
    silhouette: normalize(garment.silhouette),
    fit: normalize(garment.fit),
    distinctiveFeatures: garment.distinctiveFeatures.map(normalize).filter(Boolean).sort(),
  };
}

export function appearanceFingerprint(descriptor: GarmentAppearanceDescriptor): string {
  return createHash('sha256').update(JSON.stringify(descriptor)).digest('hex').slice(0, 24);
}

function descriptorForItem(item: ClosetItem, appearances: GarmentAppearance[]): GarmentAppearanceDescriptor {
  const latest = appearances
    .filter((appearance) => appearance.closetItemId === item.id)
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
  if (latest) return latest.descriptor;
  return {
    slot: item.category === 'jumpsuit' ? 'dress' : item.category,
    category: item.category,
    dominantColor: normalize(item.color),
    secondaryColors: [],
    pattern: normalize(item.styleTags.find((tag) => /stripe|check|print|solid|条纹|格纹|印花|纯色/i.test(tag)) ?? 'unknown'),
    silhouette: normalize(item.fit),
    fit: normalize(item.fit),
    distinctiveFeatures: item.styleTags.map(normalize).filter(Boolean).sort(),
  };
}

function scoreDescriptor(left: GarmentAppearanceDescriptor, right: GarmentAppearanceDescriptor): number {
  if (left.category !== right.category || left.slot !== right.slot) return 0;
  let score = 0.35;
  if (left.dominantColor === right.dominantColor) score += 0.25;
  if (left.pattern === right.pattern) score += 0.12;
  if (left.silhouette === right.silhouette) score += 0.1;
  if (left.fit === right.fit) score += 0.08;
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

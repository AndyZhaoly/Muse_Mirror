import { createHash } from 'node:crypto';
import type {
  AmbientClosetItem,
  GarmentAppearance,
  GarmentAppearanceDescriptor,
  GarmentIdentityHypothesis,
  WornGarmentObservation,
} from '../domain/ambientCapture.js';
import type { ClosetItem } from '../types.js';

export interface GarmentIdentityInput {
  userId: string;
  garment: WornGarmentObservation;
  baseClosetItems: ClosetItem[];
  userClosetItems: AmbientClosetItem[];
  appearances: GarmentAppearance[];
}

export interface GarmentIdentityProvider {
  resolve(input: GarmentIdentityInput): Promise<GarmentIdentityHypothesis>;
}

export class DeterministicGarmentIdentityProvider implements GarmentIdentityProvider {
  async resolve(input: GarmentIdentityInput): Promise<GarmentIdentityHypothesis> {
    const descriptor = descriptorFromObservation(input.garment);
    const fingerprint = appearanceFingerprint(descriptor);
    if (input.garment.confidence < 0.72 || !usableDescriptor(descriptor)) {
      return hypothesis(input.garment.observationItemId, 'insufficient_evidence', fingerprint, 0, [], [
        'LOW_GARMENT_EVIDENCE',
      ]);
    }

    const userScores = input.userClosetItems.map(({ item, appearanceFingerprint: storedFingerprint }) => ({
      itemId: item.id,
      score: storedFingerprint === fingerprint
        ? 1
        : scoreDescriptor(descriptor, descriptorForItem(item, input.appearances)),
      source: 'user' as const,
    }));
    const baseScores = input.baseClosetItems
      .filter((item) => item.category === descriptor.category)
      .map((item) => ({
        itemId: item.id,
        // Base catalog metadata has no captured appearance fingerprint. Keep it
        // useful for ambiguity detection without claiming a physical match.
        score: Math.min(0.74, scoreDescriptor(descriptor, descriptorForItem(item, []))),
        source: 'base' as const,
      }));
    const scores = [...userScores, ...baseScores]
      .sort((a, b) => b.score - a.score || a.itemId.localeCompare(b.itemId));
    const best = scores[0];
    const second = scores[1];

    if (best?.source === 'user' && best.score >= 0.82 && (!second || best.score - second.score >= 0.08)) {
      return {
        ...hypothesis(input.garment.observationItemId, 'matched_existing', fingerprint, best.score, scores.slice(0, 3).map((item) => item.itemId), [
          best.score === 1 ? 'EXACT_APPEARANCE_FINGERPRINT' : 'USER_APPEARANCE_MATCH',
        ]),
        matchedClosetItemId: best.itemId,
      };
    }

    if (best && best.score >= 0.68) {
      return hypothesis(input.garment.observationItemId, 'ambiguous', fingerprint, best.score, scores.slice(0, 3).map((item) => item.itemId), [
        best.source === 'base' ? 'BASE_CATALOG_SIMILAR_WITHOUT_USER_APPEARANCE' : 'MULTIPLE_SIMILAR_ITEMS',
      ]);
    }

    return hypothesis(input.garment.observationItemId, 'new_to_closet', fingerprint, 1 - (best?.score ?? 0), scores.slice(0, 3).map((item) => item.itemId), [
      'NO_RELIABLE_APPEARANCE_MATCH',
    ]);
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

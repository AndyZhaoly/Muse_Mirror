import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AmbientClosetItem,
  GarmentAppearance,
  GarmentImageAsset,
  GarmentVisualVerification,
  WornGarmentObservation,
} from '../src/domain/ambientCapture.js';
import {
  recallGarmentIdentityCandidates,
  VisualGarmentIdentityProvider,
  type GarmentIdentityInput,
} from '../src/services/garmentIdentityProvider.js';
import type { GarmentVisualVerifier } from '../src/services/garmentVisualVerifier.js';
import type { ClosetItem } from '../src/types.js';

test('a truly empty compatible closet can be new, but never with confidence 1', async () => {
  const provider = new VisualGarmentIdentityProvider({
    newConfidenceCeiling: 1,
    verifier: verifier({ result: 'different', confidence: 1, evidence: [], mismatches: ['no compatible item'] }),
  });
  const input = identityInput();
  input.garment.confidence = 1;
  const recall = recallGarmentIdentityCandidates(input);
  const result = await provider.resolve(input);

  assert.equal(recall.strategy, 'empty_compatible_closet');
  assert.equal(result.status, 'new_to_closet');
  assert.ok(result.confidence < 1);
  assert.ok(result.confidence <= input.garment.confidence);
});

test('a visual different decision is also capped below confidence 1', async () => {
  const existing = ambientItem('different-trousers', 'bottom', 'navy');
  const historical = appearance('different-appearance', existing.item.id);
  const result = await new VisualGarmentIdentityProvider({
    newConfidenceCeiling: 1,
    verifier: verifier({ result: 'different', confidence: 1, evidence: [], mismatches: ['different stitching'] }),
  }).resolve(identityInput({
    userClosetItems: [existing],
    appearances: [historical],
    assets: [asset(historical.appearanceAssetId, existing.item.id, 'garment_appearance')],
    garment: { ...driftedTrousers(), confidence: 1 },
  }));

  assert.equal(result.status, 'new_to_closet');
  assert.ok(result.confidence < 1);
});

test('metadata drift falls back to same-slot real appearances and can match visually', async () => {
  const existing = ambientItem('user-trousers', 'bottom', 'navy');
  const historical = appearance('historical-appearance', existing.item.id);
  const historicalAsset = asset(historical.appearanceAssetId, existing.item.id, 'garment_appearance');
  let receivedReferences: GarmentImageAsset[] = [];
  const provider = new VisualGarmentIdentityProvider({
    verifier: verifier({
      result: 'same', matchedClosetItemId: existing.item.id, confidence: 0.96,
      evidence: ['same real trousers'], mismatches: [],
    }, (input) => { receivedReferences = input.candidates.flatMap((candidate) => candidate.appearanceAssets); }),
  });
  const input = identityInput({
    userClosetItems: [existing], appearances: [historical], assets: [historicalAsset],
  });
  const recall = recallGarmentIdentityCandidates(input);
  const result = await provider.resolve(input);

  assert.equal(recall.strategy, 'slot_category_fallback');
  assert.equal(result.status, 'matched_existing');
  assert.equal(result.matchedClosetItemId, existing.item.id);
  assert.ok(result.reasonCodes.includes('RECALL_STRATEGY_SLOT_CATEGORY_FALLBACK'));
  assert.deepEqual(receivedReferences.map((reference) => reference.assetId), [historicalAsset.assetId]);
});

test('fallback verifier uncertainty remains ambiguous', async () => {
  const existing = ambientItem('uncertain-trousers', 'bottom', 'navy');
  const historical = appearance('uncertain-appearance', existing.item.id);
  const provider = new VisualGarmentIdentityProvider({
    verifier: verifier({ result: 'uncertain', confidence: 0.61, evidence: [], mismatches: ['lighting drift'] }),
  });
  const result = await provider.resolve(identityInput({
    userClosetItems: [existing],
    appearances: [historical],
    assets: [asset(historical.appearanceAssetId, existing.item.id, 'garment_appearance')],
  }));
  assert.equal(result.status, 'ambiguous');
});

test('a potential compatible item without any visual reference is ambiguous', async () => {
  const existing = ambientItem('no-reference-trousers', 'bottom', 'navy');
  const input = identityInput({ userClosetItems: [existing] });
  const recall = recallGarmentIdentityCandidates(input);
  const result = await new VisualGarmentIdentityProvider({
    verifier: verifier({ result: 'different', confidence: 0.99, evidence: [], mismatches: ['visual mismatch'] }),
  })
    .resolve(input);

  assert.equal(recall.strategy, 'potential_match_without_visual_reference');
  assert.equal(result.status, 'ambiguous');
  assert.ok(result.reasonCodes.includes('NO_VISUAL_REFERENCE_FOR_POTENTIAL_MATCH'));
});

test('an unavailable verifier cannot turn a metadata miss with a real appearance into new', async () => {
  const existing = ambientItem('unavailable-trousers', 'bottom', 'navy');
  const historical = appearance('unavailable-appearance', existing.item.id);
  const unavailable: GarmentVisualVerifier = {
    ready: false,
    async verify() { return { result: 'uncertain', confidence: 0, evidence: [], mismatches: ['disabled'] }; },
  };
  const result = await new VisualGarmentIdentityProvider({ verifier: unavailable }).resolve(identityInput({
    userClosetItems: [existing],
    appearances: [historical],
    assets: [asset(historical.appearanceAssetId, existing.item.id, 'garment_appearance')],
  }));
  assert.equal(result.status, 'ambiguous');
  assert.ok(result.reasonCodes.includes('REAL_VISUAL_VERIFIER_UNAVAILABLE'));
});

test('a base closet catalog image participates in visual verification', async () => {
  const baseItem = closetItem('base-trousers', 'bottom', 'navy');
  const catalog = asset('base-catalog', baseItem.id, 'canonical_product');
  let called = false;
  const provider = new VisualGarmentIdentityProvider({
    verifier: verifier({
      result: 'same', matchedClosetItemId: baseItem.id, confidence: 0.95,
      evidence: ['catalog match'], mismatches: [],
    }, (input) => {
      called = true;
      assert.equal(input.candidates[0]?.fallbackCatalogImage?.assetId, catalog.assetId);
    }),
  });
  const result = await provider.resolve(identityInput({
    baseClosetItems: [baseItem], baseCatalogAssets: new Map([[baseItem.id, catalog]]),
  }));
  assert.equal(called, true);
  assert.equal(result.status, 'matched_existing');
});

test('a base closet potential match with a missing image is not declared new', async () => {
  const baseItem = closetItem('base-missing-image', 'bottom', 'navy');
  const result = await new VisualGarmentIdentityProvider({
    verifier: verifier({ result: 'different', confidence: 0.99, evidence: [], mismatches: ['visual mismatch'] }),
  })
    .resolve(identityInput({ baseClosetItems: [baseItem] }));
  assert.equal(result.status, 'ambiguous');
  assert.ok(result.reasonCodes.includes('NO_VISUAL_REFERENCE_FOR_POTENTIAL_MATCH'));
});

test('a closet containing only a different category family can still resolve a new item safely', async () => {
  const unrelatedTop = ambientItem('unrelated-top', 'top', 'navy');
  const input = identityInput({ userClosetItems: [unrelatedTop] });
  const recall = recallGarmentIdentityCandidates(input);
  const result = await new VisualGarmentIdentityProvider({
    verifier: verifier({ result: 'different', confidence: 0.99, evidence: [], mismatches: ['different category'] }),
  }).resolve(input);

  assert.equal(recall.strategy, 'empty_compatible_closet');
  assert.equal(result.status, 'new_to_closet');
  assert.ok(result.confidence < 1);
});

function identityInput(overrides: Partial<GarmentIdentityInput> = {}): GarmentIdentityInput {
  return {
    userId: 'identity-test-user',
    garment: driftedTrousers(),
    currentAppearance: asset('current-appearance', undefined, 'garment_appearance'),
    baseClosetItems: [], userClosetItems: [], appearances: [], assets: [],
    ...overrides,
  };
}

function driftedTrousers(): WornGarmentObservation {
  return {
    observationItemId: 'observed-faded-olive-pants', slot: 'bottom', category: 'bottom',
    description: 'faded olive relaxed pants', dominantColor: 'faded olive', secondaryColors: [],
    pattern: 'twill', silhouette: 'straight-leg', fit: 'relaxed',
    distinctiveFeatures: ['soft drape', 'straight leg'],
    boundingBox: { x: 0.25, y: 0.48, width: 0.5, height: 0.48 },
    confidence: 0.94, uncertainties: [],
  };
}

function ambientItem(id: string, category: ClosetItem['category'], color: string): AmbientClosetItem {
  return {
    item: {
      ...closetItem(id, category, color), source: 'mirror_auto_capture',
      identityStatus: 'provisional', ownershipStatus: 'unverified', imageStatus: 'ready',
      appearanceAssetIds: [],
    },
    status: 'active', source: 'ambient_capture', appearanceFingerprint: `${id}-fingerprint`,
    createdAt: '2026-08-05T00:00:00.000Z', updatedAt: '2026-08-05T00:00:00.000Z',
  };
}

function closetItem(id: string, category: ClosetItem['category'], color: string): ClosetItem {
  return {
    id, name: id, category, color, fit: 'regular', formality: 'casual',
    styleTags: ['solid', 'straight'], imageUrl: `/catalog/${id}.jpg`, marketedFor: 'unisex',
  };
}

function appearance(assetId: string, closetItemId: string): GarmentAppearance {
  return {
    appearanceId: `appearance-${assetId}`, userId: 'identity-test-user', closetItemId,
    observationId: 'historical-observation', captureId: 'historical-capture',
    descriptor: {
      slot: 'bottom', category: 'bottom', dominantColor: 'navy', secondaryColors: [],
      pattern: 'solid', silhouette: 'straight', fit: 'regular', distinctiveFeatures: ['clean crease'],
    },
    appearanceFingerprint: 'historical-fingerprint', appearanceAssetId: assetId,
    boundingBox: { x: 0.25, y: 0.48, width: 0.5, height: 0.48 },
    confidence: 0.96, capturedAt: '2026-08-05T00:00:00.000Z',
  };
}

function asset(
  assetId: string,
  closetItemId: string | undefined,
  role: GarmentImageAsset['role'],
): GarmentImageAsset {
  return {
    assetId, ownerUserId: 'identity-test-user', role, imageUrl: `/assets/${assetId}`,
    closetItemId, width: 512, height: 512, mimeType: 'image/jpeg',
    verificationStatus: role === 'canonical_product' ? 'passed' : 'not_required',
    contentHash: `${assetId}-hash`, createdAt: '2026-08-05T00:00:00.000Z',
  };
}

function verifier(
  result: GarmentVisualVerification,
  inspect?: (input: Parameters<GarmentVisualVerifier['verify']>[0]) => void,
): GarmentVisualVerifier {
  return { ready: true, async verify(input) { inspect?.(input); return result; } };
}

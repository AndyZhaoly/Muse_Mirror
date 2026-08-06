import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AmbientClosetItem,
  GarmentAppearance,
  GarmentImageAsset,
  OutfitCapture,
  PairwiseGarmentVerification,
  WearEvent,
  WornGarmentObservation,
} from '../src/domain/ambientCapture.js';
import {
  recallGarmentIdentityCandidates,
  VisualGarmentIdentityProvider,
  type GarmentIdentityInput,
} from '../src/services/garmentIdentityProvider.js';
import type { GarmentPairwiseVerifier } from '../src/services/garmentVisualVerifier.js';
import type { ClosetItem } from '../src/types.js';

test('a truly empty compatible closet can be new, but never with confidence 1', async () => {
  const input = identityInput();
  input.garment.confidence = 1;
  const result = await provider(verifier({})).resolve(input);
  assert.equal(recallGarmentIdentityCandidates(input).strategy, 'empty_compatible_closet');
  assert.equal(result.status, 'new_to_closet');
  assert.ok(result.confidence < 1);
});

test('distractor skirts cannot change a strong shorts pairwise match', async () => {
  const shorts = ambientItem('old-shorts', 'Light gray knee shorts', 'light gray');
  const distractors = [
    ambientItem('skirt-a', 'Dark gray midi skirt', 'dark gray'),
    ambientItem('skirt-b', 'Black pleated skirt', 'black'),
    ambientItem('skirt-c', 'Gray pencil skirt', 'gray'),
  ];
  const calls: string[] = [];
  const input = withAppearances(identityInput({ userClosetItems: [shorts, ...distractors] }), [shorts, ...distractors]);
  const result = await provider(verifier({
    'old-shorts': verification('same', 0.95, [feature('pocket', 'same', 'medium')]),
  }, calls)).resolve(input);
  assert.equal(result.status, 'matched_existing');
  assert.equal(result.matchedClosetItemId, 'old-shorts');
  assert.deepEqual(calls, ['old-shorts']);
  assert.ok(result.decisionTrace?.recall.candidates.filter((candidate) => candidate.closetItemId.startsWith('skirt-'))
    .every((candidate) => candidate.tier === 'fallback'));
});

test('occluded drawstring and weak length differences are normalized to uncertain', async () => {
  const shorts = ambientItem('old-shorts', 'Light gray knee shorts', 'light gray');
  const result = await provider(verifier({
    'old-shorts': verification('different', 0.96, [
      feature('drawstring', 'different', 'strong', 'not_visible', 'visible'),
      feature('length', 'different', 'strong'),
      feature('silhouette', 'different', 'medium'),
    ]),
  })).resolve(withAppearances(identityInput({ userClosetItems: [shorts] }), [shorts]));
  assert.equal(result.status, 'ambiguous');
  const pairwise = result.decisionTrace?.pairwiseVerifications[0];
  assert.equal(pairwise?.normalizedResult.verdict, 'uncertain');
  assert.ok(pairwise?.serverDowngradeReasons.includes('NON_JOINT_VISIBILITY:drawstring'));
  assert.ok(pairwise?.serverDowngradeReasons.includes('WEAK_ONLY_FEATURE:length'));
});

test('strong prior veto blocks silent creation even with a safe visual difference', async () => {
  const shorts = ambientItem('old-shorts', 'Light gray knee shorts', 'light gray');
  const result = await provider(verifier({
    'old-shorts': verification('different', 0.99, [feature('pocket', 'different', 'strong')]),
  })).resolve(withAppearances(identityInput({ userClosetItems: [shorts] }), [shorts]));
  assert.equal(result.status, 'ambiguous');
  assert.ok(result.reasonCodes.includes('STRONG_PRIOR_AUTO_CREATE_VETO'));
});

test('all plausible candidates safely different may create a genuinely new garment', async () => {
  const old = ambientItem('old-bottom', 'Old light gray shorts', 'light gray');
  const input = withAppearances(identityInput({
    userClosetItems: [old],
    garment: { ...shortsObservation(), dominantColor: 'khaki', pattern: 'checked', fit: 'slim', silhouette: 'tailored' },
  }), [old]);
  const result = await provider(verifier({
    'old-bottom': verification('different', 0.94, [
      feature('pocket', 'different', 'strong'),
      feature('hem', 'different', 'medium'),
      feature('pattern', 'different', 'strong'),
    ]),
  })).resolve(input);
  assert.equal(result.status, 'new_to_closet');
  assert.ok(result.confidence < 1);
});

test('generic color and silhouette similarity is not enough for a safe match', async () => {
  const shorts = ambientItem('generic-shorts', 'Light gray shorts', 'light gray');
  const result = await provider(verifier({
    'generic-shorts': verification('same', 0.91, [
      feature('color', 'same', 'medium'),
      feature('silhouette', 'same', 'strong'),
    ]),
  })).resolve(withAppearances(identityInput({ userClosetItems: [shorts] }), [shorts]));
  assert.equal(result.status, 'ambiguous');
});

test('multiple safe matches remain ambiguous instead of choosing top one', async () => {
  const first = ambientItem('shorts-a', 'Light gray knee shorts', 'light gray');
  const second = ambientItem('shorts-b', 'Light gray knee shorts', 'light gray');
  const result = await provider(verifier({
    'shorts-a': verification('same', 0.95, [feature('pocket', 'same', 'strong')]),
    'shorts-b': verification('same', 0.94, [feature('waistband', 'same', 'strong')]),
  })).resolve(withAppearances(identityInput({ userClosetItems: [first, second] }), [first, second]));
  assert.equal(result.status, 'ambiguous');
  assert.ok(result.reasonCodes.includes('MULTIPLE_SAFE_MATCHES'));
});

test('immediately previous same-slot wear contributes continuity without deciding a match', async () => {
  const shorts = ambientItem('recent-shorts', 'Light gray knee shorts', 'light gray');
  const previousCapture = capture('recent-shorts', '2026-08-06T20:43:00.000Z');
  const input = withAppearances(identityInput({
    capturedAt: '2026-08-06T20:46:00.000Z',
    userClosetItems: [shorts],
    captures: [previousCapture],
    wearEvents: [wear('recent-shorts', previousCapture)],
  }), [shorts]);
  const result = await provider(verifier({
    'recent-shorts': verification('uncertain', 0.5, []),
  })).resolve(input);
  assert.equal(result.status, 'ambiguous');
  const candidate = result.decisionTrace?.recall.candidates[0];
  assert.equal(candidate?.continuityPrior, 0.08);
  assert.equal(candidate?.effectivePrior, Math.min(1, (candidate?.metadataScore ?? 0) + 0.08));
});

test('candidate input order does not change ranking or final result', async () => {
  const first = ambientItem('a-shorts', 'Light gray knee shorts', 'light gray');
  const second = ambientItem('b-shorts', 'Navy knee shorts', 'navy');
  const responses = {
    'a-shorts': verification('same', 0.95, [feature('pocket', 'same', 'strong')]),
    'b-shorts': verification('different', 0.94, [feature('pattern', 'different', 'strong')]),
  };
  const left = await provider(verifier(responses)).resolve(withAppearances(identityInput({ userClosetItems: [first, second] }), [first, second]));
  const right = await provider(verifier(responses)).resolve(withAppearances(identityInput({ userClosetItems: [second, first] }), [second, first]));
  assert.equal(left.status, right.status);
  assert.equal(left.matchedClosetItemId, right.matchedClosetItemId);
  assert.deepEqual(left.candidateItemIds, right.candidateItemIds);
});

test('a compatible item without visual references is ambiguous', async () => {
  const shorts = ambientItem('no-reference', 'Light gray knee shorts', 'light gray');
  const result = await provider(verifier({})).resolve(identityInput({ userClosetItems: [shorts] }));
  assert.equal(result.status, 'ambiguous');
  assert.ok(result.reasonCodes.includes('NO_VISUAL_REFERENCE_FOR_POTENTIAL_MATCH'));
});

function provider(pairVerifier: GarmentPairwiseVerifier): VisualGarmentIdentityProvider {
  return new VisualGarmentIdentityProvider({
    verifier: pairVerifier,
    matchConfidence: 0.88,
    baseNewConfidence: 0.78,
    strongPriorVeto: 0.85,
  });
}

function verifier(
  results: Record<string, PairwiseGarmentVerification>,
  calls: string[] = [],
): GarmentPairwiseVerifier {
  return {
    ready: true,
    async verifyPair(input) {
      calls.push(input.candidate.closetItem.id);
      assert.ok(input.candidate.referenceAppearances.length <= 2);
      return results[input.candidate.closetItem.id] ?? verification('uncertain', 0, []);
    },
  };
}

function verification(
  verdict: PairwiseGarmentVerification['verdict'],
  confidence: number,
  featureComparisons: PairwiseGarmentVerification['featureComparisons'],
): PairwiseGarmentVerification {
  return { verdict, confidence, featureComparisons, occlusions: [], jointlyVisibleEvidence: [], model: 'fixture-model' };
}

function feature(
  name: PairwiseGarmentVerification['featureComparisons'][number]['feature'],
  relation: PairwiseGarmentVerification['featureComparisons'][number]['relation'],
  strength: PairwiseGarmentVerification['featureComparisons'][number]['discriminativeStrength'],
  currentVisibility: PairwiseGarmentVerification['featureComparisons'][number]['currentVisibility'] = 'visible',
  referenceVisibility: PairwiseGarmentVerification['featureComparisons'][number]['referenceVisibility'] = 'visible',
): PairwiseGarmentVerification['featureComparisons'][number] {
  return { feature: name, relation, discriminativeStrength: strength, currentVisibility, referenceVisibility, note: `${name} fixture` };
}

function identityInput(overrides: Partial<GarmentIdentityInput> = {}): GarmentIdentityInput {
  return {
    userId: 'identity-test-user',
    episodeId: 'episode-test',
    capturedAt: '2026-08-06T20:46:00.000Z',
    garment: shortsObservation(),
    currentAppearance: asset('current-appearance'),
    baseClosetItems: [], userClosetItems: [], appearances: [], assets: [], captures: [], wearEvents: [],
    ...overrides,
  };
}

function shortsObservation(): WornGarmentObservation {
  return {
    observationItemId: 'observed-gray-shorts', slot: 'bottom', category: 'bottom',
    description: 'light gray knee shorts', dominantColor: 'light gray', secondaryColors: [],
    pattern: 'solid', silhouette: 'straight', fit: 'regular', distinctiveFeatures: [],
    boundingBox: { x: 0.25, y: 0.48, width: 0.5, height: 0.48 }, confidence: 0.94, uncertainties: [],
  };
}

function ambientItem(id: string, name: string, color: string): AmbientClosetItem {
  return {
    item: {
      id, name, category: 'bottom', color, fit: 'regular', formality: 'casual',
      styleTags: ['solid', name], imageUrl: `/catalog/${id}.jpg`, source: 'mirror_auto_capture',
      identityStatus: 'provisional', ownershipStatus: 'unverified', imageStatus: 'ready',
    },
    status: 'active', source: 'ambient_capture', appearanceFingerprint: `${id}-fingerprint`,
    createdAt: '2026-08-06T20:43:00.000Z', updatedAt: '2026-08-06T20:43:00.000Z',
  };
}

function withAppearances(input: GarmentIdentityInput, items: AmbientClosetItem[]): GarmentIdentityInput {
  const appearances = items.map((item, index) => appearance(item.item.id, `reference-${index}`));
  return {
    ...input,
    appearances,
    assets: appearances.map((item) => asset(item.appearanceAssetId, item.closetItemId)),
  };
}

function appearance(closetItemId: string, assetId: string): GarmentAppearance {
  return {
    appearanceId: `appearance-${assetId}`, userId: 'identity-test-user', closetItemId,
    observationId: 'historical-observation', captureId: 'historical-capture',
    descriptor: {
      slot: 'bottom', category: 'bottom', dominantColor: closetItemId.includes('navy') ? 'navy' : 'light gray',
      secondaryColors: [], pattern: 'solid', silhouette: 'straight', fit: 'regular', distinctiveFeatures: [],
    },
    appearanceFingerprint: 'historical-fingerprint', appearanceAssetId: assetId,
    boundingBox: { x: 0.25, y: 0.48, width: 0.5, height: 0.48 }, confidence: 0.96,
    capturedAt: '2026-08-06T20:43:00.000Z',
  };
}

function asset(assetId: string, closetItemId?: string): GarmentImageAsset {
  return {
    assetId, ownerUserId: 'identity-test-user', role: 'garment_appearance', imageUrl: `/assets/${assetId}`,
    closetItemId, width: 512, height: 512, mimeType: 'image/jpeg', verificationStatus: 'not_required',
    contentHash: `${assetId}-hash`, createdAt: '2026-08-06T20:43:00.000Z',
  };
}

function capture(closetItemId: string, capturedAt: string): OutfitCapture {
  return {
    captureId: 'capture-previous', userId: 'identity-test-user', sessionId: 'session', episodeId: 'episode-previous',
    observationId: 'observation-previous', closetItemIds: [closetItemId], outfitSignature: 'signature',
    repeatedOutfit: false, evidenceImageUrl: '/capture.jpg', capturedAt, committedAt: capturedAt,
  };
}

function wear(closetItemId: string, source: OutfitCapture): WearEvent {
  return {
    wearEventId: 'wear-previous', userId: source.userId, closetItemId, captureId: source.captureId,
    episodeId: source.episodeId, wornAt: source.capturedAt,
  };
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AmbientClosetItem, UserWardrobeState } from '../src/domain/ambientCapture.js';
import { JsonUserWardrobeRepository } from '../src/services/userWardrobeRepository.js';

test('closet item merge atomically migrates references, preserves history, and is idempotent', async () => {
  const fixture = await repositoryFixture();
  const preview = await fixture.repository.previewClosetItemMerge({
    userId: 'user-a', canonicalItemId: 'shorts-first', duplicateItemId: 'shorts-duplicate',
  });
  assert.equal(preview.status, 'ready');
  assert.deepEqual(preview.migrations, {
    appearances: 1, assets: 2, wearEvents: 1, outfitCaptures: 1, productImageJobs: 1,
    completionSummaries: 1, wardrobeEvents: 1, identityDecisionTraces: 1,
  });
  assert.equal(preview.primaryImageWillChange, true);

  const [first, second] = await Promise.all([
    fixture.repository.mergeClosetItems({ userId: 'user-a', canonicalItemId: 'shorts-first', duplicateItemId: 'shorts-duplicate' }),
    fixture.repository.mergeClosetItems({ userId: 'user-a', canonicalItemId: 'shorts-first', duplicateItemId: 'shorts-duplicate' }),
  ]);
  assert.deepEqual(new Set([first.status, second.status]), new Set(['merged', 'already_merged']));

  const reloaded = new JsonUserWardrobeRepository(fixture.filePath);
  const state = await reloaded.getState('user-a');
  const canonical = state.closetItems.find((entry) => entry.item.id === 'shorts-first')!;
  const duplicate = state.closetItems.find((entry) => entry.item.id === 'shorts-duplicate')!;
  assert.equal(canonical.status, 'active');
  assert.equal(canonical.item.identityStatus, 'provisional');
  assert.equal(canonical.item.ownershipStatus, 'unverified');
  assert.equal(canonical.item.primaryImageAssetId, 'duplicate-product');
  assert.equal(canonical.item.imageUrl, '/assets/duplicate-product');
  assert.deepEqual(new Set(canonical.item.appearanceAssetIds), new Set(['canonical-appearance', 'duplicate-appearance']));
  assert.equal(duplicate.status, 'archived');
  assert.equal(duplicate.item.identityStatus, 'merged');
  assert.equal(duplicate.mergedIntoItemId, 'shorts-first');
  assert.equal(state.closetItemAliases['shorts-duplicate'], 'shorts-first');
  assert.equal(await reloaded.resolveClosetItemId('user-a', 'shorts-duplicate'), 'shorts-first');
  assert.ok(state.appearances.every((appearance) => appearance.closetItemId === 'shorts-first'));
  assert.ok(state.assets.every((asset) => asset.closetItemId === 'shorts-first'));
  assert.ok(state.wearEvents.every((event) => event.closetItemId === 'shorts-first'));
  assert.ok(state.productImageJobs.every((job) => job.closetItemId === 'shorts-first'));
  assert.ok(state.captures.every((capture) => capture.closetItemIds.includes('shorts-first') && !capture.closetItemIds.includes('shorts-duplicate')));
  assert.equal(state.captures[1]?.outfitSignature, signature(['top-a', 'shorts-first']));
  assert.deepEqual(state.pendingCompletionEvent?.newItemIds, ['shorts-first']);
  assert.deepEqual(state.pendingCompletionEvent?.itemSummaries.map((summary) => summary.closetItemId), ['shorts-first']);
  assert.equal(state.identityDecisionTraces[0]?.matchedClosetItemId, 'shorts-first');
  assert.equal(state.identityDecisionTraces[0]?.recall.candidates[0]?.closetItemId, 'shorts-first');
  assert.equal(state.events.filter((event) => event.type === 'closet_items_merged').length, 1);
});

test('merge validation blocks same IDs, cross-user IDs, and base fixtures', async () => {
  const fixture = await repositoryFixture();
  assert.equal((await fixture.repository.previewClosetItemMerge({
    userId: 'user-a', canonicalItemId: 'shorts-first', duplicateItemId: 'shorts-first',
  })).blocker, 'CLOSET_ITEM_MERGE_IDS_MUST_DIFFER');
  assert.equal((await fixture.repository.previewClosetItemMerge({
    userId: 'user-a', canonicalItemId: 'shorts-first', duplicateItemId: 'user-b-item',
  })).blocker, 'CLOSET_ITEM_NOT_FOUND_FOR_USER');
  assert.equal((await fixture.repository.previewClosetItemMerge({
    userId: 'user-a', canonicalItemId: 'shorts-first', duplicateItemId: 'base-like-item',
  })).blocker, 'BASE_CLOSET_ITEMS_CANNOT_BE_MERGED');
  await assert.rejects(() => fixture.repository.mergeClosetItems({
    userId: 'user-a', canonicalItemId: 'shorts-first', duplicateItemId: 'user-b-item',
  }), /CLOSET_ITEM_NOT_FOUND_FOR_USER/);
  assert.equal((await fixture.repository.getState('user-b')).closetItems[0]?.item.id, 'user-b-item');
});

test('resolving persisted pending identity migrates capture refs and creates one wear event', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-pending-identity-'));
  const filePath = path.join(directory, 'wardrobe.json');
  const state = userState('user-a');
  state.captures = [capture('capture-pending', ['top-a'])];
  state.captures[0]!.items = [
    { type: 'closet_item', closetItemId: 'top-a', slot: 'top' },
    { type: 'pending_identity', resolutionId: 'pending-shorts', slot: 'bottom' },
  ];
  state.captures[0]!.outfitSignature = 'closet:top-a|pending:pending-shorts';
  state.wearEvents = [];
  state.pendingIdentityResolutions = [{
    resolutionId: 'pending-shorts', userId: 'user-a', episodeId: 'episode-capture-pending',
    trackId: 'track-bottom', observationItemId: 'observation-bottom', slot: 'bottom', category: 'bottom',
    lockedDescriptor: {
      slot: 'bottom', category: 'bottom', dominantColor: 'light gray', secondaryColors: [],
      pattern: 'solid', silhouette: 'straight', fit: 'regular', distinctiveFeatures: ['shorts'],
    },
    currentEvidenceAssetIds: ['pending-crop'], evidenceSignatures: [],
    candidateClosetItemIds: ['shorts-first'],
    candidateHistoryClosetItemIds: ['shorts-first'],
    candidateSummaries: [{
      closetItemId: 'shorts-first', label: 'Light gray shorts', imageUrl: '/assets/canonical-appearance',
      priorRank: 1, identityReasonCodes: ['INSUFFICIENT_INSTANCE_EVIDENCE'],
    }],
    ambiguityReasonCodes: ['INSUFFICIENT_INSTANCE_EVIDENCE'],
    occludedFeatures: ['waistband_construction'], automaticRecheckCount: 1, state: 'ready_to_ask',
    createdAt: '2026-08-06T20:46:00.000Z', updatedAt: '2026-08-06T20:46:00.000Z',
  }];
  await fs.writeFile(filePath, `${JSON.stringify({ schemaVersion: 1, users: { 'user-a': state } }, null, 2)}\n`);

  const repository = new JsonUserWardrobeRepository(filePath);
  const resolution = {
    userId: 'user-a', resolutionId: 'pending-shorts', closetItemId: 'shorts-first',
    state: 'resolved_existing' as const,
  };
  await repository.resolvePendingIdentity({ ...resolution, occurredAt: '2026-08-06T20:47:00.000Z' });
  await repository.resolvePendingIdentity({ ...resolution, occurredAt: '2026-08-06T20:48:00.000Z' });

  const reloaded = await new JsonUserWardrobeRepository(filePath).getState('user-a');
  assert.equal(reloaded.pendingIdentityResolutions[0]?.state, 'resolved_existing');
  assert.deepEqual(reloaded.captures[0]?.items, [
    { type: 'closet_item', closetItemId: 'top-a', slot: 'top' },
    { type: 'closet_item', closetItemId: 'shorts-first', slot: 'bottom' },
  ]);
  assert.deepEqual(reloaded.captures[0]?.closetItemIds, ['top-a', 'shorts-first']);
  assert.equal(reloaded.captures[0]?.outfitSignature, signature(['shorts-first', 'top-a']));
  assert.equal(reloaded.wearEvents.filter((event) => event.closetItemId === 'shorts-first').length, 1);
});

async function repositoryFixture(): Promise<{ repository: JsonUserWardrobeRepository; filePath: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-closet-merge-'));
  const filePath = path.join(directory, 'wardrobe.json');
  const state = userState('user-a');
  const userB = userState('user-b');
  userB.closetItems = [ambientItem('user-b-item', 'mirror_auto_capture', 'ready')];
  await fs.writeFile(filePath, `${JSON.stringify({ schemaVersion: 1, users: { 'user-a': state, 'user-b': userB } }, null, 2)}\n`);
  return { repository: new JsonUserWardrobeRepository(filePath), filePath };
}

function userState(userId: string): UserWardrobeState {
  const canonical = ambientItem('shorts-first', 'mirror_auto_capture', 'needs_review');
  canonical.item.appearanceAssetIds = ['canonical-appearance'];
  const duplicate = ambientItem('shorts-duplicate', 'mirror_auto_capture', 'ready');
  duplicate.item.appearanceAssetIds = ['duplicate-appearance'];
  duplicate.item.primaryImageAssetId = 'duplicate-product';
  duplicate.item.imageUrl = '/assets/duplicate-product';
  const baseLike = ambientItem('base-like-item', 'demo_fixture', 'ready');
  return {
    schemaVersion: 1,
    userId,
    version: 1,
    assets: [
      asset('canonical-appearance', 'shorts-first', 'garment_appearance', 'not_required'),
      asset('duplicate-appearance', 'shorts-duplicate', 'garment_appearance', 'not_required'),
      asset('duplicate-product', 'shorts-duplicate', 'canonical_product', 'passed'),
    ],
    closetItems: userId === 'user-a' ? [canonical, duplicate, baseLike] : [],
    appearances: userId === 'user-a' ? [
      appearance('appearance-first', 'shorts-first', 'canonical-appearance', 'capture-first'),
      appearance('appearance-duplicate', 'shorts-duplicate', 'duplicate-appearance', 'capture-second'),
    ] : [],
    captures: userId === 'user-a' ? [
      capture('capture-first', ['top-a', 'shorts-first']),
      capture('capture-second', ['top-a', 'shorts-duplicate']),
    ] : [],
    wearEvents: userId === 'user-a' ? [
      wear('wear-first', 'shorts-first', 'capture-first'),
      wear('wear-duplicate', 'shorts-duplicate', 'capture-second'),
    ] : [],
    episodes: [],
    committedIdempotencyKeys: [],
    productImageJobs: userId === 'user-a' ? [{
      jobId: 'job-duplicate', userId, closetItemId: 'shorts-duplicate', sourceAppearanceAssetId: 'duplicate-appearance',
      status: 'ready', attemptCount: 1, productAssetId: 'duplicate-product',
      createdAt: '2026-08-06T20:46:00.000Z', updatedAt: '2026-08-06T20:46:00.000Z',
    }] : [],
    identityDecisionTraces: userId === 'user-a' ? [identityTrace()] : [],
    pendingIdentityResolutions: [],
    closetItemAliases: {},
    events: userId === 'user-a' ? [{
      eventId: 'event-duplicate', userId, type: 'provisional_item_created', closetItemId: 'shorts-duplicate',
      createdAt: '2026-08-06T20:46:00.000Z',
    }] : [],
    pendingCompletionEvent: userId === 'user-a' ? {
      eventId: 'completion', type: 'outfit_capture_completed', userId, sessionId: 'session', captureId: 'capture-second',
      episodeId: 'episode', newItemIds: ['shorts-duplicate'], recognizedItemIds: [],
      completionStatus: 'fully_resolved', pendingItems: [],
      itemSummaries: [{ closetItemId: 'shorts-duplicate', slot: 'bottom', label: 'Gray shorts', status: 'new' }],
      repeatedOutfit: false, committedAt: '2026-08-06T20:46:00.000Z',
    } : undefined,
    updatedAt: '2026-08-06T20:46:00.000Z',
  };
}

function ambientItem(id: string, source: 'mirror_auto_capture' | 'demo_fixture', imageStatus: 'ready' | 'needs_review'): AmbientClosetItem {
  return {
    item: {
      id, name: id, category: 'bottom', color: 'light gray', fit: 'regular', formality: 'casual',
      styleTags: ['shorts'], imageUrl: '/agent-assets/wardrobe-processing.svg', source,
      identityStatus: 'provisional', ownershipStatus: 'unverified', imageStatus,
    },
    status: 'active', source: 'ambient_capture', appearanceFingerprint: `${id}-fingerprint`,
    createdAt: id === 'shorts-first' ? '2026-08-06T20:43:00.000Z' : '2026-08-06T20:46:00.000Z',
    updatedAt: '2026-08-06T20:46:00.000Z',
  };
}

function asset(assetId: string, closetItemId: string, role: 'garment_appearance' | 'canonical_product', verificationStatus: 'not_required' | 'passed') {
  return {
    assetId, ownerUserId: 'user-a', role, imageUrl: `/assets/${assetId}`, closetItemId,
    width: 512, height: 512, mimeType: 'image/jpeg' as const, verificationStatus,
    contentHash: `${assetId}-hash`, createdAt: '2026-08-06T20:46:00.000Z',
  };
}

function appearance(appearanceId: string, closetItemId: string, appearanceAssetId: string, captureId: string) {
  return {
    appearanceId, userId: 'user-a', closetItemId, observationId: appearanceId, captureId,
    descriptor: { slot: 'bottom' as const, category: 'bottom' as const, dominantColor: 'light gray', secondaryColors: [], pattern: 'solid', silhouette: 'straight', fit: 'regular', distinctiveFeatures: ['shorts'] },
    appearanceFingerprint: `${appearanceId}-fingerprint`, appearanceAssetId,
    boundingBox: { x: 0.2, y: 0.4, width: 0.5, height: 0.5 }, confidence: 0.95,
    capturedAt: captureId === 'capture-first' ? '2026-08-06T20:43:00.000Z' : '2026-08-06T20:46:00.000Z',
  };
}

function capture(captureId: string, closetItemIds: string[]) {
  return {
    captureId, userId: 'user-a', sessionId: 'session', episodeId: `episode-${captureId}`,
    observationId: `observation-${captureId}`, closetItemIds,
    items: closetItemIds.map((closetItemId) => ({ type: 'closet_item' as const, closetItemId, slot: 'bottom' as const })),
    outfitSignature: signature(closetItemIds),
    repeatedOutfit: false, evidenceImageUrl: '/evidence.jpg', capturedAt: '2026-08-06T20:46:00.000Z',
    committedAt: '2026-08-06T20:46:00.000Z',
  };
}

function wear(wearEventId: string, closetItemId: string, captureId: string) {
  return { wearEventId, userId: 'user-a', closetItemId, captureId, episodeId: `episode-${captureId}`, wornAt: '2026-08-06T20:46:00.000Z' };
}

function identityTrace() {
  const pairwise = { verdict: 'same' as const, confidence: 0.95, featureComparisons: [], currentFrameEvidence: [], occlusions: [], jointlyVisibleEvidence: [], model: 'fixture' };
  return {
    traceId: 'trace-duplicate', episodeId: 'episode', observationItemId: 'shorts', currentAppearanceAssetId: 'duplicate-appearance',
    currentAppearanceAssetIds: ['duplicate-appearance'],
    recall: { strategy: 'metadata', candidates: [{ closetItemId: 'shorts-duplicate', source: 'user' as const, metadataScore: 0.9, continuityPrior: 0, effectivePrior: 0.9, tier: 'strong' as const, categoryCompatibility: 'exact' as const, referenceEvidenceType: 'historical_appearance' as const, referenceAssetIds: ['duplicate-appearance'], softContradictions: [] }] },
    pairwiseVerifications: [{ candidateClosetItemId: 'shorts-duplicate', rawResult: pairwise, normalizedResult: pairwise, serverDowngradeReasons: [], requiredDifferentConfidence: 0.93, autoCreateVeto: true, referenceEvidenceType: 'historical_appearance' as const, evidenceTaxonomyVersion: 1, classLevelSameFeatures: [], instanceSpecificSameFeatures: [], safeSameGateResult: false, safeSameRejectReasons: ['fixture'], multiFrameEvidenceCount: 1, temporalEvidenceConsistency: 'insufficient' as const, model: 'fixture', latencyMs: 10 }],
    thresholds: { matchConfidence: 0.88, baseNewConfidence: 0.78, strongPriorVeto: 0.85 },
    finalDecision: 'matched_existing' as const, matchedClosetItemId: 'shorts-duplicate', reasonCodes: ['fixture'],
    promptVersion: 'garment-pairwise-v1', schemaVersion: 1, createdAt: '2026-08-06T20:46:00.000Z',
  };
}

function signature(ids: string[]): string {
  return createHash('sha256').update([...ids].sort().join('|')).digest('hex').slice(0, 24);
}

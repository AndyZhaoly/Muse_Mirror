import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import type {
  AmbientCapturePacket,
  GarmentIdentityDecisionTrace,
  GarmentIdentityHypothesis,
  GarmentImageAsset,
  PendingIdentityResolution,
  ProductImageVerification,
  WornGarmentObservation,
  WornOutfitObservation,
} from '../src/domain/ambientCapture.js';
import {
  AmbientCaptureCoordinator,
  findPendingResolutionForTrack,
  gateWornGarmentObservation,
  updateGarmentTracks,
} from '../src/runtime/ambientCaptureCoordinator.js';
import { GarmentImageAssetService } from '../src/services/garmentImageAssetService.js';
import {
  VisualGarmentIdentityProvider,
  type GarmentIdentityInput,
  type GarmentIdentityProvider,
} from '../src/services/garmentIdentityProvider.js';
import {
  OpenAIGarmentVisualVerifier,
  type GarmentVisualVerifier,
  type ProductImageVerifier,
} from '../src/services/garmentVisualVerifier.js';
import type { OutfitObservationProvider } from '../src/services/outfitObservationProvider.js';
import {
  OpenAIProductImageProvider,
  type ProductImageGenerationInput,
  type ProductImageProvider,
} from '../src/services/productImageProvider.js';
import { JsonUserWardrobeRepository } from '../src/services/userWardrobeRepository.js';
import type { ClosetItem } from '../src/types.js';

const userId = 'browser_user_ambient_test';

test('barely visible and coverage-incompatible slots are removed before identity resolution', () => {
  const gated = gateWornGarmentObservation({
    ...outfit([
      { ...garment('top', 'top', 'navy', 'navy tee'), visibleFraction: 'full' },
      { ...garment('bottom', 'bottom', 'gray', 'barely visible shorts'), visibleFraction: 'barely' },
      { ...garment('bottom', 'bottom', 'white', 'inferred shoes'), slot: 'shoes', category: 'shoes', visibleFraction: 'partial' },
    ]),
    coverage: 'upper_body',
  });
  assert.deepEqual(gated.observation.garments.map((item) => item.slot), ['top']);
  assert.ok(gated.reasonCodes.includes('SLOT_DROPPED_BARELY_VISIBLE'));
  assert.ok(gated.reasonCodes.includes('SLOT_DROPPED_OUTSIDE_COVERAGE'));
});

test('a barely visible slot does not block a clear garment from completing capture', async () => {
  const fixture = await createFixture('barely-visible-slot');
  await fixture.repository.setGrant(userId, true);
  const observed = outfit([
    { ...garment('clear-top', 'top', 'navy', 'navy crew tee'), visibleFraction: 'full' },
    { ...garment('barely-bottom', 'bottom', 'sand', 'barely visible trousers'), visibleFraction: 'barely' },
  ]);
  const productCalls: ProductImageGenerationInput[] = [];
  const runtime = coordinator({
    repository: fixture.repository,
    assetService: fixture.assetService,
    observations: [observed, observed],
    productCalls,
  });

  const observing = await runtime.process(packet(fixture.framePath, 'barely-slot', 'bs1'));
  assert.equal(observing.status, 'observing');
  assert.ok(observing.reasonCodes.includes('SLOT_DROPPED_BARELY_VISIBLE'));
  const committed = await runtime.process(packet(fixture.framePath, 'barely-slot', 'bs2'));
  assert.equal(committed.status, 'committed_processing_images');
  assert.ok(committed.reasonCodes.includes('SLOT_DROPPED_BARELY_VISIBLE'));

  const state = await waitForImages(fixture.repository, userId, 1);
  assert.equal(state.closetItems.length, 1);
  assert.equal(state.closetItems[0]?.item.category, 'top');
  assert.equal(state.captures[0]?.closetItemIds.length, 1);
  assert.equal(productCalls.length, 1);
});

test('three rounds create verified products, recognize real appearances, then add only the changed garment', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-ambient-three-rounds-'));
  const statePath = path.join(directory, 'wardrobe.json');
  const assetService = new GarmentImageAssetService({ rootDirectory: path.join(directory, 'out') });
  const navyFrame = await writeFrame(path.join(directory, 'navy.jpg'), '#17233b', '#c5a66b');
  const redFrame = await writeFrame(path.join(directory, 'red.jpg'), '#8b2e2e', '#c5a66b');
  const productCalls: ProductImageGenerationInput[] = [];

  const firstOutfit = outfit([
    garment('top-r1', 'top', 'navy', 'short sleeve crew neck tee'),
    garment('bottom-r1', 'bottom', 'sand', 'straight trousers'),
  ]);
  const repository1 = new JsonUserWardrobeRepository(statePath);
  await repository1.setGrant(userId, true);
  const round1 = coordinator({
    repository: repository1,
    assetService,
    observations: [firstOutfit, firstOutfit],
    productCalls,
  });
  assert.equal((await round1.process(packet(navyFrame, 'round-1', 'r1a'))).status, 'observing');
  const round1Committed = await round1.process(packet(navyFrame, 'round-1', 'r1b'));
  assert.equal(round1Committed.status, 'committed_processing_images');
  const round1State = await waitForImages(repository1, userId, 2);
  assert.equal(round1State.closetItems.length, 2);
  assert.equal(round1State.captures.length, 1);
  assert.equal(round1State.wearEvents.length, 2);
  assert.equal(productCalls.length, 2);
  assert.ok(round1State.closetItems.every((entry) => entry.item.imageStatus === 'ready'));
  assert.ok(round1State.closetItems.every((entry) => entry.status === 'active'));
  assert.ok(round1State.closetItems.every((entry) => entry.item.identityStatus === 'provisional'));
  assert.ok(round1State.closetItems.every((entry) => entry.item.ownershipStatus === 'unverified'));
  assert.ok(round1State.closetItems.every((entry) => entry.item.primaryImageAssetId));
  assert.ok(round1State.closetItems.every((entry) => entry.item.imageUrl.startsWith('/api/fashion/wardrobe-assets/')));
  const round1Products = round1State.assets.filter((asset) => asset.role === 'canonical_product');
  const round1Appearances = round1State.assets.filter((asset) => asset.role === 'garment_appearance');
  assert.equal(round1Products.length, 2);
  assert.equal(round1Appearances.length, 2);
  assert.notEqual(round1Appearances[0]?.contentHash, round1Appearances[1]?.contentHash);
  assert.notEqual(round1Products[0]?.contentHash, round1Products[1]?.contentHash);
  assert.ok(round1Products.every((asset) => asset.verificationStatus === 'passed'));
  const originalPrimaryIds = new Map(round1State.closetItems.map((entry) => [entry.item.color, entry.item.primaryImageAssetId]));
  await round1.acknowledge(userId);
  await round1.endEpisode(userId, 'round-1');

  const repository2 = new JsonUserWardrobeRepository(statePath);
  const round2 = coordinator({
    repository: repository2,
    assetService,
    observations: [firstOutfit, firstOutfit],
    productCalls,
  });
  assert.equal((await round2.process(packet(navyFrame, 'round-2', 'r2a'))).status, 'observing');
  const round2Result = await round2.process(packet(navyFrame, 'round-2', 'r2b'));
  assert.equal(round2Result.status, 'recognized');
  assert.equal(round2Result.completedEvent?.newItemIds.length, 0);
  assert.equal(round2Result.completedEvent?.recognizedItemIds.length, 2);
  assert.equal(productCalls.length, 2, 'recognized garments must not regenerate paid catalog images');
  const round2State = await repository2.getState(userId);
  assert.equal(round2State.closetItems.length, 2);
  assert.equal(round2State.appearances.length, 4);
  assert.equal(round2State.assets.filter((asset) => asset.role === 'canonical_product').length, 2);
  for (const entry of round2State.closetItems) {
    assert.equal(entry.item.primaryImageAssetId, originalPrimaryIds.get(entry.item.color));
    assert.equal(entry.item.appearanceAssetIds?.length, 2);
    assert.equal(entry.item.identityStatus, 'provisional');
    assert.equal(entry.item.ownershipStatus, 'unverified');
  }
  await round2.acknowledge(userId);
  await round2.endEpisode(userId, 'round-2');

  const mixedOutfit = outfit([
    garment('top-r3', 'top', 'brick red', 'relaxed polo shirt'),
    garment('bottom-r3', 'bottom', 'sand', 'straight trousers'),
  ]);
  const repository3 = new JsonUserWardrobeRepository(statePath);
  const round3 = coordinator({
    repository: repository3,
    assetService,
    observations: [mixedOutfit, mixedOutfit],
    productCalls,
  });
  assert.equal((await round3.process(packet(redFrame, 'round-3', 'r3a'))).status, 'observing');
  assert.equal((await round3.process(packet(redFrame, 'round-3', 'r3b'))).status, 'committed_processing_images');
  const round3State = await waitForImages(repository3, userId, 3);
  assert.equal(round3State.closetItems.length, 3);
  assert.equal(round3State.captures.length, 3);
  assert.equal(round3State.wearEvents.length, 6);
  assert.equal(productCalls.length, 3);
  assert.equal(round3State.assets.filter((asset) => asset.role === 'canonical_product').length, 3);
  const sandBottom = round3State.closetItems.find((entry) => entry.item.color === 'sand');
  assert.equal(sandBottom?.item.primaryImageAssetId, originalPrimaryIds.get('sand'));
  assert.equal(round3State.pendingCompletionEvent?.newItemIds.length, 1);
  assert.equal(round3State.pendingCompletionEvent?.recognizedItemIds.length, 1);
});

test('demo base-closet exclusion is reversible and keeps ambient recognition and product images', async () => {
  const fixture = await createFixture('ignore-base-closet');
  await fixture.repository.setGrant(userId, true);
  const observed = outfit([garment('demo-top', 'top', 'navy', 'navy short sleeve tee')]);
  const baseItem: ClosetItem = {
    id: 'base-demo-navy-tee', name: 'Base demo navy tee', category: 'top', color: 'navy', fit: 'regular',
    styleTags: ['navy short sleeve tee'], formality: 'casual', imageUrl: '/base/navy-tee.jpg', marketedFor: 'unisex',
  };
  const originalBase = structuredClone(baseItem);
  const productCalls: ProductImageGenerationInput[] = [];
  const identityInputs: Array<{ baseIds: string[]; userIds: string[] }> = [];
  const identityProvider: GarmentIdentityProvider = {
    ready: true,
    async resolve(input) {
      identityInputs.push({
        baseIds: input.baseClosetItems.map((item) => item.id),
        userIds: input.userClosetItems.map((entry) => entry.item.id),
      });
      const existing = input.userClosetItems.find((entry) => entry.status === 'active');
      return existing ? {
        observationItemId: input.garment.observationItemId,
        status: 'matched_existing',
        matchedClosetItemId: existing.item.id,
        appearanceFingerprint: 'demo-navy-top',
        confidence: 0.95,
        candidateItemIds: [existing.item.id],
        reasonCodes: ['FIXTURE_AMBIENT_MATCH'],
      } : {
        observationItemId: input.garment.observationItemId,
        status: 'new_to_closet',
        appearanceFingerprint: 'demo-navy-top',
        confidence: 0.92,
        candidateItemIds: [],
        reasonCodes: ['FIXTURE_DEMO_NEW'],
      };
    },
  };
  let baseCatalogLoads = 0;
  const runtime = (ignoreBaseClosetCandidates: boolean) => new AmbientCaptureCoordinator({
    observationProvider: queuedProvider([observed, observed]),
    identityProvider,
    repository: fixture.repository,
    baseClosetItems: () => [baseItem],
    ignoreBaseClosetCandidates,
    baseCatalogAssets: async () => {
      baseCatalogLoads += 1;
      return new Map();
    },
    assetService: fixture.assetService,
    productImageProvider: new EditingFakeProductProvider(fixture.assetService, productCalls),
    productImageVerifier: new PassingProductVerifier(),
  });

  const firstWear = runtime(true);
  assert.equal((await firstWear.process(packet(fixture.framePath, 'demo-first', 'demo-first-1'))).status, 'observing');
  assert.equal((await firstWear.process(packet(fixture.framePath, 'demo-first', 'demo-first-2'))).status, 'committed_processing_images');
  const firstState = await waitForImages(fixture.repository, userId, 1);
  const ambientItemId = firstState.closetItems[0]?.item.id;
  assert.ok(ambientItemId);
  assert.equal(firstState.closetItems[0]?.item.imageStatus, 'ready');
  assert.equal(productCalls.length, 1);
  assert.deepEqual(identityInputs.at(-1), { baseIds: [], userIds: [] });
  assert.equal(baseCatalogLoads, 0);
  await firstWear.acknowledge(userId);
  await firstWear.endEpisode(userId, 'demo-first');

  const secondWear = runtime(true);
  assert.equal((await secondWear.process(packet(fixture.framePath, 'demo-second', 'demo-second-1'))).status, 'observing');
  const secondResult = await secondWear.process(packet(fixture.framePath, 'demo-second', 'demo-second-2'));
  assert.equal(secondResult.status, 'recognized');
  assert.deepEqual(secondResult.completedEvent?.recognizedItemIds, [ambientItemId]);
  assert.deepEqual(identityInputs.at(-1), { baseIds: [], userIds: [ambientItemId] });
  assert.equal(productCalls.length, 1, 'repeat recognition must reuse the first product card');
  assert.equal(baseCatalogLoads, 0);
  await secondWear.acknowledge(userId);
  await secondWear.endEpisode(userId, 'demo-second');

  const normalMode = runtime(false);
  assert.equal((await normalMode.process(packet(fixture.framePath, 'normal-mode', 'normal-mode-1'))).status, 'observing');
  assert.equal((await normalMode.process(packet(fixture.framePath, 'normal-mode', 'normal-mode-2'))).status, 'recognized');
  assert.deepEqual(identityInputs.at(-1), { baseIds: [baseItem.id], userIds: [ambientItemId] });
  assert.equal(baseCatalogLoads, 1, 'disabling demo mode must restore base catalog participation');
  assert.equal(productCalls.length, 1);
  assert.deepEqual(baseItem, originalBase, 'retrieval filtering must never mutate the base wardrobe');
});

test('a verified empty observation ends the episode with a bounded client backoff', async () => {
  const fixture = await createFixture('empty-scene-backoff');
  await fixture.repository.setGrant(userId, true);
  const emptyObservation: WornOutfitObservation = {
    observationId: 'observation_empty_scene',
    provider: 'test-real-contract',
    model: 'fixture',
    analyzedAt: new Date().toISOString(),
    personCount: 0,
    coverage: 'none',
    quality: 'good',
    garments: [],
    uncertainties: [],
  };
  const runtime = coordinator({
    repository: fixture.repository,
    assetService: fixture.assetService,
    observations: [
      emptyObservation,
      outfit([
        garment('top-after-empty', 'top', 'navy', 'short sleeve crew neck tee'),
        garment('bottom-after-empty', 'bottom', 'sand', 'straight trousers'),
      ]),
    ],
    productCalls: [],
  });
  const result = await runtime.process(packet(fixture.framePath, 'empty-scene', 'empty-1'));
  assert.equal(result.status, 'episode_ended');
  assert.deepEqual(result.reasonCodes, ['NO_PERSON_PRESENT']);
  assert.equal(result.retryAfterMs, 10_000);
  const reentered = await runtime.process(packet(fixture.framePath, 'empty-scene', 'person-1'));
  assert.equal(reentered.status, 'observing');
  assert.notEqual(reentered.episodeId, result.episodeId, 're-entry must start a fresh outfit episode');
});

test('crop service stores separate evidence and appearance assets and rejects invalid boxes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-ambient-crops-'));
  const framePath = await writeFrame(path.join(directory, 'frame.jpg'), '#1d3159', '#d2af73');
  const service = new GarmentImageAssetService({ rootDirectory: path.join(directory, 'out') });
  const evidence = await service.storeEvidence({ userId, sourceFramePath: framePath, sourceFrameId: 'frame-crop' });
  const top = await service.cropGarment({
    userId, sourceFramePath: framePath, sourceFrameId: 'frame-crop', observationItemId: 'top',
    boundingBox: garment('top', 'top', 'navy', 'tee').boundingBox, slot: 'top',
  });
  const bottom = await service.cropGarment({
    userId, sourceFramePath: framePath, sourceFrameId: 'frame-crop', observationItemId: 'bottom',
    boundingBox: garment('bottom', 'bottom', 'sand', 'trousers').boundingBox, slot: 'bottom',
  });
  assert.equal(evidence.role, 'capture_evidence');
  assert.equal(top.asset.role, 'garment_appearance');
  assert.equal(bottom.asset.role, 'garment_appearance');
  assert.notEqual(top.asset.assetId, bottom.asset.assetId);
  assert.notEqual(top.asset.contentHash, bottom.asset.contentHash);
  assert.notEqual(top.asset.imageUrl, evidence.imageUrl);
  assert.ok(!top.asset.storagePath?.includes(userId));
  assert.equal((await sharp(top.cropPath).metadata()).orientation, undefined, 're-encoded crops strip EXIF orientation');
  await assert.rejects(() => service.cropGarment({
    userId, sourceFramePath: framePath, sourceFrameId: 'bad', observationItemId: 'bad',
    boundingBox: { x: -0.1, y: 0.2, width: 0.3, height: 0.3 }, slot: 'top',
  }), /GARMENT_BBOX_OUT_OF_RANGE/);
  await assert.rejects(() => service.cropGarment({
    userId, sourceFramePath: framePath, sourceFrameId: 'tiny', observationItemId: 'tiny',
    boundingBox: { x: 0.2, y: 0.2, width: 0.081, height: 0.081 }, slot: 'top',
  }), /GARMENT_CROP_TOO_SMALL/);
  await service.deleteAssets([evidence, top.asset, bottom.asset]);
  await assert.rejects(() => fs.access(top.cropPath));
});

test('diagnostic capture bundles preserve a reproducible frame and crops after transient assets are deleted', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-ambient-diagnostics-'));
  const rootDirectory = path.join(directory, 'out');
  const framePath = await writeFrame(path.join(directory, 'frame.jpg'), '#1d3159', '#d2af73');
  const service = new GarmentImageAssetService({ rootDirectory });
  const topGarment = garment('diagnostic-top', 'top', 'navy', 'tee');
  const evidence = await service.storeEvidence({
    userId,
    sourceFramePath: framePath,
    sourceFrameId: 'frame-diagnostic',
    capturedAt: '2026-08-08T04:00:00.000Z',
  });
  const top = await service.cropGarment({
    userId,
    sourceFramePath: framePath,
    sourceFrameId: 'frame-diagnostic',
    observationItemId: topGarment.observationItemId,
    boundingBox: topGarment.boundingBox,
    slot: topGarment.slot,
    capturedAt: '2026-08-08T04:00:00.000Z',
  });
  const bundle = await service.storeDiagnosticCapture({
    userId,
    episodeId: 'episode-diagnostic',
    observationId: 'observation-diagnostic',
    frameId: 'frame-diagnostic',
    capturedAt: '2026-08-08T04:00:00.000Z',
    evidenceAsset: evidence,
    appearanceAssets: [top.asset],
    garments: [topGarment],
    retentionLimit: 10,
  });
  assert.ok(bundle);
  await service.deleteAssets([evidence, top.asset]);

  const manifestPath = path.join(rootDirectory, bundle.relativeDirectory, bundle.manifestFile);
  const manifestText = await fs.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText) as {
    assets: Array<{ fileName: string; assetId: string }>;
    garments: Array<{ appearanceAssetId?: string }>;
  };
  assert.equal(manifest.assets.length, 2);
  assert.equal(manifest.garments[0]?.appearanceAssetId, top.asset.assetId);
  assert.doesNotMatch(manifestText, new RegExp(userId));
  assert.doesNotMatch(manifestText, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const asset of manifest.assets) {
    await fs.access(path.join(rootDirectory, bundle.relativeDirectory, asset.fileName));
  }
  await assert.rejects(() => fs.access(top.cropPath), 'working asset should still follow normal cleanup');
  assert.deepEqual((await service.listDiagnosticCaptures(userId)).map((entry) => entry.bundleId), [bundle.bundleId]);
});

test('visual identity uses metadata only for recall and can match a base catalog image', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-ambient-base-reid-'));
  const service = new GarmentImageAssetService({ rootDirectory: path.join(directory, 'out') });
  const frame = await writeFrame(path.join(directory, 'frame.jpg'), '#17233b', '#c5a66b');
  const current = (await service.cropGarment({
    userId, sourceFramePath: frame, sourceFrameId: 'current', observationItemId: 'top',
    boundingBox: garment('top', 'top', 'navy', 'short sleeve crew neck tee').boundingBox, slot: 'top',
  })).asset;
  const baseItem: ClosetItem = {
    id: 'base-navy-tee', name: 'Navy tee', category: 'top', color: 'navy', fit: 'regular',
    styleTags: ['solid', 'short sleeve crew neck tee'], formality: 'casual',
    imageUrl: '/agent-assets/navy-tee.jpg', marketedFor: 'unisex',
  };
  const baseAsset: GarmentImageAsset = { ...current, assetId: 'base-catalog', ownerUserId: 'base_catalog', role: 'canonical_product', closetItemId: baseItem.id };
  let candidateIds: string[] = [];
  const verifier: GarmentVisualVerifier = {
    ready: true,
    async verifyPair(input) {
      candidateIds.push(input.candidate.closetItem.id);
      return {
        ...pairwise('same', 0.96),
        featureComparisons: [
          { ...pairwise('same', 0.96).featureComparisons[0]!, feature: 'pocket_geometry' as const },
          { ...pairwise('same', 0.96).featureComparisons[0]!, feature: 'logo_placement' as const, discriminativeStrength: 'medium' as const },
        ],
      };
    },
  };
  const provider = new VisualGarmentIdentityProvider({ verifier });
  const result = await provider.resolve({
    userId,
    garment: garment('observed', 'top', 'navy', 'short sleeve crew neck tee'),
    currentAppearances: [current],
    baseClosetItems: [baseItem],
    userClosetItems: [], appearances: [], assets: [],
    baseCatalogAssets: new Map([[baseItem.id, baseAsset]]),
  });
  assert.deepEqual(candidateIds, [baseItem.id]);
  assert.equal(result.status, 'matched_existing');
  assert.equal(result.matchedClosetItemId, baseItem.id);
});

test('visual verifier converts invalid legacy-shaped output to uncertain', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-ambient-allowlist-'));
  const service = new GarmentImageAssetService({ rootDirectory: path.join(directory, 'out') });
  const frame = await writeFrame(path.join(directory, 'frame.jpg'), '#17233b', '#c5a66b');
  const current = (await service.cropGarment({
    userId, sourceFramePath: frame, sourceFrameId: 'current', observationItemId: 'top',
    boundingBox: garment('top', 'top', 'navy', 'crew tee').boundingBox, slot: 'top',
  })).asset;
  const verifier = new OpenAIGarmentVisualVerifier({
    model: 'test-model',
    responseCreate: async () => ({
      output_text: JSON.stringify({
        result: 'same', matchedClosetItemId: 'not-in-recall', confidence: 0.99,
        evidence: ['looks similar'], mismatches: [],
      }),
    }),
  });
  const result = await verifier.verifyPair({
    currentAppearances: [current],
    lockedDescriptor: {
      slot: 'top', category: 'top', dominantColor: 'navy', secondaryColors: [], pattern: 'solid',
      sleeve: 'short', neckline: 'crew', lengthClass: 'medium', materialClass: 'cotton',
      silhouette: 'regular', fit: 'regular', distinctiveFeatures: [],
    },
    candidate: {
      closetItem: {
        id: 'allowed-item', name: 'Allowed', category: 'top', color: 'navy', fit: 'regular',
        styleTags: [], formality: 'casual', imageUrl: '/allowed.jpg', marketedFor: 'unisex',
      },
      referenceAppearances: [current],
    },
  });
  assert.equal(result.verdict, 'uncertain');
  assert.deepEqual(result.occlusions, ['VISUAL_VERIFIER_INVALID_OUTPUT']);
});

test('OpenAI catalog provider uses source-image edit and never puts user identity in the prompt', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-ambient-product-edit-'));
  const service = new GarmentImageAssetService({ rootDirectory: path.join(directory, 'out') });
  const frame = await writeFrame(path.join(directory, 'frame.jpg'), '#17233b', '#c5a66b');
  const sourceAppearance = (await service.cropGarment({
    userId: 'sensitive-user-id', sourceFramePath: frame, sourceFrameId: 'edit-source', observationItemId: 'top',
    boundingBox: garment('top', 'top', 'navy', 'crew tee').boundingBox, slot: 'top',
  })).asset;
  let request: Record<string, unknown> | undefined;
  const output = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#17233b' } })
    .webp().toBuffer();
  const provider = new OpenAIProductImageProvider({
    model: 'gpt-image-test', quality: 'medium', size: '1024x1024', assetService: service,
    imageEdit: async (value) => {
      request = value as Record<string, unknown>;
      return { data: [{ b64_json: output.toString('base64') }] };
    },
  });
  const result = await provider.createCanonicalProductImage({
    userId: 'sensitive-user-id', closetItemId: 'closet-top', sourceAppearance,
    item: { category: 'top', color: 'navy', slot: 'top', description: 'navy crew tee' },
  });
  assert.ok(request?.image, 'Images Edit must receive the real appearance as image input');
  assert.match(String(request?.prompt), /exact same garment/i);
  assert.doesNotMatch(String(request?.prompt), /sensitive-user-id/);
  assert.equal(result.asset.role, 'canonical_product');
  assert.equal(result.asset.sourceAssetId, sourceAppearance.assetId);
  assert.notEqual(result.asset.contentHash, sourceAppearance.contentHash);
});

test('ambiguous visual identity persists pending refs without creating closet items', async () => {
  const fixture = await createFixture('ambiguous');
  await fixture.repository.setGrant(userId, true);
  const observed = outfit([
    garment('top', 'top', 'black', 'plain tee'),
    garment('bottom', 'bottom', 'black', 'straight trousers'),
  ]);
  const runtime = new AmbientCaptureCoordinator({
    observationProvider: queuedProvider([observed, observed]),
    identityProvider: {
      ready: true,
      async resolve(input) {
        return {
          observationItemId: input.garment.observationItemId,
          status: 'ambiguous', appearanceFingerprint: 'ambiguous', confidence: 0.7,
          candidateItemIds: ['one', 'two'], reasonCodes: ['MULTIPLE_SIMILAR_ITEMS'],
        };
      },
    },
    repository: fixture.repository,
    baseClosetItems: () => [], assetService: fixture.assetService,
    productImageProvider: new DisabledFakeProductProvider(),
    productImageVerifier: new PassingProductVerifier(),
    retainDiagnosticCaptures: true,
    diagnosticCaptureLimit: 10,
  });
  await runtime.process(packet(fixture.framePath, 'ambiguous', 'a1'));
  const result = await runtime.process(packet(fixture.framePath, 'ambiguous', 'a2'));
  assert.equal(result.status, 'mixed');
  const state = await fixture.repository.getState(userId);
  assert.equal(state.closetItems.length, 0);
  assert.equal(state.captures.length, 1);
  assert.equal(state.captures[0]?.items.filter((item) => item.type === 'pending_identity').length, 2);
  assert.ok(state.assets.some((asset) => asset.role === 'track_identity_evidence'));
  assert.equal(state.pendingIdentityResolutions.length, 2);
  assert.ok(state.pendingIdentityResolutions.every((resolution) => resolution.state === 'ready_to_ask'));
  const bundles = await fixture.assetService.listDiagnosticCaptures(userId);
  assert.equal(bundles.length, 2);
  assert.equal(bundles[0]?.frameId, 'a2');
  assert.equal(bundles[0]?.assetIds.length, 3);
  const diagnostics = await runtime.diagnostics(userId);
  assert.equal(diagnostics.diagnosticCaptureRetentionEnabled, true);
  assert.equal(diagnostics.diagnosticCaptureCount, 2);
  assert.equal(diagnostics.latestDiagnosticCapture?.bundleId, bundles[0]?.bundleId);
});

test('one ambiguous garment does not block new and existing items in the same capture', async () => {
  const fixture = await createFixture('progressive-per-item-commit');
  await fixture.repository.setGrant(userId, true);
  const shoes: WornGarmentObservation = {
    ...garment('shoes', 'bottom', 'white', 'white sneakers'),
    slot: 'shoes',
    category: 'shoes',
    boundingBox: { x: 0.3, y: 0.82, width: 0.4, height: 0.16 },
  };
  const observed = outfit([
    garment('new-top', 'top', 'blue', 'blue overshirt'),
    garment('pending-bottom', 'bottom', 'gray', 'gray shorts'),
    shoes,
  ]);
  const productCalls: ProductImageGenerationInput[] = [];
  const runtime = new AmbientCaptureCoordinator({
    observationProvider: queuedProvider([observed, observed]),
    identityProvider: {
      ready: true,
      async resolve(input) {
        if (input.garment.observationItemId === 'new-top') return {
          observationItemId: input.garment.observationItemId,
          status: 'new_to_closet' as const,
          appearanceFingerprint: 'new-top-fingerprint', confidence: 0.91,
          candidateItemIds: [], reasonCodes: ['FIXTURE_NEW'],
        };
        if (input.garment.observationItemId === 'shoes') return {
          observationItemId: input.garment.observationItemId,
          status: 'matched_existing' as const,
          matchedClosetItemId: 'existing-shoes',
          appearanceFingerprint: 'existing-shoes-fingerprint', confidence: 0.94,
          candidateItemIds: ['existing-shoes'], reasonCodes: ['FIXTURE_MATCH'],
        };
        return {
          observationItemId: input.garment.observationItemId,
          status: 'ambiguous' as const,
          appearanceFingerprint: 'pending-bottom-fingerprint', confidence: 0.6,
          candidateItemIds: ['gray-shorts-a'], reasonCodes: ['INSUFFICIENT_INSTANCE_EVIDENCE'],
        };
      },
    },
    repository: fixture.repository,
    baseClosetItems: () => [], assetService: fixture.assetService,
    productImageProvider: new EditingFakeProductProvider(fixture.assetService, productCalls),
    productImageVerifier: new PassingProductVerifier(),
  });

  await runtime.process(packet(fixture.framePath, 'progressive', 'pc1'));
  const outcome = await runtime.process(packet(fixture.framePath, 'progressive', 'pc2'));
  const state = await fixture.repository.getState(userId);
  assert.equal(outcome.status, 'committed_processing_images');
  assert.equal(state.closetItems.length, 1);
  assert.equal(state.pendingIdentityResolutions.length, 1);
  assert.equal(state.captures.length, 1);
  assert.deepEqual(state.captures[0]?.items.map((item) => item.type), [
    'closet_item', 'pending_identity', 'closet_item',
  ]);
  assert.equal(state.wearEvents.length, 2);
  assert.ok(state.wearEvents.some((event) => event.closetItemId === 'existing-shoes'));
  assert.ok(!state.wearEvents.some((event) => event.closetItemId === 'gray-shorts-a'));

  const settled = await waitForJobsToSettle(fixture.repository, userId, 1);
  assert.equal(settled.pendingCompletionEvent?.completionStatus, 'partially_resolved');
  assert.deepEqual(settled.pendingCompletionEvent?.pendingItems.map((item) => item.label), ['gray shorts']);
  assert.equal(settled.pendingCompletionEvent?.newItemIds.length, 1);
  assert.equal(settled.pendingCompletionEvent?.recognizedItemIds.length, 1);
  const diagnostics = await runtime.diagnostics(userId);
  assert.equal(productCalls.length, 1);
  assert.equal(diagnostics.lastOutcome?.status, 'mixed');
  assert.ok(diagnostics.lastOutcome?.reasonCodes.includes('PENDING_IDENTITY_RECORDED'));
  assert.ok(!diagnostics.lastOutcome?.reasonCodes.includes('ALL_NEW_OUTFIT_READY'));
  assert.equal(diagnostics.lastOutcome?.completedEvent?.completionStatus, 'partially_resolved');
});

test('a delayed catalog image job cannot overwrite a newer resolved outfit state', async () => {
  const fixture = await createFixture('stale-catalog-completion');
  await fixture.repository.setGrant(userId, true);
  const frameA = await writeFrame(path.join(fixture.directory, 'frame-a.jpg'), '#2d5d85', '#9ca3af');
  const frameB = await writeFrame(path.join(fixture.directory, 'frame-b.jpg'), '#2d5d85', '#737b86');
  const topA = garment('frame-a-top', 'top', 'blue', 'blue overshirt');
  const bottomA = garment('frame-a-bottom', 'bottom', 'gray', 'gray shorts');
  const topB = garment('frame-b-top', 'top', 'blue', 'blue overshirt');
  const bottomB = {
    ...garment('frame-b-bottom', 'bottom', 'gray', 'gray shorts'),
    boundingBox: { x: 0.2, y: 0.44, width: 0.58, height: 0.5 },
    distinctiveFeatures: ['gray shorts', 'visible waistband'],
  };
  const observedA = outfit([topA, bottomA]);
  const observedB = outfit([topB, bottomB]);
  let releaseImage!: () => void;
  let markImageStarted!: () => void;
  const imageStarted = new Promise<void>((resolve) => { markImageStarted = resolve; });
  const imageRelease = new Promise<void>((resolve) => { releaseImage = resolve; });
  const delayedProductProvider: ProductImageProvider = {
    ready: true,
    async createCanonicalProductImage(input) {
      markImageStarted();
      await imageRelease;
      const bytes = await sharp(input.sourceAppearance.storagePath!)
        .resize(512, 512, { fit: 'contain', background: '#f7f7f3' })
        .webp({ quality: 90 })
        .toBuffer();
      return {
        asset: await fixture.assetService.storeProductImage({
          userId: input.userId,
          closetItemId: input.closetItemId,
          sourceAsset: input.sourceAppearance,
          bytes,
          mimeType: 'image/webp',
        }),
        provider: 'deferred-fixture',
        model: 'deferred-fixture',
      };
    },
  };
  const existingBottom: ClosetItem = {
    id: 'existing-bottom', name: 'Existing gray shorts', category: 'bottom', color: 'gray', fit: 'straight',
    styleTags: ['gray shorts'], formality: 'casual', imageUrl: '/agent-assets/existing-bottom.jpg', marketedFor: 'unisex',
  };
  const identityProvider = {
    ready: true,
    async resolve(input: GarmentIdentityInput): Promise<GarmentIdentityHypothesis> {
      if (input.garment.observationItemId === 'frame-a-bottom') {
        const pending = ambiguousIdentity(input, true);
        pending.candidateItemIds = ['existing-bottom'];
        return pending;
      }
      if (input.garment.slot === 'bottom') {
        return {
          observationItemId: input.garment.observationItemId,
          status: 'matched_existing', matchedClosetItemId: 'existing-bottom',
          appearanceFingerprint: 'existing-bottom', confidence: 0.95,
          candidateItemIds: ['existing-bottom'], reasonCodes: ['FIXTURE_MATCH'],
        };
      }
      const existingTop = input.userClosetItems.find((entry) => entry.item.category === 'top');
      return existingTop ? {
        observationItemId: input.garment.observationItemId,
        status: 'matched_existing', matchedClosetItemId: existingTop.item.id,
        appearanceFingerprint: 'blue-top', confidence: 0.95,
        candidateItemIds: [existingTop.item.id], reasonCodes: ['FIXTURE_MATCH'],
      } : {
        observationItemId: input.garment.observationItemId,
        status: 'new_to_closet', appearanceFingerprint: 'blue-top', confidence: 0.92,
        candidateItemIds: [], reasonCodes: ['FIXTURE_NEW'],
      };
    },
  };
  const runtime = new AmbientCaptureCoordinator({
    observationProvider: queuedProvider([observedA, observedA, observedB]),
    identityProvider,
    repository: fixture.repository,
    baseClosetItems: () => [existingBottom],
    assetService: fixture.assetService,
    productImageProvider: delayedProductProvider,
    productImageVerifier: new PassingProductVerifier(),
  });

  assert.equal((await runtime.process(packet(frameA, 'stale-race', 'race-a1'))).status, 'observing');
  const frameAOutcome = await runtime.process(packet(frameA, 'stale-race', 'race-a2'));
  assert.equal(frameAOutcome.status, 'committed_processing_images');
  assert.equal(frameAOutcome.completedEvent?.completionStatus, 'partially_resolved');
  await imageStarted;

  const frameBOutcome = await runtime.process(packet(frameB, 'stale-race', 'race-b1'));
  assert.equal(frameBOutcome.status, 'recognized');
  assert.equal(frameBOutcome.completedEvent?.completionStatus, 'fully_recognized');
  assert.equal(frameBOutcome.completedEvent?.pendingItems.length, 0);
  releaseImage();
  const settled = await waitForState(fixture.repository, userId, (state) =>
    state.productImageJobs.length === 1 && state.productImageJobs[0]?.status === 'ready');
  const diagnostics = await runtime.diagnostics(userId);

  assert.equal(settled.pendingCompletionEvent?.completionStatus, 'fully_recognized');
  assert.equal(settled.pendingCompletionEvent?.pendingItems.length, 0);
  assert.ok(settled.pendingCompletionEvent?.recognizedItemIds.includes('existing-bottom'));
  assert.equal(settled.pendingCompletionEvent?.itemSummaries.length, 2);
  assert.equal(diagnostics.lastOutcome?.status, 'recognized');
  assert.equal(diagnostics.lastOutcome?.observationId, observedB.observationId);
  assert.ok(!diagnostics.lastOutcome?.reasonCodes.includes('ALL_NEW_OUTFIT_READY'));
});

test('different physical garments with the same appearance fingerprint receive unique closet item IDs', async () => {
  const fixture = await createFixture('unique-physical-item-id');
  await fixture.repository.setGrant(userId, true);
  const first = outfit([garment('black-tee-a', 'top', 'black', 'plain black crew tee')]);
  const second = outfit([garment('black-tee-b', 'top', 'black', 'plain black crew tee')]);
  const identityProvider = {
    ready: true,
    async resolve(input: GarmentIdentityInput): Promise<GarmentIdentityHypothesis> {
      return {
        observationItemId: input.garment.observationItemId,
        status: 'new_to_closet',
        appearanceFingerprint: 'same-semantic-fingerprint',
        confidence: 0.94,
        candidateItemIds: input.userClosetItems.map((entry) => entry.item.id),
        reasonCodes: ['PAIRWISE_CONFIRMED_DIFFERENT'],
      };
    },
  };
  const firstRuntime = new AmbientCaptureCoordinator({
    observationProvider: queuedProvider([first, first]), identityProvider,
    repository: fixture.repository, baseClosetItems: () => [], assetService: fixture.assetService,
    productImageProvider: new DisabledFakeProductProvider(), productImageVerifier: new PassingProductVerifier(),
  });
  await firstRuntime.process(packet(fixture.framePath, 'physical-a', 'physical-a-1'));
  await firstRuntime.process(packet(fixture.framePath, 'physical-a', 'physical-a-2'));
  await waitForJobsToSettle(fixture.repository, userId, 1);
  await firstRuntime.endEpisode(userId, 'physical-a');

  const secondRuntime = new AmbientCaptureCoordinator({
    observationProvider: queuedProvider([second, second]), identityProvider,
    repository: fixture.repository, baseClosetItems: () => [], assetService: fixture.assetService,
    productImageProvider: new DisabledFakeProductProvider(), productImageVerifier: new PassingProductVerifier(),
  });
  await secondRuntime.process(packet(fixture.framePath, 'physical-b', 'physical-b-1'));
  await secondRuntime.process(packet(fixture.framePath, 'physical-b', 'physical-b-2'));
  const state = await waitForJobsToSettle(fixture.repository, userId, 2);
  assert.equal(state.closetItems.length, 2);
  assert.equal(new Set(state.closetItems.map((entry) => entry.item.id)).size, 2);
  assert.ok(state.closetItems.every((entry) => entry.appearanceFingerprint === 'same-semantic-fingerprint'));
});

test('pending resolution and current capture reconcile atomically without duplicate wear or capture', async () => {
  const fixture = await createFixture('atomic-pending-reconciliation');
  const changedFrame = await writeFrame(path.join(fixture.directory, 'changed.jpg'), '#263a63', '#c5a66b');
  await fixture.repository.setGrant(userId, true);
  const initial = outfit([
    garment('pending-top', 'top', 'navy', 'navy crew tee'),
    garment('known-pants', 'bottom', 'sand', 'straight trousers'),
  ]);
  const improved = structuredClone(initial);
  improved.garments[0]!.boundingBox = { x: 0.12, y: 0.14, width: 0.72, height: 0.7 };
  let topChecks = 0;
  const identityProvider = {
    ready: true,
    async resolve(input: GarmentIdentityInput): Promise<GarmentIdentityHypothesis> {
      if (input.garment.slot === 'bottom') return {
        observationItemId: input.garment.observationItemId,
        status: 'matched_existing', matchedClosetItemId: 'base-pants',
        appearanceFingerprint: 'pants', confidence: 0.96,
        candidateItemIds: ['base-pants'], reasonCodes: ['FIXTURE_MATCH'],
      };
      topChecks += 1;
      if (topChecks === 1) return ambiguousIdentity(input, true);
      return {
        observationItemId: input.garment.observationItemId,
        status: 'new_to_closet', appearanceFingerprint: 'resolved-top', confidence: 0.94,
        candidateItemIds: [], reasonCodes: ['FIXTURE_NEW_AFTER_RECHECK'],
      };
    },
  };
  const runtime = new AmbientCaptureCoordinator({
    observationProvider: queuedProvider([initial, initial, improved]), identityProvider,
    repository: fixture.repository,
    baseClosetItems: () => [{
      id: 'base-pants', name: 'Sand trousers', category: 'bottom', color: 'sand', fit: 'straight',
      styleTags: ['solid'], formality: 'casual', imageUrl: '/agent-assets/pants.jpg', marketedFor: 'unisex',
    }],
    assetService: fixture.assetService,
    productImageProvider: new DisabledFakeProductProvider(), productImageVerifier: new PassingProductVerifier(),
  });
  await runtime.process(packet(fixture.framePath, 'atomic-pending', 'atomic-1'));
  assert.equal((await runtime.process(packet(fixture.framePath, 'atomic-pending', 'atomic-2'))).status, 'mixed');
  assert.equal((await runtime.process(packet(changedFrame, 'atomic-pending', 'atomic-3'))).status, 'committed_processing_images');
  const state = await waitForJobsToSettle(fixture.repository, userId, 1);
  const resolvedTop = state.closetItems.find((entry) => entry.appearanceFingerprint === 'resolved-top');
  assert.ok(resolvedTop);
  assert.equal(state.captures.filter((capture) => capture.episodeId === state.episodes[0]?.episodeId).length, 1);
  assert.equal(state.captures[0]?.items.filter((item) => item.type === 'pending_identity').length, 0);
  assert.equal(state.wearEvents.filter((wear) => wear.closetItemId === resolvedTop.item.id).length, 1);
  assert.equal(state.wearEvents.filter((wear) => wear.closetItemId === 'base-pants').length, 1);
});

test('first reliable observation retains ephemeral crops and second observation resolves with both frames', async () => {
  const fixture = await createFixture('two-frame-track-evidence');
  await fixture.repository.setGrant(userId, true);
  const observed = outfit([garment('tracked-top', 'top', 'navy', 'crew tee')]);
  const receivedFrameCounts: number[] = [];
  const runtime = new AmbientCaptureCoordinator({
    observationProvider: queuedProvider([observed, observed]),
    identityProvider: {
      ready: true,
      async resolve(input) {
        receivedFrameCounts.push(input.currentAppearances.length);
        return {
          observationItemId: input.garment.observationItemId,
          status: 'ambiguous', appearanceFingerprint: 'two-frame', confidence: 0.5,
          candidateItemIds: [], reasonCodes: ['FIXTURE_AMBIGUOUS'],
        };
      },
    },
    repository: fixture.repository,
    baseClosetItems: () => [], assetService: fixture.assetService,
    productImageProvider: new DisabledFakeProductProvider(),
    productImageVerifier: new PassingProductVerifier(),
  });

  assert.equal((await runtime.process(packet(fixture.framePath, 'two-frame', 'tf1'))).status, 'observing');
  const first = await fixture.repository.getState(userId);
  assert.equal(receivedFrameCounts.length, 0, 'identity resolution must wait for the second reliable observation');
  assert.equal(first.assets.filter((asset) => asset.role === 'track_identity_evidence').length, 1);
  assert.equal(first.episodes.at(-1)?.garmentTracks?.[0]?.identityEvidence.length, 1);

  assert.equal((await runtime.process(packet(fixture.framePath, 'two-frame', 'tf2'))).status, 'mixed');
  assert.deepEqual(receivedFrameCounts, [2]);
  const second = await fixture.repository.getState(userId);
  assert.equal(second.assets.filter((asset) => asset.role === 'track_identity_evidence').length, 2);
  assert.equal(second.episodes.at(-1)?.garmentTracks?.[0]?.identityEvidence.length, 2);
});

test('occlusion ambiguity waits for one genuinely new frame and then stops automatic rechecks', async () => {
  const fixture = await createFixture('occlusion-recheck');
  const changedFrame = await writeFrame(path.join(fixture.directory, 'changed.jpg'), '#23375f', '#c5a66b');
  await fixture.repository.setGrant(userId, true);
  const observed = outfit([garment('occluded-top', 'top', 'navy', 'crew tee')]);
  const observedWithBetterFraming = structuredClone(observed);
  observedWithBetterFraming.garments[0]!.boundingBox = { x: 0.12, y: 0.15, width: 0.72, height: 0.74 };
  let identityCalls = 0;
  const runtime = new AmbientCaptureCoordinator({
    observationProvider: queuedProvider([observed, observed, observedWithBetterFraming, observedWithBetterFraming]),
    identityProvider: {
      ready: true,
      async resolve(input) {
        identityCalls += 1;
        return ambiguousIdentity(input, true);
      },
    },
    repository: fixture.repository,
    baseClosetItems: () => [], assetService: fixture.assetService,
    productImageProvider: new DisabledFakeProductProvider(),
    productImageVerifier: new PassingProductVerifier(),
  });

  await runtime.process(packet(fixture.framePath, 'occlusion-recheck', 'or1'));
  assert.equal((await runtime.process(packet(fixture.framePath, 'occlusion-recheck', 'or2'))).status, 'mixed');
  let state = await fixture.repository.getState(userId);
  assert.equal(identityCalls, 1);
  assert.equal(state.pendingIdentityResolutions[0]?.state, 'awaiting_evidence');
  assert.equal(state.pendingIdentityResolutions[0]?.automaticRecheckCount, 0);

  assert.equal((await runtime.process(packet(changedFrame, 'occlusion-recheck', 'or3'))).status, 'already_committed');
  state = await fixture.repository.getState(userId);
  assert.equal(identityCalls, 2);
  assert.equal(state.pendingIdentityResolutions[0]?.state, 'ready_to_ask');
  assert.equal(state.pendingIdentityResolutions[0]?.automaticRecheckCount, 1);
  assert.equal(state.pendingIdentityResolutions[0]?.currentEvidenceAssetIds.length, 2);
  assert.equal(state.identityDecisionTraces.at(-1)?.automaticRecheckCount, 1);

  assert.equal((await runtime.process(packet(changedFrame, 'occlusion-recheck', 'or4'))).status, 'already_committed');
  assert.equal(identityCalls, 2, 'pending confirmation must block any further automatic verifier call');
});

test('an identical crop cannot trigger an automatic identity recheck', async () => {
  const fixture = await createFixture('same-frame-no-recheck');
  await fixture.repository.setGrant(userId, true);
  const observed = outfit([garment('same-top', 'top', 'navy', 'crew tee')]);
  let identityCalls = 0;
  const runtime = new AmbientCaptureCoordinator({
    observationProvider: queuedProvider([observed, observed, observed]),
    identityProvider: {
      ready: true,
      async resolve(input) {
        identityCalls += 1;
        return ambiguousIdentity(input, true);
      },
    },
    repository: fixture.repository,
    baseClosetItems: () => [], assetService: fixture.assetService,
    productImageProvider: new DisabledFakeProductProvider(),
    productImageVerifier: new PassingProductVerifier(),
  });

  await runtime.process(packet(fixture.framePath, 'same-frame', 'sf1'));
  await runtime.process(packet(fixture.framePath, 'same-frame', 'sf2'));
  const result = await runtime.process(packet(fixture.framePath, 'same-frame', 'sf3'));
  const state = await fixture.repository.getState(userId);
  assert.equal(result.status, 'already_committed');
  assert.equal(identityCalls, 1);
  assert.equal(state.pendingIdentityResolutions[0]?.state, 'awaiting_evidence');
});

test('episode departure retains deferred evidence but chroma-only changes do not consume its recheck', async () => {
  const fixture = await createFixture('deferred-recheck');
  const changedFrame = await writeFrame(path.join(fixture.directory, 'deferred-changed.jpg'), '#29436f', '#c5a66b');
  await fixture.repository.setGrant(userId, true);
  const observed = outfit([garment('deferred-top', 'top', 'navy', 'crew tee')]);
  let identityCalls = 0;
  const identityProvider = {
    ready: true,
    async resolve(input: GarmentIdentityInput) {
      identityCalls += 1;
      return ambiguousIdentity(input, true);
    },
  };
  const firstEpisode = new AmbientCaptureCoordinator({
    observationProvider: queuedProvider([observed, observed]), identityProvider,
    repository: fixture.repository, baseClosetItems: () => [], assetService: fixture.assetService,
    productImageProvider: new DisabledFakeProductProvider(), productImageVerifier: new PassingProductVerifier(),
  });
  await firstEpisode.process(packet(fixture.framePath, 'deferred-one', 'dr1'));
  await firstEpisode.process(packet(fixture.framePath, 'deferred-one', 'dr2'));
  assert.equal((await fixture.repository.getState(userId)).pendingIdentityResolutions[0]?.state, 'awaiting_evidence');
  await firstEpisode.endEpisode(userId, 'deferred-one');
  let state = await new JsonUserWardrobeRepository(path.join(fixture.directory, 'wardrobe.json')).getState(userId);
  assert.equal(state.pendingIdentityResolutions[0]?.state, 'deferred');
  assert.ok((state.pendingIdentityResolutions[0]?.currentEvidenceAssetIds.length ?? 0) > 0);

  const nextEpisode = new AmbientCaptureCoordinator({
    observationProvider: queuedProvider([observed, observed]), identityProvider,
    repository: fixture.repository, baseClosetItems: () => [], assetService: fixture.assetService,
    productImageProvider: new DisabledFakeProductProvider(), productImageVerifier: new PassingProductVerifier(),
  });
  await nextEpisode.process(packet(changedFrame, 'deferred-two', 'dr3'));
  await nextEpisode.process(packet(changedFrame, 'deferred-two', 'dr4'));
  state = await fixture.repository.getState(userId);
  assert.equal(identityCalls, 2);
  assert.equal(state.pendingIdentityResolutions.length, 1);
  assert.equal(state.pendingIdentityResolutions[0]?.state, 'awaiting_evidence');
  assert.equal(state.pendingIdentityResolutions[0]?.automaticRecheckCount, 0);
});

test('cross-episode pending reconnect requires candidate overlap and never guesses among multiple matches', () => {
  const track = {
    trackId: 'new-track', slot: 'bottom' as const, category: 'bottom' as const,
    appearanceFingerprint: 'fingerprint', descriptor: {
      slot: 'bottom' as const, category: 'bottom' as const, dominantColor: 'light gray', secondaryColors: [],
      pattern: 'solid', silhouette: 'straight', fit: 'regular', distinctiveFeatures: ['shorts'],
    },
    firstObservationId: 'new-observation', latestObservationId: 'new-observation', consecutiveMatches: 2,
    identityEvidence: [], maxEvidenceCount: 2,
  };
  const pending = (resolutionId: string, candidateClosetItemIds: string[]): PendingIdentityResolution => ({
    resolutionId, userId, episodeId: 'old-episode', trackId: `old-${resolutionId}`,
    observationItemId: `old-observation-${resolutionId}`, slot: 'bottom', category: 'bottom',
    lockedDescriptor: structuredClone(track.descriptor), currentEvidenceAssetIds: [], evidenceSignatures: [],
    candidateClosetItemIds, candidateHistoryClosetItemIds: candidateClosetItemIds,
    candidateSummaries: [], ambiguityReasonCodes: ['INSUFFICIENT_INSTANCE_EVIDENCE'],
    occludedFeatures: [], automaticRecheckCount: 0, state: 'deferred',
    createdAt: '2026-08-08T10:00:00.000Z', updatedAt: '2026-08-08T10:00:00.000Z',
  });

  assert.equal(findPendingResolutionForTrack(
    [pending('no-overlap', ['pants-a'])], 'new-episode', track, ['pants-b']), undefined);
  assert.equal(findPendingResolutionForTrack(
    [pending('one', ['pants-a']), pending('two', ['pants-a'])], 'new-episode', track, ['pants-a']), undefined);
  assert.equal(findPendingResolutionForTrack(
    [pending('one', ['pants-a'])], 'new-episode', track, ['pants-a'])?.resolutionId, 'one');
  const historyOnly = pending('history-only', ['pants-current']);
  historyOnly.candidateHistoryClosetItemIds = ['pants-current', 'pants-historical'];
  assert.equal(findPendingResolutionForTrack(
    [historyOnly], 'new-episode', track, ['pants-historical']), undefined,
  'audit history must never expand the live reconnect candidate window');
});

test('same-slot garment replacement cannot inherit an incompatible pending resolution', () => {
  const oldDescriptor = {
    slot: 'top' as const, category: 'top' as const, dominantColor: 'black', secondaryColors: [],
    pattern: 'solid', silhouette: 'fitted crew tee', fit: 'regular', distinctiveFeatures: ['plain crew neck'],
  };
  const pending: PendingIdentityResolution = {
    resolutionId: 'pending-black-tee', userId, episodeId: 'same-episode', trackId: 'old-track',
    observationItemId: 'old-black-tee', slot: 'top', category: 'top', lockedDescriptor: oldDescriptor,
    currentEvidenceAssetIds: [], evidenceSignatures: [], candidateClosetItemIds: ['black-tee-a'],
    candidateHistoryClosetItemIds: ['black-tee-a'], candidateSummaries: [],
    ambiguityReasonCodes: ['INSUFFICIENT_INSTANCE_EVIDENCE'], occludedFeatures: [], automaticRecheckCount: 0,
    state: 'awaiting_evidence', createdAt: '2026-08-08T10:00:00.000Z', updatedAt: '2026-08-08T10:00:00.000Z',
  };
  const replacementTrack = {
    trackId: 'new-track', latestObservationItemId: 'striped-white-tee', slot: 'top' as const, category: 'top' as const,
    appearanceFingerprint: 'replacement', descriptor: {
      ...oldDescriptor, dominantColor: 'white', pattern: 'striped', silhouette: 'boxy oversized tee',
      fit: 'oversized', distinctiveFeatures: ['wide blue stripes', 'chest pocket'],
    },
    firstObservationId: 'replacement-observation', latestObservationId: 'replacement-observation',
    consecutiveMatches: 2, identityEvidence: [], maxEvidenceCount: 2,
  };
  assert.equal(findPendingResolutionForTrack([pending], 'same-episode', replacementTrack, ['different-candidate']), undefined);
});

test('exhausted automatic recheck budget survives leaving and returning in a new episode', async () => {
  const fixture = await createFixture('recheck-budget-cross-episode');
  await fixture.repository.setGrant(userId, true);
  const observed = outfit([garment('budget-top', 'top', 'navy', 'navy crew tee')]);
  let identityCalls = 0;
  const identityProvider = {
    ready: true,
    async resolve(input: GarmentIdentityInput) {
      identityCalls += 1;
      return ambiguousIdentity(input, true);
    },
  };
  const baseItem: ClosetItem = {
    id: 'fixture-candidate', name: 'Navy crew tee', category: 'top', color: 'navy', fit: 'regular',
    styleTags: ['solid', 'navy crew tee'], formality: 'casual', imageUrl: '/agent-assets/navy.jpg', marketedFor: 'unisex',
  };
  const firstRuntime = new AmbientCaptureCoordinator({
    observationProvider: queuedProvider([observed, observed]), identityProvider,
    repository: fixture.repository, baseClosetItems: () => [baseItem], assetService: fixture.assetService,
    productImageProvider: new DisabledFakeProductProvider(), productImageVerifier: new PassingProductVerifier(),
  });
  await firstRuntime.process(packet(fixture.framePath, 'budget-first', 'budget-1'));
  await firstRuntime.process(packet(fixture.framePath, 'budget-first', 'budget-2'));
  let state = await fixture.repository.getState(userId);
  const exhausted = state.pendingIdentityResolutions[0]!;
  await fixture.repository.upsertPendingIdentityResolution(userId, {
    ...exhausted, automaticRecheckCount: 1, state: 'ready_to_ask', updatedAt: new Date().toISOString(),
  });
  await firstRuntime.endEpisode(userId, 'budget-first');
  assert.equal((await fixture.repository.getState(userId)).pendingIdentityResolutions[0]?.state, 'deferred');

  const secondRuntime = new AmbientCaptureCoordinator({
    observationProvider: queuedProvider([observed, observed]), identityProvider,
    repository: fixture.repository, baseClosetItems: () => [baseItem], assetService: fixture.assetService,
    productImageProvider: new DisabledFakeProductProvider(), productImageVerifier: new PassingProductVerifier(),
  });
  await secondRuntime.process(packet(fixture.framePath, 'budget-second', 'budget-3'));
  await secondRuntime.process(packet(fixture.framePath, 'budget-second', 'budget-4'));
  state = await fixture.repository.getState(userId);
  assert.equal(identityCalls, 1, 'cheap recall must reconnect before deciding whether another verifier pass is allowed');
  assert.equal(state.pendingIdentityResolutions.length, 1);
  assert.equal(state.pendingIdentityResolutions[0]?.automaticRecheckCount, 1);
  assert.equal(state.pendingIdentityResolutions[0]?.state, 'ready_to_ask');
});

test('expired pending identity remains auditable but cannot reconnect', async () => {
  const fixture = await createFixture('pending-expiration');
  const descriptor = {
    slot: 'bottom' as const, category: 'bottom' as const, dominantColor: 'gray', secondaryColors: [],
    pattern: 'solid', silhouette: 'straight shorts', fit: 'straight', distinctiveFeatures: ['stitched hem'],
  };
  const pending: PendingIdentityResolution = {
    resolutionId: 'expired-pending', userId, episodeId: 'old-episode', trackId: 'old-track',
    observationItemId: 'old-shorts', slot: 'bottom', category: 'bottom', lockedDescriptor: descriptor,
    currentEvidenceAssetIds: [], evidenceSignatures: [], candidateClosetItemIds: ['gray-shorts'],
    candidateHistoryClosetItemIds: ['gray-shorts'], candidateSummaries: [], ambiguityReasonCodes: ['INSUFFICIENT_INSTANCE_EVIDENCE'],
    occludedFeatures: [], automaticRecheckCount: 0, state: 'deferred',
    createdAt: '2026-08-08T10:00:00.000Z', updatedAt: '2026-08-08T10:00:00.000Z',
    deadlineAt: '2026-08-08T10:05:00.000Z',
  };
  await fixture.repository.upsertPendingIdentityResolution(userId, pending);
  assert.equal(await fixture.repository.expirePendingIdentityResolutions(userId, '2026-08-08T10:06:00.000Z'), 1);
  const state = await fixture.repository.getState(userId);
  assert.equal(state.pendingIdentityResolutions[0]?.state, 'expired');
  const track = {
    trackId: 'new-track', latestObservationItemId: 'new-shorts', slot: 'bottom' as const, category: 'bottom' as const,
    appearanceFingerprint: 'gray-shorts', descriptor, firstObservationId: 'new-observation', latestObservationId: 'new-observation',
    consecutiveMatches: 2, identityEvidence: [], maxEvidenceCount: 2,
  };
  assert.equal(findPendingResolutionForTrack(state.pendingIdentityResolutions, 'new-episode', track, ['gray-shorts'], '2026-08-08T10:06:00.000Z'), undefined);
});

test('garment track assignment consumes each prior track at most once', () => {
  const descriptor = {
    slot: 'accessory' as const, category: 'accessory' as const, dominantColor: 'silver', secondaryColors: [],
    pattern: 'solid', silhouette: 'small metal accessory', fit: 'unknown', distinctiveFeatures: ['metal band'],
  };
  const previousTracks = ['track-a', 'track-b'].map((trackId) => ({
    trackId, slot: 'accessory' as const, category: 'accessory' as const, appearanceFingerprint: 'same', descriptor,
    firstObservationId: trackId, latestObservationId: trackId, consecutiveMatches: 1, identityEvidence: [], maxEvidenceCount: 2,
  }));
  const accessory = (observationItemId: string, x: number): WornGarmentObservation => ({
    ...garment(observationItemId, 'top', 'silver', 'small metal accessory'),
    observationItemId, slot: 'accessory', category: 'accessory', pattern: 'solid', silhouette: 'small metal accessory',
    fit: 'unknown', distinctiveFeatures: ['metal band'], boundingBox: { x, y: 0.3, width: 0.12, height: 0.12 },
  });
  const tracks = updateGarmentTracks(previousTracks, outfit([accessory('watch', 0.2), accessory('bracelet', 0.65)]));
  assert.deepEqual(new Set(tracks.map((track) => track.trackId)), new Set(['track-a', 'track-b']));
  assert.equal(new Set(tracks.map((track) => track.latestObservationItemId)).size, 2);
});

test('same-slot garment tracks retain the crop for their exact observation item', async () => {
  const fixture = await createFixture('same-slot-evidence-binding');
  const framePath = path.join(fixture.directory, 'same-slot.jpg');
  await sharp({ create: { width: 1280, height: 960, channels: 3, background: '#f4f0e8' } })
    .composite([
      { input: await sharp({ create: { width: 260, height: 260, channels: 3, background: '#b91c1c' } }).png().toBuffer(), left: 180, top: 320 },
      { input: await sharp({ create: { width: 260, height: 260, channels: 3, background: '#1d4ed8' } }).png().toBuffer(), left: 840, top: 320 },
    ])
    .jpeg({ quality: 94 })
    .toFile(framePath);
  await fixture.repository.setGrant(userId, true);
  const accessory = (observationItemId: string, x: number, color: string): WornGarmentObservation => ({
    ...garment(observationItemId, 'top', color, `${color} accessory`),
    observationItemId,
    slot: 'accessory',
    category: 'accessory',
    boundingBox: { x, y: 0.32, width: 0.22, height: 0.3 },
  });
  const observed = outfit([
    accessory('left-red-accessory', 0.13, 'red'),
    accessory('right-blue-accessory', 0.65, 'blue'),
  ]);
  const runtime = new AmbientCaptureCoordinator({
    observationProvider: queuedProvider([observed]),
    identityProvider: new VisualGarmentIdentityProvider({ verifier: new PixelGarmentVerifier() }),
    repository: fixture.repository,
    baseClosetItems: () => [],
    assetService: fixture.assetService,
    productImageProvider: new DisabledFakeProductProvider(),
    productImageVerifier: new PassingProductVerifier(),
  });

  assert.equal((await runtime.process(packet(framePath, 'same-slot', 'same-slot-1'))).status, 'observing');
  const state = await fixture.repository.getState(userId);
  const tracks = state.episodes[0]?.garmentTracks ?? [];
  assert.equal(tracks.length, 2);
  const evidenceAssets = tracks.map((track) => {
    const assetId = track.identityEvidence.at(-1)?.assetId;
    return {
      track,
      asset: state.assets.find((asset) => asset.assetId === assetId),
    };
  });
  assert.deepEqual(
    evidenceAssets.map(({ track, asset }) => [track.latestObservationItemId, asset?.observationItemId]),
    [
      ['left-red-accessory', 'left-red-accessory'],
      ['right-blue-accessory', 'right-blue-accessory'],
    ],
  );
  assert.notEqual(evidenceAssets[0]?.asset?.contentHash, evidenceAssets[1]?.asset?.contentHash);
});

test('terminal cross-episode pending identity evidence is garbage-collected', async () => {
  const fixture = await createFixture('cross-episode-evidence-gc');
  const old = (await fixture.assetService.cropGarment({
    userId,
    sourceFramePath: fixture.framePath,
    sourceFrameId: 'old-frame',
    observationItemId: 'old-bottom',
    boundingBox: garment('old-bottom', 'bottom', 'gray', 'gray shorts').boundingBox,
    slot: 'bottom',
    role: 'track_identity_evidence',
  })).asset;
  const current = (await fixture.assetService.cropGarment({
    userId,
    sourceFramePath: fixture.framePath,
    sourceFrameId: 'current-frame',
    observationItemId: 'current-bottom',
    boundingBox: garment('current-bottom', 'bottom', 'gray', 'gray shorts').boundingBox,
    slot: 'bottom',
    role: 'track_identity_evidence',
  })).asset;
  const descriptor = {
    slot: 'bottom' as const,
    category: 'bottom' as const,
    dominantColor: 'gray',
    secondaryColors: [],
    pattern: 'solid',
    silhouette: 'gray shorts',
    fit: 'straight',
    distinctiveFeatures: ['gray shorts'],
  };
  await fixture.repository.persistTrackEvidence(userId, {
    episodeId: 'old-episode', sessionId: 'old-session', status: 'ended',
    startedAt: '2026-08-08T10:00:00.000Z', endedAt: '2026-08-08T10:02:00.000Z',
    consecutiveReliableObservations: 2,
    garmentTracks: [{
      trackId: 'old-track', latestObservationItemId: 'old-bottom', slot: 'bottom', category: 'bottom',
      appearanceFingerprint: 'gray-shorts', descriptor, firstObservationId: 'old-observation',
      latestObservationId: 'old-observation', consecutiveMatches: 2,
      identityEvidence: [{
        observationId: 'old-observation', frameId: 'old-frame', assetId: old.assetId,
        capturedAt: '2026-08-08T10:01:00.000Z', descriptor,
        boundingBox: garment('old-bottom', 'bottom', 'gray', 'gray shorts').boundingBox,
        coverage: 'full_body',
      }], maxEvidenceCount: 2,
    }],
  }, [old]);
  await fixture.repository.persistTrackEvidence(userId, {
    episodeId: 'current-episode', sessionId: 'current-session', status: 'ended',
    startedAt: '2026-08-08T10:03:00.000Z', endedAt: '2026-08-08T10:05:00.000Z',
    consecutiveReliableObservations: 2,
    garmentTracks: [{
      trackId: 'current-track', latestObservationItemId: 'current-bottom', slot: 'bottom', category: 'bottom',
      appearanceFingerprint: 'gray-shorts', descriptor, firstObservationId: 'current-observation',
      latestObservationId: 'current-observation', consecutiveMatches: 2,
      identityEvidence: [{
        observationId: 'current-observation', frameId: 'current-frame', assetId: current.assetId,
        capturedAt: '2026-08-08T10:04:00.000Z', descriptor,
        boundingBox: garment('current-bottom', 'bottom', 'gray', 'gray shorts').boundingBox,
        coverage: 'full_body',
      }], maxEvidenceCount: 2,
    }],
  }, [current]);
  await fixture.repository.upsertPendingIdentityResolution(userId, {
    resolutionId: 'cross-episode-pending', userId, episodeId: 'old-episode', trackId: 'old-track',
    observationItemId: 'old-bottom', slot: 'bottom', category: 'bottom', lockedDescriptor: descriptor,
    currentEvidenceAssetIds: [old.assetId, current.assetId], evidenceSignatures: [],
    candidateClosetItemIds: ['gray-shorts'], candidateHistoryClosetItemIds: ['gray-shorts'],
    candidateSummaries: [], ambiguityReasonCodes: ['INSUFFICIENT_INSTANCE_EVIDENCE'], occludedFeatures: [],
    automaticRecheckCount: 1, state: 'ready_to_ask', createdAt: '2026-08-08T10:01:00.000Z',
    updatedAt: '2026-08-08T10:04:00.000Z', deadlineAt: '2026-08-08T10:10:00.000Z',
  });
  await fixture.repository.resolvePendingIdentity({
    userId, resolutionId: 'cross-episode-pending', closetItemId: 'gray-shorts', state: 'resolved_existing',
    occurredAt: '2026-08-08T10:06:00.000Z',
  });
  const removed = await fixture.repository.pruneOrphanTrackIdentityEvidence(userId, '2026-08-08T10:06:01.000Z');
  await fixture.assetService.deleteAssets(removed);

  const state = await fixture.repository.getState(userId);
  assert.deepEqual(new Set(removed.map((asset) => asset.assetId)), new Set([old.assetId, current.assetId]));
  assert.equal(state.assets.some((asset) => asset.role === 'track_identity_evidence'), false);
  assert.equal(state.pendingIdentityResolutions[0]?.currentEvidenceAssetIds.length, 0);
  assert.equal(state.pendingIdentityResolutions[0]?.state, 'resolved_existing');
  await assert.rejects(() => fs.access(old.storagePath!));
  await assert.rejects(() => fs.access(current.storagePath!));
});

test('expired pending identity evidence is garbage-collected while structured history remains', async () => {
  const fixture = await createFixture('expired-evidence-gc');
  const evidence = (await fixture.assetService.cropGarment({
    userId,
    sourceFramePath: fixture.framePath,
    sourceFrameId: 'expired-frame',
    observationItemId: 'expired-bottom',
    boundingBox: garment('expired-bottom', 'bottom', 'gray', 'gray shorts').boundingBox,
    slot: 'bottom',
    role: 'track_identity_evidence',
  })).asset;
  const descriptor = {
    slot: 'bottom' as const, category: 'bottom' as const, dominantColor: 'gray', secondaryColors: [],
    pattern: 'solid', silhouette: 'gray shorts', fit: 'straight', distinctiveFeatures: ['gray shorts'],
  };
  await fixture.repository.persistTrackEvidence(userId, {
    episodeId: 'expired-episode', sessionId: 'expired-session', status: 'ended',
    startedAt: '2026-08-08T10:00:00.000Z', endedAt: '2026-08-08T10:01:00.000Z',
    consecutiveReliableObservations: 2, garmentTracks: [],
  }, [evidence]);
  await fixture.repository.upsertPendingIdentityResolution(userId, {
    resolutionId: 'expiring-pending', userId, episodeId: 'expired-episode', trackId: 'expired-track',
    observationItemId: 'expired-bottom', slot: 'bottom', category: 'bottom', lockedDescriptor: descriptor,
    currentEvidenceAssetIds: [evidence.assetId], evidenceSignatures: [{
      assetId: evidence.assetId, perceptualHash: evidence.perceptualHash,
      boundingBox: garment('expired-bottom', 'bottom', 'gray', 'gray shorts').boundingBox,
      descriptor, coverage: 'full_body',
    }], candidateClosetItemIds: ['gray-shorts'], candidateHistoryClosetItemIds: ['gray-shorts'],
    candidateSummaries: [], ambiguityReasonCodes: ['INSUFFICIENT_INSTANCE_EVIDENCE'], occludedFeatures: [],
    automaticRecheckCount: 0, state: 'deferred', createdAt: '2026-08-08T10:00:00.000Z',
    updatedAt: '2026-08-08T10:00:00.000Z', deadlineAt: '2026-08-08T10:05:00.000Z',
  });
  assert.equal(await fixture.repository.expirePendingIdentityResolutions(userId, '2026-08-08T10:06:00.000Z'), 1);
  const removed = await fixture.repository.pruneOrphanTrackIdentityEvidence(userId, '2026-08-08T10:06:01.000Z');
  await fixture.assetService.deleteAssets(removed);

  const state = await fixture.repository.getState(userId);
  assert.equal(state.pendingIdentityResolutions[0]?.state, 'expired');
  assert.equal(state.pendingIdentityResolutions[0]?.currentEvidenceAssetIds.length, 0);
  assert.equal(state.pendingIdentityResolutions[0]?.evidenceSignatures.length, 1);
  assert.equal(state.assets.some((asset) => asset.assetId === evidence.assetId), false);
  await assert.rejects(() => fs.access(evidence.storagePath!));
});

test('episode end and privacy pause remove orphan track evidence', async () => {
  const endedFixture = await createFixture('episode-evidence-cleanup');
  await endedFixture.repository.setGrant(userId, true);
  const observed = outfit([garment('cleanup-top', 'top', 'navy', 'crew tee')]);
  const endedRuntime = new AmbientCaptureCoordinator({
    observationProvider: queuedProvider([observed]),
    identityProvider: new VisualGarmentIdentityProvider({ verifier: new PixelGarmentVerifier() }),
    repository: endedFixture.repository,
    baseClosetItems: () => [], assetService: endedFixture.assetService,
    productImageProvider: new DisabledFakeProductProvider(), productImageVerifier: new PassingProductVerifier(),
  });
  await endedRuntime.process(packet(endedFixture.framePath, 'cleanup-ended', 'ce1'));
  assert.equal((await endedFixture.repository.getState(userId)).assets.length, 1);
  await endedRuntime.endEpisode(userId, 'cleanup-ended');
  let state = await endedFixture.repository.getState(userId);
  assert.equal(state.assets.filter((asset) => asset.role === 'track_identity_evidence').length, 0);
  assert.equal(state.episodes.at(-1)?.garmentTracks?.[0]?.identityEvidence.length, 0);

  const privacyFixture = await createFixture('privacy-evidence-cleanup');
  await privacyFixture.repository.setGrant(userId, true);
  const privacyObservation = { ...observed, observationId: 'privacy-observation', personCount: 2 };
  const privacyRuntime = new AmbientCaptureCoordinator({
    observationProvider: queuedProvider([observed, privacyObservation]),
    identityProvider: new VisualGarmentIdentityProvider({ verifier: new PixelGarmentVerifier() }),
    repository: privacyFixture.repository,
    baseClosetItems: () => [], assetService: privacyFixture.assetService,
    productImageProvider: new DisabledFakeProductProvider(), productImageVerifier: new PassingProductVerifier(),
  });
  await privacyRuntime.process(packet(privacyFixture.framePath, 'cleanup-privacy', 'cp1'));
  assert.equal((await privacyFixture.repository.getState(userId)).assets.length, 1);
  assert.equal((await privacyRuntime.process(packet(privacyFixture.framePath, 'cleanup-privacy', 'cp2'))).status, 'privacy_paused');
  state = await privacyFixture.repository.getState(userId);
  assert.equal(state.assets.filter((asset) => asset.role === 'track_identity_evidence').length, 0);
});

test('capture without product providers commits evidence but never promotes a crop as primary image', async () => {
  const fixture = await createFixture('provider-disabled');
  await fixture.repository.setGrant(userId, true);
  const observed = outfit([
    garment('top', 'top', 'navy', 'crew tee'),
    garment('bottom', 'bottom', 'sand', 'straight trousers'),
  ]);
  const runtime = new AmbientCaptureCoordinator({
    observationProvider: queuedProvider([observed, observed]),
    identityProvider: new VisualGarmentIdentityProvider({ verifier: new PixelGarmentVerifier() }),
    repository: fixture.repository,
    baseClosetItems: () => [], assetService: fixture.assetService,
    productImageProvider: new DisabledFakeProductProvider(),
    productImageVerifier: { ready: false, async verify() { return failedVerification('disabled'); } },
  });
  await runtime.process(packet(fixture.framePath, 'disabled-provider', 'p1'));
  assert.equal((await runtime.process(packet(fixture.framePath, 'disabled-provider', 'p2'))).status, 'committed_processing_images');
  const state = await waitForJobsToSettle(fixture.repository, userId, 2);
  assert.ok(state.closetItems.every((entry) => entry.item.imageStatus === 'needs_review'));
  assert.ok(state.closetItems.every((entry) => entry.item.identityStatus === 'provisional'));
  assert.ok(state.closetItems.every((entry) => entry.item.ownershipStatus === 'unverified'));
  assert.ok(state.closetItems.every((entry) => !entry.item.primaryImageAssetId));
  assert.ok(state.closetItems.every((entry) => entry.item.imageUrl === '/agent-assets/wardrobe-processing.svg'));
  assert.equal(state.assets.filter((asset) => asset.role === 'canonical_product').length, 0);
});

test('critical product mismatch blocks primary image promotion despite high confidence', async () => {
  const fixture = await createFixture('critical-product-mismatch');
  await fixture.repository.setGrant(userId, true);
  const observed = outfit([
    garment('top', 'top', 'navy', 'crew tee'),
    garment('bottom', 'bottom', 'sand', 'straight trousers'),
  ]);
  const runtime = new AmbientCaptureCoordinator({
    observationProvider: queuedProvider([observed, observed]),
    identityProvider: new VisualGarmentIdentityProvider({ verifier: new PixelGarmentVerifier() }),
    repository: fixture.repository,
    baseClosetItems: () => [],
    assetService: fixture.assetService,
    productImageProvider: new EditingFakeProductProvider(fixture.assetService, []),
    productImageVerifier: {
      ready: true,
      async verify() {
        return {
          result: 'pass', confidence: 0.99,
          checks: { colorMatch: false, patternMatch: true },
          mismatches: ['main color changed'], notes: [],
        };
      },
    },
  });
  await runtime.process(packet(fixture.framePath, 'critical-mismatch', 'm1'));
  await runtime.process(packet(fixture.framePath, 'critical-mismatch', 'm2'));
  const state = await waitForJobsToSettle(fixture.repository, userId, 2);
  assert.ok(state.closetItems.every((entry) => entry.item.imageStatus === 'needs_review'));
  assert.ok(state.closetItems.every((entry) => entry.item.identityStatus === 'provisional'));
  assert.ok(state.closetItems.every((entry) => entry.item.ownershipStatus === 'unverified'));
  assert.ok(state.closetItems.every((entry) => !entry.item.primaryImageAssetId));
  assert.ok(state.assets.filter((asset) => asset.role === 'canonical_product')
    .every((asset) => asset.verificationStatus === 'failed'));
  const reloaded = await new JsonUserWardrobeRepository(path.join(fixture.directory, 'wardrobe.json')).getState(userId);
  assert.ok(reloaded.closetItems.every((entry) => entry.item.identityStatus === 'provisional'));
  assert.ok(reloaded.closetItems.every((entry) => entry.item.ownershipStatus === 'unverified'));
  assert.ok(reloaded.closetItems.every((entry) => entry.item.imageStatus === 'needs_review'));
});

test('capture remains silent without grant and stale packets do not call vision', async () => {
  const fixture = await createFixture('guard');
  let calls = 0;
  const provider: OutfitObservationProvider = { ready: true, async analyze() { calls += 1; return outfit([]); } };
  const runtime = new AmbientCaptureCoordinator({
    observationProvider: provider,
    identityProvider: new VisualGarmentIdentityProvider({ verifier: new PixelGarmentVerifier() }),
    repository: fixture.repository,
    baseClosetItems: () => [], assetService: fixture.assetService,
    productImageProvider: new DisabledFakeProductProvider(), productImageVerifier: new PassingProductVerifier(),
  });
  assert.equal((await runtime.process(packet(fixture.framePath, 'no-grant', 'g1'))).status, 'disabled');
  assert.equal(calls, 0);
  await fixture.repository.setGrant(userId, true);
  const stale = packet(fixture.framePath, 'stale', 'g2');
  stale.capturedAt = new Date(Date.now() - 30_000).toISOString();
  assert.equal((await runtime.process(stale)).status, 'insufficient_evidence');
  assert.equal(calls, 0);
});

test('reset deletes only the selected browser identity assets and state', async () => {
  const fixture = await createFixture('reset');
  const observed = outfit([
    garment('top', 'top', 'navy', 'crew tee'),
    garment('bottom', 'bottom', 'sand', 'straight trousers'),
  ]);
  await fixture.repository.setGrant('user-a', true);
  await fixture.repository.setGrant('user-b', true);
  const calls: ProductImageGenerationInput[] = [];
  const runtimeA = coordinator({ repository: fixture.repository, assetService: fixture.assetService, observations: [observed, observed], productCalls: calls });
  const runtimeB = coordinator({ repository: fixture.repository, assetService: fixture.assetService, observations: [observed, observed], productCalls: calls });
  await runtimeA.process({ ...packet(fixture.framePath, 'reset-a', 'a1'), userId: 'user-a' });
  await runtimeA.process({ ...packet(fixture.framePath, 'reset-a', 'a2'), userId: 'user-a' });
  await waitForImages(fixture.repository, 'user-a', 2);
  await runtimeB.process({ ...packet(fixture.framePath, 'reset-b', 'b1'), userId: 'user-b' });
  await runtimeB.process({ ...packet(fixture.framePath, 'reset-b', 'b2'), userId: 'user-b' });
  await waitForImages(fixture.repository, 'user-b', 2);
  const userBAssets = (await fixture.repository.getState('user-b')).assets.map((asset) => asset.storagePath).filter(Boolean) as string[];
  await runtimeA.resetUser('user-a');
  assert.equal((await fixture.repository.getState('user-a')).assets.length, 0);
  assert.equal((await fixture.repository.getState('user-b')).closetItems.length, 2);
  for (const assetPath of userBAssets) await fs.access(assetPath);
});

function coordinator(input: {
  repository: JsonUserWardrobeRepository;
  assetService: GarmentImageAssetService;
  observations: WornOutfitObservation[];
  productCalls: ProductImageGenerationInput[];
}): AmbientCaptureCoordinator {
  return new AmbientCaptureCoordinator({
    observationProvider: queuedProvider(input.observations),
    identityProvider: new VisualGarmentIdentityProvider({ verifier: new PixelGarmentVerifier() }),
    repository: input.repository,
    baseClosetItems: () => [],
    assetService: input.assetService,
    productImageProvider: new EditingFakeProductProvider(input.assetService, input.productCalls),
    productImageVerifier: new PassingProductVerifier(),
  });
}

class PixelGarmentVerifier implements GarmentVisualVerifier {
  readonly ready = true;
  async verifyPair(input: Parameters<GarmentVisualVerifier['verifyPair']>[0]) {
    const current = await averageRgb(input.currentAppearances.at(-1)!);
    const references = input.candidate.referenceAppearances.length
      ? input.candidate.referenceAppearances
      : input.candidate.catalogFallbackImage ? [input.candidate.catalogFallbackImage] : [];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const reference of references) {
      bestDistance = Math.min(bestDistance, colorDistance(current, await averageRgb(reference)));
    }
    return bestDistance < 20 ? pairwise('same', 0.97) : pairwise('different', 0.96);
  }
}

function pairwise(verdict: 'same' | 'different', confidence: number) {
  return {
    verdict,
    confidence,
    featureComparisons: [{
      feature: 'pocket_geometry' as const,
      currentVisibility: 'visible' as const,
      referenceVisibility: 'visible' as const,
      relation: verdict,
      discriminativeStrength: 'strong' as const,
      note: 'pixel fixture',
    }],
    occlusions: [],
    jointlyVisibleEvidence: ['pixel fixture'],
    model: 'pixel-fixture',
  };
}

function ambiguousIdentity(input: GarmentIdentityInput, occluded: boolean): GarmentIdentityHypothesis {
  const comparison = {
    feature: 'waistband_construction' as const,
    currentVisibility: occluded ? 'not_visible' as const : 'visible' as const,
    referenceVisibility: 'visible' as const,
    relation: 'unknown' as const,
    discriminativeStrength: 'strong' as const,
    note: occluded ? 'waistband is covered in the current frame' : 'visible but not distinctive enough',
  };
  const pairwiseResult = {
    verdict: 'uncertain' as const,
    confidence: 0.62,
    featureComparisons: [comparison],
    currentFrameEvidence: input.currentAppearances.map((_, frameIndex) => ({
      frameIndex,
      featureComparisons: [comparison],
    })),
    temporalEvidenceConsistency: 'insufficient' as const,
    occlusions: occluded ? ['waistband'] : [],
    jointlyVisibleEvidence: [],
    model: 'pending-fixture',
  };
  const decisionTrace: GarmentIdentityDecisionTrace = {
    traceId: `trace-${input.garment.observationItemId}-${input.currentAppearances.at(-1)?.assetId}`,
    episodeId: input.episodeId ?? 'episode-fixture',
    observationItemId: input.garment.observationItemId,
    currentAppearanceAssetId: input.currentAppearances.at(-1)!.assetId,
    currentAppearanceAssetIds: input.currentAppearances.map((asset) => asset.assetId),
    recall: {
      strategy: 'metadata',
      candidates: [{
        closetItemId: 'fixture-candidate', source: 'user', metadataScore: 0.7,
        continuityPrior: 0, effectivePrior: 0.7, tier: 'plausible', categoryCompatibility: 'exact',
        referenceEvidenceType: 'historical_appearance', referenceAssetIds: ['fixture-reference'],
        softContradictions: [],
      }],
    },
    pairwiseVerifications: [{
      candidateClosetItemId: 'fixture-candidate', evaluation: 'verified', rawResult: pairwiseResult,
      normalizedResult: pairwiseResult, serverDowngradeReasons: [], requiredDifferentConfidence: 0.83,
      autoCreateVeto: false, referenceEvidenceType: 'historical_appearance', evidenceTaxonomyVersion: 1,
      classLevelSameFeatures: [], instanceSpecificSameFeatures: [], safeSameGateResult: false,
      safeSameRejectReasons: ['VERDICT_NOT_SAME'], multiFrameEvidenceCount: input.currentAppearances.length,
      temporalEvidenceConsistency: 'insufficient', model: 'pending-fixture', latencyMs: 1,
    }],
    thresholds: { matchConfidence: 0.88, baseNewConfidence: 0.78, strongPriorVeto: 0.85 },
    finalDecision: 'ambiguous', reasonCodes: ['FIXTURE_AMBIGUOUS'],
    promptVersion: 'fixture-v1', schemaVersion: 1,
    createdAt: input.capturedAt ?? new Date(0).toISOString(),
  };
  return {
    observationItemId: input.garment.observationItemId,
    status: 'ambiguous', appearanceFingerprint: 'pending-fixture', confidence: 0.62,
    candidateItemIds: ['fixture-candidate'], reasonCodes: ['FIXTURE_AMBIGUOUS'], decisionTrace,
  };
}

class EditingFakeProductProvider implements ProductImageProvider {
  readonly ready = true;
  constructor(
    private readonly assetService: GarmentImageAssetService,
    private readonly calls: ProductImageGenerationInput[],
  ) {}
  async createCanonicalProductImage(input: ProductImageGenerationInput) {
    this.calls.push(input);
    assert.equal(input.sourceAppearance.role, 'garment_appearance');
    const source = await fs.readFile(input.sourceAppearance.storagePath!);
    const bytes = await sharp(source)
      .resize(512, 512, { fit: 'contain', background: '#f7f7f3' })
      .webp({ quality: 90 })
      .toBuffer();
    const asset = await this.assetService.storeProductImage({
      userId: input.userId,
      closetItemId: input.closetItemId,
      sourceAsset: input.sourceAppearance,
      bytes,
      mimeType: 'image/webp',
    });
    return { asset, provider: 'fake-image-edit', model: 'fixture-edit' };
  }
}

class DisabledFakeProductProvider implements ProductImageProvider {
  readonly ready = false;
  async createCanonicalProductImage(): Promise<never> { throw new Error('disabled'); }
}

class PassingProductVerifier implements ProductImageVerifier {
  readonly ready = true;
  async verify(input: Parameters<ProductImageVerifier['verify']>[0]): Promise<ProductImageVerification> {
    assert.equal(input.sourceAppearance.role, 'garment_appearance');
    assert.equal(input.generatedProductImage.role, 'canonical_product');
    return {
      result: 'pass', confidence: 0.99,
      checks: {
        colorMatch: true, patternMatch: true, necklineMatch: true, sleeveMatch: true,
        closureMatch: true, pocketMatch: true, silhouetteMatch: true, lengthMatch: true, logoMatch: true,
      },
      mismatches: [], notes: ['fixture verification'],
    };
  }
}

async function createFixture(name: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `muse-ambient-${name}-`));
  const framePath = await writeFrame(path.join(directory, 'frame.jpg'), '#17233b', '#c5a66b');
  return {
    directory,
    framePath,
    repository: new JsonUserWardrobeRepository(path.join(directory, 'wardrobe.json')),
    assetService: new GarmentImageAssetService({ rootDirectory: path.join(directory, 'out') }),
  };
}

async function writeFrame(filePath: string, topColor: string, bottomColor: string): Promise<string> {
  const width = 1280;
  const height = 960;
  const image = sharp({ create: { width, height, channels: 3, background: '#e7e2d9' } });
  const top = await sharp({ create: { width: 640, height: 360, channels: 3, background: topColor } })
    .composite([{ input: Buffer.from('<svg width="640" height="360"><path d="M0 50 L180 0 L320 80 L460 0 L640 50 L600 360 L40 360 Z" fill="none" stroke="#f8f8f0" stroke-width="14"/></svg>') }])
    .png().toBuffer();
  const bottom = await sharp({ create: { width: 564, height: 403, channels: 3, background: bottomColor } })
    .composite([{ input: Buffer.from('<svg width="564" height="403"><path d="M282 0 V403 M20 70 H544" stroke="#4a4035" stroke-width="10"/></svg>') }])
    .png().toBuffer();
  await image.composite([
    { input: top, left: 320, top: 190 },
    { input: bottom, left: 358, top: 500 },
  ]).jpeg({ quality: 92 }).toFile(filePath);
  return filePath;
}

async function averageRgb(asset: GarmentImageAsset): Promise<[number, number, number]> {
  const stats = await sharp(asset.storagePath!).stats();
  return [stats.channels[0]!.mean, stats.channels[1]!.mean, stats.channels[2]!.mean];
}

function colorDistance(left: [number, number, number], right: [number, number, number]): number {
  return Math.sqrt(left.reduce((sum, value, index) => sum + (value - right[index]!) ** 2, 0));
}

async function waitForImages(repository: JsonUserWardrobeRepository, owner: string, expectedReady: number) {
  const state = await waitForState(repository, owner, (value) =>
    value.closetItems.filter((entry) => entry.item.imageStatus === 'ready').length === expectedReady &&
    value.productImageJobs.length >= expectedReady &&
    value.productImageJobs.every((job) => job.status === 'ready') &&
    Boolean(value.pendingCompletionEvent)
  );
  return state;
}

async function waitForJobsToSettle(repository: JsonUserWardrobeRepository, owner: string, expectedJobs = 1) {
  return waitForState(repository, owner, (value) =>
    value.productImageJobs.length >= expectedJobs &&
    value.productImageJobs.every((job) => job.status !== 'processing')
  );
}

async function waitForState(
  repository: JsonUserWardrobeRepository,
  owner: string,
  predicate: (state: Awaited<ReturnType<JsonUserWardrobeRepository['getState']>>) => boolean,
) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const state = await repository.getState(owner);
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('Timed out waiting for ambient image pipeline.');
}

function failedVerification(reason: string): ProductImageVerification {
  return { result: 'fail', confidence: 0, checks: { colorMatch: false, patternMatch: false }, mismatches: [reason], notes: [] };
}

function queuedProvider(observations: WornOutfitObservation[]): OutfitObservationProvider {
  const queue = [...observations];
  return {
    ready: true,
    async analyze() {
      const next = queue.shift();
      if (!next) throw new Error('Fixture provider exhausted.');
      return structuredClone(next);
    },
  };
}

function packet(imagePath: string, sessionId: string, frameId: string): AmbientCapturePacket {
  return {
    packetId: `packet_${frameId}`,
    userId,
    sessionId,
    frameId,
    capturedAt: new Date().toISOString(),
    imagePath,
    imageMimeType: 'image/jpeg',
    activeTask: false,
    stability: { score: 0.98, stableSamples: 3, sampleIntervalMs: 1200, sourceWidth: 1280, sourceHeight: 960 },
  };
}

function garment(id: string, slot: 'top' | 'bottom', color: string, description: string): WornGarmentObservation {
  return {
    observationItemId: id,
    slot,
    category: slot,
    description,
    dominantColor: color,
    secondaryColors: [],
    pattern: 'solid',
    silhouette: description,
    fit: slot === 'top' ? 'regular' : 'straight',
    distinctiveFeatures: [description],
    boundingBox: slot === 'top'
      ? { x: 0.25, y: 0.2, width: 0.5, height: 0.35 }
      : { x: 0.28, y: 0.52, width: 0.44, height: 0.42 },
    confidence: 0.94,
    uncertainties: [],
  };
}

let observationSequence = 0;

function outfit(garments: WornGarmentObservation[]): WornOutfitObservation {
  observationSequence += 1;
  return {
    observationId: `observation_${observationSequence}`,
    provider: 'test-real-contract',
    model: 'fixture',
    analyzedAt: new Date().toISOString(),
    personCount: 1,
    coverage: 'full_body',
    quality: 'good',
    garments,
    uncertainties: [],
  };
}

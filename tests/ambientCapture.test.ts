import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import type {
  AmbientCapturePacket,
  GarmentImageAsset,
  ProductImageVerification,
  WornGarmentObservation,
  WornOutfitObservation,
} from '../src/domain/ambientCapture.js';
import { AmbientCaptureCoordinator } from '../src/runtime/ambientCaptureCoordinator.js';
import { GarmentImageAssetService } from '../src/services/garmentImageAssetService.js';
import { VisualGarmentIdentityProvider } from '../src/services/garmentIdentityProvider.js';
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
    async verify(input) {
      candidateIds = input.candidates.map((candidate) => candidate.closetItem.id);
      return { result: 'same', matchedClosetItemId: baseItem.id, confidence: 0.96, evidence: ['visual match'], mismatches: [] };
    },
  };
  const provider = new VisualGarmentIdentityProvider({ verifier });
  const result = await provider.resolve({
    userId,
    garment: garment('observed', 'top', 'navy', 'short sleeve crew neck tee'),
    currentAppearance: current,
    baseClosetItems: [baseItem],
    userClosetItems: [], appearances: [], assets: [],
    baseCatalogAssets: new Map([[baseItem.id, baseAsset]]),
  });
  assert.deepEqual(candidateIds, [baseItem.id]);
  assert.equal(result.status, 'matched_existing');
  assert.equal(result.matchedClosetItemId, baseItem.id);
});

test('visual verifier rejects a model-selected ID outside the recalled allowlist', async () => {
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
  const result = await verifier.verify({
    currentAppearance: current,
    candidates: [{
      closetItem: {
        id: 'allowed-item', name: 'Allowed', category: 'top', color: 'navy', fit: 'regular',
        styleTags: [], formality: 'casual', imageUrl: '/allowed.jpg', marketedFor: 'unisex',
      },
      appearanceAssets: [current],
    }],
  });
  assert.equal(result.result, 'uncertain');
  assert.deepEqual(result.mismatches, ['VISUAL_VERIFIER_RETURNED_NON_ALLOWLIST_ID']);
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

test('ambiguous visual identity deletes transient crops and commits no partial business state', async () => {
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
  });
  await runtime.process(packet(fixture.framePath, 'ambiguous', 'a1'));
  const result = await runtime.process(packet(fixture.framePath, 'ambiguous', 'a2'));
  assert.equal(result.status, 'ambiguous');
  const state = await fixture.repository.getState(userId);
  assert.equal(state.closetItems.length, 0);
  assert.equal(state.captures.length, 0);
  assert.equal(state.assets.length, 0);
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
  async verify(input: Parameters<GarmentVisualVerifier['verify']>[0]) {
    const current = await averageRgb(input.currentAppearance);
    let best: { id: string; distance: number } | undefined;
    for (const candidate of input.candidates) {
      const references = candidate.appearanceAssets.length
        ? candidate.appearanceAssets
        : candidate.fallbackCatalogImage ? [candidate.fallbackCatalogImage] : [];
      for (const reference of references) {
        const distance = colorDistance(current, await averageRgb(reference));
        if (!best || distance < best.distance) best = { id: candidate.closetItem.id, distance };
      }
    }
    if (best && best.distance < 20) {
      return { result: 'same' as const, matchedClosetItemId: best.id, confidence: 0.97, evidence: ['pixel fixture match'], mismatches: [] };
    }
    return { result: 'different' as const, confidence: 0.96, evidence: [], mismatches: ['pixel fixture differs'] };
  }
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

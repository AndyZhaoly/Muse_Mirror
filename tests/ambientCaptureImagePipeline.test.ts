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
import { ClosetService } from '../src/services/closetService.js';
import { GarmentImageAssetService } from '../src/services/garmentImageAssetService.js';
import { VisualGarmentIdentityProvider } from '../src/services/garmentIdentityProvider.js';
import type { GarmentVisualVerifier, ProductImageVerifier } from '../src/services/garmentVisualVerifier.js';
import type { OutfitObservationProvider } from '../src/services/outfitObservationProvider.js';
import type { ProductImageGenerationInput, ProductImageProvider } from '../src/services/productImageProvider.js';
import { JsonUserWardrobeRepository } from '../src/services/userWardrobeRepository.js';

const owner = 'browser-user-image-pipeline';

test('real image pipeline survives reload, label drift, repeat recognition, and a mixed third round', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-real-image-pipeline-'));
  const statePath = path.join(root, 'wardrobe.json');
  const assetService = new GarmentImageAssetService({ rootDirectory: path.join(root, 'assets') });
  const round1Frame = await renderFrame(path.join(root, 'round1.jpg'), {
    topColor: '#17233b', bottomColor: '#c5a66b', topLeft: [282, 150], bottomLeft: [390, 505], brightness: 1,
  });
  const round2Frame = await renderFrame(path.join(root, 'round2.jpg'), {
    topColor: '#1b2944', bottomColor: '#c1a168', topLeft: [350, 170], bottomLeft: [430, 495], brightness: 1.04,
  });
  const round3Frame = await renderFrame(path.join(root, 'round3.jpg'), {
    topColor: '#8f302f', bottomColor: '#c2a269', topLeft: [300, 155], bottomLeft: [405, 500], brightness: 1.01,
  });
  const productCalls: ProductImageGenerationInput[] = [];
  const verificationCalls: Array<{
    currentFrameId?: string;
    references: Array<{ role: GarmentImageAsset['role']; sourceFrameId?: string }>;
  }> = [];

  const round1Observation = observedOutfit('r1',
    observedGarment('r1-top', 'top', 'navy', 'solid', 'regular tee', 'regular', { x: 0.22, y: 0.15, width: 0.42, height: 0.34 }),
    observedGarment('r1-bottom', 'bottom', 'sand', 'solid', 'straight trousers', 'regular', { x: 0.30, y: 0.53, width: 0.40, height: 0.43 }),
  );
  const repository1 = new JsonUserWardrobeRepository(statePath);
  await repository1.setGrant(owner, true);
  const runtime1 = pipeline({
    repository: repository1, assetService, observations: [round1Observation, round1Observation],
    productCalls, verificationCalls,
  });
  assert.equal((await runtime1.process(packet(round1Frame, 'round-1', 'r1-a'))).status, 'observing');
  assert.equal((await runtime1.process(packet(round1Frame, 'round-1', 'r1-b'))).status, 'committed_processing_images');
  const state1 = await waitForReady(repository1, 2);
  const evidence1 = state1.assets.find((asset) => asset.role === 'capture_evidence')!;
  const appearances1 = state1.assets.filter((asset) => asset.role === 'garment_appearance');
  const products1 = state1.assets.filter((asset) => asset.role === 'canonical_product');

  assert.equal(state1.closetItems.length, 2);
  assert.equal(state1.closetItems.every((entry) => entry.status === 'active'), true);
  assert.equal(state1.closetItems.every((entry) => entry.item.identityStatus === 'provisional'), true);
  assert.equal(state1.closetItems.every((entry) => entry.item.ownershipStatus === 'unverified'), true);
  assert.equal(state1.closetItems.every((entry) => entry.item.imageStatus === 'ready'), true);
  assert.equal(appearances1.length, 2);
  assert.equal(products1.length, 2);
  assert.equal(state1.productImageJobs.length, 2);
  assert.equal(productCalls.length, 2);
  assert.notEqual(appearances1[0]?.assetId, appearances1[1]?.assetId);
  assert.notEqual(appearances1[0]?.contentHash, appearances1[1]?.contentHash);
  assert.notEqual(appearances1[0]?.contentHash, evidence1.contentHash);
  assert.notEqual(appearances1[1]?.contentHash, evidence1.contentHash);
  assert.notEqual(products1[0]?.contentHash, products1[1]?.contentHash);
  assert.equal(products1.every((asset) => asset.contentHash !== evidence1.contentHash), true);
  for (const asset of [...appearances1, ...products1]) {
    const metadata = await sharp(asset.storagePath!).metadata();
    assert.ok(metadata.width && metadata.height, `${asset.role} must remain decodable`);
  }
  const mergedCloset = new ClosetService(path.resolve('data/mock-closet.json'));
  const ambientItems = state1.closetItems.map((entry) => entry.item);
  assert.equal(mergedCloset.getByIds(ambientItems.map((item) => item.id), ambientItems).length, 2);
  const mustUseRecommendation = mergedCloset.recommend({
    query: 'fixture-only ambient capture',
    mustUseItemIds: ambientItems.map((item) => item.id),
    profile: {
      presentationPreference: 'unknown',
      presentationOpenness: 'open',
      recommendationScope: 'neutral_core',
      expressionIntensity: 'balanced',
      source: 'unknown',
    },
  }, ambientItems);
  assert.equal(ambientItems.every((item) => mustUseRecommendation.items.some((candidate) => candidate.id === item.id)), true);
  assert.equal(ambientItems.every((item) => mustUseRecommendation.result.candidates.some((candidate) =>
    candidate.itemIds.includes(item.id)
  )), true, 'provisional items must remain eligible for must-use recommendation');
  const primaryIds = new Map(state1.closetItems.map((entry) => [entry.item.category, entry.item.primaryImageAssetId]));
  await runtime1.acknowledge(owner);
  await runtime1.endEpisode(owner, 'round-1');

  // Reload every stateful/runtime component. Round 2 labels intentionally drift
  // enough to miss metadata recall while the pixels still depict the same garments.
  const repository2 = new JsonUserWardrobeRepository(statePath);
  const reloaded1 = await repository2.getState(owner);
  assert.equal(reloaded1.assets.length, state1.assets.length);
  assert.equal(reloaded1.appearances.length, state1.appearances.length);
  const round2Observation = observedOutfit('r2',
    observedGarment('r2-top', 'top', 'deep navy', 'fine knit', 'relaxed jersey upper', 'relaxed', { x: 0.27, y: 0.17, width: 0.42, height: 0.34 }),
    observedGarment('r2-bottom', 'bottom', 'warm khaki', 'twill', 'straight-leg pants', 'relaxed', { x: 0.33, y: 0.52, width: 0.40, height: 0.43 }),
  );
  const runtime2 = pipeline({
    repository: repository2, assetService, observations: [round2Observation, round2Observation],
    productCalls, verificationCalls,
  });
  assert.equal((await runtime2.process(packet(round2Frame, 'round-2', 'r2-a'))).status, 'observing');
  const round2 = await runtime2.process(packet(round2Frame, 'round-2', 'r2-b'));
  assert.equal(round2.status, 'recognized');
  assert.equal(round2.completedEvent?.newItemIds.length, 0);
  assert.equal(round2.completedEvent?.recognizedItemIds.length, 2);
  assert.equal(round2.completedEvent?.repeatedOutfit, true);
  const state2 = await repository2.getState(owner);
  assert.equal(state2.closetItems.length, 2);
  assert.equal(state2.appearances.length, 4);
  assert.equal(state2.wearEvents.length, 4);
  assert.equal(state2.productImageJobs.length, 2);
  assert.equal(productCalls.length, 2, 'repeat recognition must not start paid image jobs');
  assert.equal(state2.closetItems.every((entry) => entry.item.identityStatus === 'provisional'), true);
  assert.equal(state2.closetItems.every((entry) => entry.item.ownershipStatus === 'unverified'), true);
  for (const entry of state2.closetItems) {
    assert.equal(entry.item.primaryImageAssetId, primaryIds.get(entry.item.category));
  }
  const round2VerifierCalls = verificationCalls.filter((call) => call.currentFrameId === 'r2-b');
  assert.equal(round2VerifierCalls.length, 2);
  assert.equal(round2VerifierCalls.every((call) => call.references.some((reference) =>
    reference.role === 'garment_appearance' && reference.sourceFrameId === 'r1-b'
  )), true, 'Round 2 must compare against historical real appearance crops');
  await runtime2.acknowledge(owner);
  await runtime2.endEpisode(owner, 'round-2');

  const repository3 = new JsonUserWardrobeRepository(statePath);
  const round3Observation = observedOutfit('r3',
    observedGarment('r3-top', 'top', 'brick red', 'pique', 'relaxed polo top', 'relaxed', { x: 0.23, y: 0.16, width: 0.42, height: 0.34 }),
    observedGarment('r3-bottom', 'bottom', 'dark sand', 'twill', 'straight-leg pants', 'relaxed', { x: 0.31, y: 0.52, width: 0.40, height: 0.43 }),
  );
  const runtime3 = pipeline({
    repository: repository3, assetService, observations: [round3Observation, round3Observation],
    productCalls, verificationCalls,
  });
  assert.equal((await runtime3.process(packet(round3Frame, 'round-3', 'r3-a'))).status, 'observing');
  assert.equal((await runtime3.process(packet(round3Frame, 'round-3', 'r3-b'))).status, 'committed_processing_images');
  const state3 = await waitForReady(repository3, 3);
  assert.equal(state3.closetItems.length, 3);
  assert.equal(state3.productImageJobs.length, 3);
  assert.equal(productCalls.length, 3);
  assert.equal(state3.pendingCompletionEvent?.newItemIds.length, 1);
  assert.equal(state3.pendingCompletionEvent?.recognizedItemIds.length, 1);
  const bottom = state3.closetItems.find((entry) => entry.item.category === 'bottom')!;
  assert.equal(bottom.item.primaryImageAssetId, primaryIds.get('bottom'));
  assert.equal(bottom.item.identityStatus, 'provisional');
  assert.equal(bottom.item.ownershipStatus, 'unverified');
});

function pipeline(input: {
  repository: JsonUserWardrobeRepository;
  assetService: GarmentImageAssetService;
  observations: WornOutfitObservation[];
  productCalls: ProductImageGenerationInput[];
  verificationCalls: Array<{ currentFrameId?: string; references: Array<{ role: GarmentImageAsset['role']; sourceFrameId?: string }> }>;
}): AmbientCaptureCoordinator {
  return new AmbientCaptureCoordinator({
    observationProvider: queued(input.observations),
    identityProvider: new VisualGarmentIdentityProvider({
      verifier: new PixelVerifier(input.verificationCalls), newConfidenceCeiling: 0.9,
    }),
    repository: input.repository,
    baseClosetItems: () => [],
    assetService: input.assetService,
    productImageProvider: new FakeEditProvider(input.assetService, input.productCalls),
    productImageVerifier: new PassProductVerifier(),
  });
}

class PixelVerifier implements GarmentVisualVerifier {
  readonly ready = true;
  constructor(private readonly calls: Array<{ currentFrameId?: string; references: Array<{ role: GarmentImageAsset['role']; sourceFrameId?: string }> }>) {}
  async verify(input: Parameters<GarmentVisualVerifier['verify']>[0]) {
    const references = input.candidates.flatMap((candidate) =>
      candidate.appearanceAssets.length ? candidate.appearanceAssets : candidate.fallbackCatalogImage ? [candidate.fallbackCatalogImage] : []
    );
    this.calls.push({
      currentFrameId: input.currentAppearance.sourceFrameId,
      references: references.map((reference) => ({ role: reference.role, sourceFrameId: reference.sourceFrameId })),
    });
    const current = await average(input.currentAppearance);
    let best: { id: string; distance: number } | undefined;
    for (const candidate of input.candidates) {
      const candidateReferences = candidate.appearanceAssets.length
        ? candidate.appearanceAssets
        : candidate.fallbackCatalogImage ? [candidate.fallbackCatalogImage] : [];
      for (const reference of candidateReferences) {
        const distance = colorDistance(current, await average(reference));
        if (!best || distance < best.distance) best = { id: candidate.closetItem.id, distance };
      }
    }
    return best && best.distance < 35
      ? { result: 'same' as const, matchedClosetItemId: best.id, confidence: 0.97, evidence: ['real crop pixel match'], mismatches: [] }
      : { result: 'different' as const, confidence: 0.95, evidence: [], mismatches: ['real crop pixels differ'] };
  }
}

class FakeEditProvider implements ProductImageProvider {
  readonly ready = true;
  constructor(private readonly assets: GarmentImageAssetService, private readonly calls: ProductImageGenerationInput[]) {}
  async createCanonicalProductImage(input: ProductImageGenerationInput) {
    this.calls.push(input);
    const bytes = await sharp(input.sourceAppearance.storagePath!)
      .resize(640, 640, { fit: 'contain', background: '#f7f7f3' })
      .webp({ quality: 90 })
      .toBuffer();
    return {
      asset: await this.assets.storeProductImage({
        userId: input.userId, closetItemId: input.closetItemId,
        sourceAsset: input.sourceAppearance, bytes, mimeType: 'image/webp',
      }),
      provider: 'fake-edit', model: 'fixture-edit',
    };
  }
}

class PassProductVerifier implements ProductImageVerifier {
  readonly ready = true;
  async verify(): Promise<ProductImageVerification> {
    return {
      result: 'pass', confidence: 0.99,
      checks: {
        colorMatch: true, patternMatch: true, necklineMatch: true, sleeveMatch: true,
        closureMatch: true, pocketMatch: true, silhouetteMatch: true, lengthMatch: true, logoMatch: true,
      },
      mismatches: [], notes: ['fixture pass'],
    };
  }
}

async function renderFrame(filePath: string, input: {
  topColor: string; bottomColor: string; topLeft: [number, number]; bottomLeft: [number, number]; brightness: number;
}): Promise<string> {
  const top = await sharp({ create: { width: 540, height: 330, channels: 3, background: input.topColor } })
    .composite([{ input: Buffer.from('<svg width="540" height="330"><path d="M15 55 L155 10 L270 80 L385 10 L525 55 L495 320 L45 320 Z" fill="none" stroke="#e6e8ed" stroke-width="12"/><circle cx="270" cy="55" r="42" fill="none" stroke="#e6e8ed" stroke-width="10"/></svg>') }])
    .png().toBuffer();
  const bottom = await sharp({ create: { width: 510, height: 410, channels: 3, background: input.bottomColor } })
    .composite([{ input: Buffer.from('<svg width="510" height="410"><path d="M255 0 V410 M25 70 H485" stroke="#504433" stroke-width="10"/><path d="M70 0 L55 405 M440 0 L455 405" stroke="#756044" stroke-width="6"/></svg>') }])
    .png().toBuffer();
  await sharp({ create: { width: 1280, height: 960, channels: 3, background: '#ddd8cf' } })
    .composite([
      { input: top, left: input.topLeft[0], top: input.topLeft[1] },
      { input: bottom, left: input.bottomLeft[0], top: input.bottomLeft[1] },
    ])
    .modulate({ brightness: input.brightness })
    .jpeg({ quality: 92 })
    .toFile(filePath);
  return filePath;
}

function observedOutfit(id: string, top: WornGarmentObservation, bottom: WornGarmentObservation): WornOutfitObservation {
  return {
    observationId: `observation-${id}`, provider: 'fixture', model: 'fixture',
    analyzedAt: new Date().toISOString(), personCount: 1, coverage: 'full_body', quality: 'good',
    garments: [top, bottom], uncertainties: [],
  };
}

function observedGarment(
  id: string,
  slot: 'top' | 'bottom',
  color: string,
  pattern: string,
  silhouette: string,
  fit: string,
  boundingBox: WornGarmentObservation['boundingBox'],
): WornGarmentObservation {
  return {
    observationItemId: id, slot, category: slot, description: `${color} ${silhouette}`,
    dominantColor: color, secondaryColors: [], pattern, silhouette, fit,
    distinctiveFeatures: [silhouette, pattern], boundingBox, confidence: 0.95, uncertainties: [],
  };
}

function queued(observations: WornOutfitObservation[]): OutfitObservationProvider {
  const values = [...observations];
  return { ready: true, async analyze() { return structuredClone(values.shift()!); } };
}

function packet(imagePath: string, sessionId: string, frameId: string): AmbientCapturePacket {
  return {
    packetId: `packet-${frameId}`, userId: owner, sessionId, frameId,
    capturedAt: new Date().toISOString(), imagePath, imageMimeType: 'image/jpeg', activeTask: false,
    stability: { score: 0.98, stableSamples: 3, sampleIntervalMs: 1200, sourceWidth: 1280, sourceHeight: 960 },
  };
}

async function waitForReady(repository: JsonUserWardrobeRepository, expected: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await repository.getState(owner);
    if (state.closetItems.filter((entry) => entry.item.imageStatus === 'ready').length === expected &&
      state.productImageJobs.every((job) => job.status === 'ready') && state.pendingCompletionEvent) return state;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('Timed out waiting for verified product images.');
}

async function average(asset: GarmentImageAsset): Promise<[number, number, number]> {
  const stats = await sharp(asset.storagePath!).stats();
  return [stats.channels[0]!.mean, stats.channels[1]!.mean, stats.channels[2]!.mean];
}

function colorDistance(left: [number, number, number], right: [number, number, number]): number {
  return Math.sqrt(left.reduce((sum, value, index) => sum + (value - right[index]!) ** 2, 0));
}

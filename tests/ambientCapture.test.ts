import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type {
  AmbientCapturePacket,
  WornGarmentObservation,
  WornOutfitObservation,
} from '../src/domain/ambientCapture.js';
import { AmbientCaptureCoordinator } from '../src/runtime/ambientCaptureCoordinator.js';
import { DeterministicGarmentIdentityProvider } from '../src/services/garmentIdentityProvider.js';
import type { OutfitObservationProvider } from '../src/services/outfitObservationProvider.js';
import { JsonUserWardrobeRepository } from '../src/services/userWardrobeRepository.js';
import { ClosetService } from '../src/services/closetService.js';

const userId = 'browser_user_ambient_test';
const sessionId = 'session_ambient_test';

test('three real-style rounds create, recognize, then mix ambient wardrobe items durably', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-ambient-'));
  const statePath = path.join(directory, 'wardrobe.json');
  const evidencePath = path.join(directory, 'evidence');
  const framePath = path.join(directory, 'frame.jpg');
  await fs.writeFile(framePath, Buffer.from('real-camera-frame-fixture'));

  const firstOutfit = outfit([
    garment('top-1', 'top', 'navy', 'short sleeve crew neck tee'),
    garment('bottom-1', 'bottom', 'sand', 'straight trousers'),
  ]);
  const repository1 = new JsonUserWardrobeRepository(statePath);
  await repository1.setGrant(userId, true);
  const round1 = coordinator(repository1, evidencePath, [firstOutfit, firstOutfit]);
  assert.equal((await round1.process(packet(framePath, 'r1a'))).status, 'observing');
  const round1Result = await round1.process(packet(framePath, 'r1b'));
  assert.equal(round1Result.status, 'committed');
  assert.equal(round1Result.completedEvent?.newItemIds.length, 2);
  assert.equal(round1Result.completedEvent?.recognizedItemIds.length, 0);
  await round1.endEpisode(userId, sessionId);

  const stateAfterRound1 = await new JsonUserWardrobeRepository(statePath).getState(userId);
  assert.equal(stateAfterRound1.closetItems.length, 2);
  assert.equal(stateAfterRound1.captures.length, 1);
  assert.equal(stateAfterRound1.wearEvents.length, 2);
  assert.ok(stateAfterRound1.closetItems.every((entry) => entry.status === 'provisional'));
  assert.ok(stateAfterRound1.closetItems.every((entry) => entry.item.imageUrl.startsWith('/generated/ambient_')));

  const repository2 = new JsonUserWardrobeRepository(statePath);
  const round2 = coordinator(repository2, evidencePath, [firstOutfit, firstOutfit]);
  assert.equal((await round2.process(packet(framePath, 'r2a'))).status, 'observing');
  const round2Result = await round2.process(packet(framePath, 'r2b'));
  assert.equal(round2Result.status, 'recognized');
  assert.equal(round2Result.completedEvent?.newItemIds.length, 0);
  assert.equal(round2Result.completedEvent?.recognizedItemIds.length, 2);
  assert.equal(round2Result.completedEvent?.repeatedOutfit, true);
  await round2.endEpisode(userId, sessionId);

  const mixedOutfit = outfit([
    garment('top-2', 'top', 'brick red', 'relaxed polo shirt'),
    garment('bottom-2', 'bottom', 'sand', 'straight trousers'),
  ]);
  const repository3 = new JsonUserWardrobeRepository(statePath);
  const round3 = coordinator(repository3, evidencePath, [mixedOutfit, mixedOutfit]);
  assert.equal((await round3.process(packet(framePath, 'r3a'))).status, 'observing');
  const round3Result = await round3.process(packet(framePath, 'r3b'));
  assert.equal(round3Result.status, 'mixed');
  assert.equal(round3Result.completedEvent?.newItemIds.length, 1);
  assert.equal(round3Result.completedEvent?.recognizedItemIds.length, 1);

  const finalState = await new JsonUserWardrobeRepository(statePath).getState(userId);
  assert.equal(finalState.closetItems.length, 3);
  assert.equal(finalState.captures.length, 3);
  assert.equal(finalState.wearEvents.length, 6);
  assert.equal(new Set(finalState.captures.flatMap((capture) => capture.closetItemIds)).size, 3);

  const closet = new ClosetService(path.resolve('data/mock-closet.json'));
  const recommendation = closet.recommend({
    query: 'brick red polo shirt',
    profile: {
      presentationPreference: 'unknown',
      presentationOpenness: 'open',
      recommendationScope: 'neutral_core',
      expressionIntensity: 'balanced',
      preferenceMemoryScope: 'turn',
      source: 'explicit_user',
    },
  }, finalState.closetItems.map((entry) => entry.item));
  assert.ok(recommendation.items.some((item) => item.id === round3Result.completedEvent?.newItemIds[0]));
});

test('ambient capture stays silent without grant and never calls the real provider', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-ambient-disabled-'));
  const framePath = path.join(directory, 'frame.jpg');
  await fs.writeFile(framePath, 'frame');
  let calls = 0;
  const provider: OutfitObservationProvider = {
    ready: true,
    async analyze() { calls += 1; return outfit([]); },
  };
  const repository = new JsonUserWardrobeRepository(path.join(directory, 'state.json'));
  const runtime = new AmbientCaptureCoordinator({
    observationProvider: provider,
    identityProvider: new DeterministicGarmentIdentityProvider(),
    repository,
    baseClosetItems: () => [],
    evidenceDirectory: directory,
  });
  const result = await runtime.process(packet(framePath, 'disabled'));
  assert.equal(result.status, 'disabled');
  assert.equal(calls, 0);
  assert.equal((await repository.getState(userId)).closetItems.length, 0);
});

test('ambiguous identity never commits partial business state', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-ambient-ambiguous-'));
  const framePath = path.join(directory, 'frame.jpg');
  await fs.writeFile(framePath, 'frame');
  const repository = new JsonUserWardrobeRepository(path.join(directory, 'state.json'));
  await repository.setGrant(userId, true);
  const observed = outfit([
    garment('top', 'top', 'black', 'plain tee'),
    garment('bottom', 'bottom', 'black', 'straight trousers'),
  ]);
  const runtime = new AmbientCaptureCoordinator({
    observationProvider: queuedProvider([observed, observed]),
    identityProvider: {
      async resolve(input) {
        return {
          observationItemId: input.garment.observationItemId,
          status: 'ambiguous',
          appearanceFingerprint: 'ambiguous',
          confidence: 0.7,
          candidateItemIds: ['one', 'two'],
          reasonCodes: ['MULTIPLE_SIMILAR_ITEMS'],
        };
      },
    },
    repository,
    baseClosetItems: () => [],
    evidenceDirectory: directory,
  });
  await runtime.process(packet(framePath, 'a1'));
  const result = await runtime.process(packet(framePath, 'a2'));
  assert.equal(result.status, 'ambiguous');
  const state = await repository.getState(userId);
  assert.equal(state.closetItems.length, 0);
  assert.equal(state.captures.length, 0);
  assert.equal(state.wearEvents.length, 0);
});

test('repository idempotency prevents duplicate paid-equivalent capture commits', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-ambient-idempotent-'));
  const framePath = path.join(directory, 'frame.jpg');
  await fs.writeFile(framePath, 'frame');
  const repository = new JsonUserWardrobeRepository(path.join(directory, 'state.json'));
  await repository.setGrant(userId, true);
  const observed = outfit([
    garment('top', 'top', 'blue', 'crew tee'),
    garment('bottom', 'bottom', 'gray', 'straight trousers'),
  ]);
  const runtime = coordinator(repository, directory, [observed, observed, observed]);
  await runtime.process(packet(framePath, 'i1'));
  const committed = await runtime.process(packet(framePath, 'i2'));
  const repeated = await runtime.process(packet(framePath, 'i3'));
  assert.equal(committed.status, 'committed');
  assert.equal(repeated.status, 'already_committed');
  assert.equal(repeated.completedEvent, undefined);
  assert.equal((await repository.getState(userId)).captures.length, 1);
  assert.equal((await fs.readdir(directory)).filter((name) => name.startsWith('ambient_')).length, 1);
});

test('stale packets are rejected before the vision provider is called', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-ambient-stale-'));
  const framePath = path.join(directory, 'frame.jpg');
  await fs.writeFile(framePath, 'frame');
  const repository = new JsonUserWardrobeRepository(path.join(directory, 'state.json'));
  await repository.setGrant(userId, true);
  let calls = 0;
  const runtime = new AmbientCaptureCoordinator({
    observationProvider: { ready: true, async analyze() { calls += 1; return outfit([]); } },
    identityProvider: new DeterministicGarmentIdentityProvider(),
    repository,
    baseClosetItems: () => [],
    evidenceDirectory: directory,
  });
  const stale = packet(framePath, 'stale');
  stale.capturedAt = new Date(Date.now() - 30_000).toISOString();
  const result = await runtime.process(stale);
  assert.equal(result.status, 'insufficient_evidence');
  assert.deepEqual(result.reasonCodes, ['CAPTURE_PACKET_STALE']);
  assert.equal(calls, 0);
});

test('multi-person observations enter privacy pause without writing wardrobe state', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-ambient-privacy-'));
  const framePath = path.join(directory, 'frame.jpg');
  await fs.writeFile(framePath, 'frame');
  const repository = new JsonUserWardrobeRepository(path.join(directory, 'state.json'));
  await repository.setGrant(userId, true);
  const multiplePeople = { ...outfit([]), personCount: 2 };
  const runtime = coordinator(repository, directory, [multiplePeople]);
  const result = await runtime.process(packet(framePath, 'privacy'));
  assert.equal(result.status, 'privacy_paused');
  const state = await repository.getState(userId);
  assert.equal(state.closetItems.length, 0);
  assert.equal(state.captures.length, 0);
});

test('garment tracks reset a changed top and require a second matching observation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-ambient-tracks-'));
  const framePath = path.join(directory, 'frame.jpg');
  await fs.writeFile(framePath, 'frame');
  const repository = new JsonUserWardrobeRepository(path.join(directory, 'state.json'));
  await repository.setGrant(userId, true);
  const navy = outfit([
    garment('navy-top', 'top', 'navy', 'crew neck tee'),
    garment('pants-a', 'bottom', 'sand', 'straight trousers'),
  ]);
  const red = outfit([
    garment('red-top', 'top', 'red', 'relaxed polo shirt'),
    garment('pants-b', 'bottom', 'sand', 'straight trousers'),
  ]);
  const runtime = coordinator(repository, directory, [navy, red, red]);
  assert.equal((await runtime.process(packet(framePath, 'track-1'))).status, 'observing');
  assert.equal((await runtime.process(packet(framePath, 'track-2'))).status, 'observing');
  const completed = await runtime.process(packet(framePath, 'track-3'));
  assert.equal(completed.status, 'committed');
  assert.equal(completed.completedEvent?.newItemIds.length, 2);
});

test('duplicate frame packets and concurrent requests cannot create duplicate captures', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-ambient-concurrent-'));
  const framePath = path.join(directory, 'frame.jpg');
  await fs.writeFile(framePath, 'frame');
  const repository = new JsonUserWardrobeRepository(path.join(directory, 'state.json'));
  await repository.setGrant(userId, true);
  const observed = outfit([
    garment('top', 'top', 'navy', 'crew neck tee'),
    garment('bottom', 'bottom', 'sand', 'straight trousers'),
  ]);
  let calls = 0;
  const provider: OutfitObservationProvider = {
    ready: true,
    async analyze() { calls += 1; return structuredClone(observed); },
  };
  const runtime = new AmbientCaptureCoordinator({
    observationProvider: provider,
    identityProvider: new DeterministicGarmentIdentityProvider(),
    repository,
    baseClosetItems: () => [],
    evidenceDirectory: directory,
  });
  const duplicate = packet(framePath, 'same-frame');
  await runtime.process(duplicate);
  const repeatedPacket = await runtime.process(duplicate);
  assert.deepEqual(repeatedPacket.reasonCodes, ['DUPLICATE_CAPTURE_FRAME']);
  assert.equal(calls, 1);
  await Promise.all([
    runtime.process(packet(framePath, 'parallel-a')),
    runtime.process(packet(framePath, 'parallel-b')),
  ]);
  assert.equal((await repository.getState(userId)).captures.length, 1);
});

test('grants and overlay wardrobe records are isolated by browser user ID', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-ambient-users-'));
  const framePath = path.join(directory, 'frame.jpg');
  await fs.writeFile(framePath, 'frame');
  const repository = new JsonUserWardrobeRepository(path.join(directory, 'state.json'));
  await repository.setGrant('user-a', true);
  const observed = outfit([
    garment('top', 'top', 'navy', 'crew neck tee'),
    garment('bottom', 'bottom', 'sand', 'straight trousers'),
  ]);
  const runtime = coordinator(repository, directory, [observed, observed]);
  const userBPacket = { ...packet(framePath, 'user-b'), userId: 'user-b' };
  assert.equal((await runtime.process(userBPacket)).status, 'disabled');
  assert.equal((await repository.getState('user-b')).closetItems.length, 0);
  const firstA = { ...packet(framePath, 'user-a-1'), userId: 'user-a' };
  const secondA = { ...packet(framePath, 'user-a-2'), userId: 'user-a' };
  await runtime.process(firstA);
  await runtime.process(secondA);
  assert.equal((await repository.getState('user-a')).closetItems.length, 2);
  assert.equal((await repository.getState('user-b')).closetItems.length, 0);
});

test('debug reset removes only the selected user state and durable evidence', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-ambient-reset-'));
  const framePath = path.join(directory, 'frame.jpg');
  const evidenceDirectory = path.join(directory, 'evidence');
  await fs.writeFile(framePath, 'frame');
  const repository = new JsonUserWardrobeRepository(path.join(directory, 'state.json'));
  await repository.setGrant('user-a', true);
  await repository.setGrant('user-b', true);
  const observed = outfit([
    garment('top', 'top', 'navy', 'crew neck tee'),
    garment('bottom', 'bottom', 'sand', 'straight trousers'),
  ]);
  const runtimeA = coordinator(repository, evidenceDirectory, [observed, observed]);
  await runtimeA.process({ ...packet(framePath, 'reset-a1'), userId: 'user-a' });
  await runtimeA.process({ ...packet(framePath, 'reset-a2'), userId: 'user-a' });
  await runtimeA.endEpisode('user-a', sessionId);
  const runtimeB = coordinator(repository, evidenceDirectory, [observed, observed]);
  await runtimeB.process({ ...packet(framePath, 'reset-b1'), userId: 'user-b' });
  await runtimeB.process({ ...packet(framePath, 'reset-b2'), userId: 'user-b' });
  const before = await fs.readdir(evidenceDirectory);
  assert.equal(before.filter((name) => name.startsWith('ambient_')).length, 2);

  await runtimeA.resetUser('user-a');

  const userAState = await repository.getState('user-a');
  const userBState = await repository.getState('user-b');
  assert.equal(userAState.captures.length, 0);
  assert.equal(userAState.grant, undefined);
  assert.equal(userBState.captures.length, 1);
  const after = await fs.readdir(evidenceDirectory);
  assert.equal(after.filter((name) => name.startsWith('ambient_')).length, 1);
  assert.equal(await runtimeA.diagnostics('user-a').then((value) => value.lastOutcome), undefined);
});

function coordinator(
  repository: JsonUserWardrobeRepository,
  evidenceDirectory: string,
  observations: WornOutfitObservation[],
): AmbientCaptureCoordinator {
  return new AmbientCaptureCoordinator({
    observationProvider: queuedProvider(observations),
    identityProvider: new DeterministicGarmentIdentityProvider(),
    repository,
    baseClosetItems: () => [],
    evidenceDirectory,
  });
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

function packet(imagePath: string, frameId: string): AmbientCapturePacket {
  return {
    packetId: `packet_${frameId}`,
    userId,
    sessionId,
    frameId,
    capturedAt: new Date().toISOString(),
    imagePath,
    imageMimeType: 'image/jpeg',
    activeTask: false,
    stability: {
      score: 0.98,
      stableSamples: 3,
      sampleIntervalMs: 1200,
      sourceWidth: 1280,
      sourceHeight: 960,
    },
  };
}

function garment(
  id: string,
  slot: 'top' | 'bottom',
  color: string,
  description: string,
): WornGarmentObservation {
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

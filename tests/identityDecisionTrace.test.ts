import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { GarmentIdentityDecisionTrace } from '../src/domain/ambientCapture.js';
import { JsonUserWardrobeRepository } from '../src/services/userWardrobeRepository.js';

test('identity traces persist across reload and roll over at the configured limit', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-identity-traces-'));
  const filePath = path.join(directory, 'wardrobe.json');
  const repository = new JsonUserWardrobeRepository(filePath);
  await repository.appendIdentityDecisionTraces('user-a', Array.from({ length: 205 }, (_, index) => trace(index)), 200);
  const reloaded = new JsonUserWardrobeRepository(filePath);
  const state = await reloaded.getState('user-a');
  assert.equal(state.identityDecisionTraces.length, 200);
  assert.equal(state.identityDecisionTraces[0]?.traceId, 'trace-5');
  assert.equal(state.identityDecisionTraces.at(-1)?.traceId, 'trace-204');
  const serialized = JSON.stringify(state.identityDecisionTraces);
  assert.doesNotMatch(serialized, /data:image|;base64,|user-a/);
  assert.equal(state.identityDecisionTraces[0]?.recall.candidates[0]?.metadataScore, 0.9);
  assert.equal(state.identityDecisionTraces[0]?.pairwiseVerifications[0]?.normalizedResult.verdict, 'same');
});

test('identity trace persistence rejects base64 payloads and absolute paths', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'muse-identity-trace-safety-'));
  const repository = new JsonUserWardrobeRepository(path.join(directory, 'wardrobe.json'));
  const withBase64 = trace(1);
  withBase64.pairwiseVerifications[0]!.rawResult.occlusions = ['data:image/jpeg;base64,AAAA'];
  await assert.rejects(() => repository.appendIdentityDecisionTraces('user-a', [withBase64]), /image payloads/);
  const withPath = trace(2);
  withPath.pairwiseVerifications[0]!.rawResult.occlusions = ['/Users/example/private.jpg'];
  await assert.rejects(() => repository.appendIdentityDecisionTraces('user-a', [withPath]), /absolute paths/);
});

function trace(index: number): GarmentIdentityDecisionTrace {
  const pairwise = {
    verdict: 'same' as const,
    confidence: 0.95,
    featureComparisons: [{
      feature: 'pocket_geometry' as const,
      currentVisibility: 'visible' as const,
      referenceVisibility: 'visible' as const,
      relation: 'same' as const,
      discriminativeStrength: 'strong' as const,
      note: 'same pocket construction',
    }],
    occlusions: [],
    jointlyVisibleEvidence: ['pocket construction'],
    model: 'fixture-model',
  };
  return {
    traceId: `trace-${index}`,
    episodeId: 'episode-1',
    observationItemId: 'observation-item-1',
    currentAppearanceAssetId: 'asset-current',
    recall: {
      strategy: 'metadata',
      candidates: [{
        closetItemId: 'closet-item-1', source: 'user', metadataScore: 0.9, continuityPrior: 0.08,
        effectivePrior: 0.98, tier: 'strong', categoryCompatibility: 'exact',
        referenceEvidenceType: 'historical_appearance', referenceAssetIds: ['asset-reference'], softContradictions: [],
      }],
    },
    pairwiseVerifications: [{
      candidateClosetItemId: 'closet-item-1', rawResult: pairwise, normalizedResult: pairwise,
      serverDowngradeReasons: [], requiredDifferentConfidence: 0.95, autoCreateVeto: true,
      referenceEvidenceType: 'historical_appearance', evidenceTaxonomyVersion: 1,
      classLevelSameFeatures: [], instanceSpecificSameFeatures: ['pocket_geometry'],
      safeSameGateResult: true, safeSameRejectReasons: [], multiFrameEvidenceCount: 1,
      temporalEvidenceConsistency: 'insufficient',
      model: 'fixture-model', latencyMs: 20,
    }],
    thresholds: { matchConfidence: 0.88, baseNewConfidence: 0.78, strongPriorVeto: 0.85 },
    finalDecision: 'matched_existing', matchedClosetItemId: 'closet-item-1', reasonCodes: ['REAL_VISUAL_APPEARANCE_MATCH'],
    promptVersion: 'garment-pairwise-v1', schemaVersion: 1, createdAt: `2026-08-06T20:${String(index % 60).padStart(2, '0')}:00.000Z`,
  };
}

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { evaluatePresentationCompatibility } from '../src/domain/presentationCompatibility.js';
import { ClosetService } from '../src/services/closetService.js';
import type { ClosetItem, StylingProfile } from '../src/types.js';

const masculineStrictProfile: StylingProfile = {
  presentationPreference: 'masculine',
  presentationOpenness: 'strict',
  fitPreference: 'regular',
  source: 'demo_preset',
};

const feminineStrictProfile: StylingProfile = {
  presentationPreference: 'feminine',
  presentationOpenness: 'strict',
  fitPreference: 'regular',
  source: 'session_override',
};

function closet(): ClosetService {
  const config = loadConfig();
  return new ClosetService(config.closetDataPath, config.closetPresentationMetadataPath);
}

test('marketedFor womens neutral basics can remain compatible with masculine strict profile', () => {
  const service = closet();
  const [whiteTop] = service.getByIds(['look_002_black_white_jacket_mini_skirt_boots_item_02_white_inner_top']);
  assert.ok(whiteTop);
  assert.equal(whiteTop.marketedFor, 'womens');
  const result = evaluatePresentationCompatibility(whiteTop, masculineStrictProfile);
  assert.equal(result.allowed, true);
  assert.ok(result.reasonCodes.includes('androgynous_compatible'));
});

test('strong feminine footwear is excluded for masculine strict profile', () => {
  const service = closet();
  const [heels] = service.getByIds(['look_009_white_one_shoulder_top_wide_pants_item_03_silver_pointed_heels']);
  assert.ok(heels);
  const result = evaluatePresentationCompatibility(heels, masculineStrictProfile);
  assert.equal(result.allowed, false);
  assert.ok(result.reasonCodes.some((code) => code.includes('excluded_strong_feminine')));
});

test('masculine and feminine strict rules are symmetric for strong opposite expression', () => {
  const strongMasculineItem: ClosetItem = {
    id: 'test_masculine_item',
    name: 'Boxy workwear jacket',
    category: 'outerwear',
    color: 'olive',
    fit: 'boxy',
    formality: 'casual',
    styleTags: ['workwear'],
    imageUrl: '',
    marketedFor: 'mens',
    presentationMetadata: {
      affinity: { masculine: 0.92, androgynous: 0.42, feminine: 0.12 },
      intensity: 'strong',
      reasonCodes: ['boxy_cut', 'workwear_detail', 'wide_shoulder'],
      metadataVersion: 'test',
      reviewedAt: '2026-06-20',
    },
  };
  const result = evaluatePresentationCompatibility(strongMasculineItem, feminineStrictProfile);
  assert.equal(result.allowed, false);
  assert.ok(result.reasonCodes.some((code) => code.includes('excluded_strong_masculine')));
});

test('must-use item can bypass presentation filtering but not become confirmed fit', () => {
  const service = closet();
  const [dress] = service.getByIds(['look_007_white_long_dress_item_01_white_lace_mermaid_dress']);
  assert.ok(dress);
  const result = evaluatePresentationCompatibility(dress, masculineStrictProfile, { mustUse: true });
  assert.equal(result.allowed, true);
  assert.ok(result.reasonCodes.includes('explicit_must_use'));
  assert.notEqual(result.fitStatus, 'confirmed');
});

test('closet recommendation carries provenance and excludes strong feminine cards for demo preset', () => {
  const service = closet();
  const { result, items } = service.recommend({
    query: '聚餐',
    limit: 12,
    profile: masculineStrictProfile,
  });
  const ids = new Set(items.map((item) => item.id));
  assert.ok(result.profileSnapshotId.startsWith('profile_'));
  assert.ok(result.policyVersion.startsWith('presentation_policy_'));
  assert.ok(result.closetVersion.startsWith('closet_'));
  assert.ok(result.candidates.every((candidate) => candidate.provenance.profileSnapshotId === result.profileSnapshotId));
  assert.equal(ids.has('look_009_white_one_shoulder_top_wide_pants_item_03_silver_pointed_heels'), false);
  assert.equal(ids.has('look_007_white_long_dress_item_01_white_lace_mermaid_dress'), false);
});

test('missing metadata safely degrades without a random hard exclusion', () => {
  const item: ClosetItem = {
    id: 'metadata_missing',
    name: 'Unknown jacket',
    category: 'outerwear',
    color: 'black',
    fit: 'regular',
    formality: 'casual',
    styleTags: [],
    imageUrl: '',
  };
  const result = evaluatePresentationCompatibility(item, masculineStrictProfile);
  assert.equal(result.allowed, true);
  assert.ok(result.reasonCodes.includes('metadata_missing'));
  assert.equal(result.fitStatus, 'unknown');
});

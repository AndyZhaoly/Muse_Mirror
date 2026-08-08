import assert from 'node:assert/strict';
import test from 'node:test';
import type { AmbientCaptureCompletedEvent } from '../web/src/agentClient.js';
import {
  deriveWardrobeMoment,
  wardrobeMomentPollIntervalMs,
} from '../web/src/components/mirror/wardrobeMoment.js';

function event(
  overrides: Partial<AmbientCaptureCompletedEvent> = {},
): AmbientCaptureCompletedEvent {
  return {
    eventId: 'event-1',
    type: 'outfit_capture_completed',
    userId: 'user-1',
    sessionId: 'session-1',
    captureId: 'capture-1',
    episodeId: 'episode-1',
    newItemIds: ['top-1', 'bottom-1'],
    recognizedItemIds: [],
    completionStatus: 'fully_resolved',
    pendingItems: [],
    itemSummaries: [
      {
        closetItemId: 'top-1',
        slot: 'top',
        label: '浅蓝色上衣',
        status: 'new',
        imageStatus: 'processing',
        fallbackImageUrl: '/api/fashion/wardrobe-assets/top-crop',
      },
      {
        closetItemId: 'bottom-1',
        slot: 'bottom',
        label: '浅灰色短裤',
        status: 'new',
        imageStatus: 'processing',
        fallbackImageUrl: '/api/fashion/wardrobe-assets/bottom-crop',
      },
    ],
    repeatedOutfit: false,
    committedAt: '2026-08-08T02:00:00.000Z',
    ...overrides,
  };
}

test('no semantic wardrobe event produces no Wardrobe Moment', () => {
  assert.equal(deriveWardrobeMoment(), undefined);
  assert.equal(deriveWardrobeMoment(event({ itemSummaries: [], pendingItems: [] })), undefined);
});

test('new outfit produces one persistent moment with independent processing cards', () => {
  const moment = deriveWardrobeMoment(event());

  assert.equal(moment?.headline, '已加入你的衣橱');
  assert.equal(moment?.captureId, 'capture-1');
  assert.equal(moment?.ownerUserId, 'user-1');
  assert.deepEqual(moment?.items.map((item) => item.imageState), ['processing', 'processing']);
  assert.ok(moment?.items.every((item) => item.imageUrl === undefined));
});

test('product images reveal independently without replacing the capture identity', () => {
  const before = deriveWardrobeMoment(event());
  const after = deriveWardrobeMoment(event({
    updatedAt: '2026-08-08T02:00:10.000Z',
    itemSummaries: [
      {
        closetItemId: 'top-1',
        slot: 'top',
        label: '浅蓝色上衣',
        status: 'new',
        imageStatus: 'ready',
        imageUrl: '/api/fashion/wardrobe-assets/top-product',
        fallbackImageUrl: '/api/fashion/wardrobe-assets/top-crop',
      },
      {
        closetItemId: 'bottom-1',
        slot: 'bottom',
        label: '浅灰色短裤',
        status: 'new',
        imageStatus: 'processing',
        fallbackImageUrl: '/api/fashion/wardrobe-assets/bottom-crop',
      },
    ],
  }));

  assert.equal(before?.eventId, after?.eventId);
  assert.equal(before?.captureId, after?.captureId);
  assert.deepEqual(after?.items.map((item) => item.id), ['top-1', 'bottom-1']);
  assert.equal(after?.items[0]?.imageState, 'ready');
  assert.equal(after?.items[0]?.imageUrl, '/api/fashion/wardrobe-assets/top-product');
  assert.equal(after?.items[1]?.imageState, 'processing');
  assert.equal(after?.updatedAt, '2026-08-08T02:00:10.000Z');
});

test('Wardrobe Moment polling follows unresolved event content instead of transient capture status', () => {
  assert.equal(wardrobeMomentPollIntervalMs(event()), 1_200);
  assert.equal(wardrobeMomentPollIntervalMs(event({
    itemSummaries: [{
      closetItemId: 'top-1',
      slot: 'top',
      label: '浅蓝色上衣',
      status: 'new',
      imageStatus: 'ready',
      imageUrl: '/api/fashion/wardrobe-assets/top-product',
    }],
    pendingItems: [{
      resolutionId: 'pending-bottom',
      slot: 'bottom',
      label: '浅灰色短裤',
      state: 'awaiting_evidence',
    }],
  })), 4_000);
  assert.equal(wardrobeMomentPollIntervalMs(event({
    itemSummaries: [{
      closetItemId: 'top-1',
      slot: 'top',
      label: '浅蓝色上衣',
      status: 'new',
      imageStatus: 'ready',
      imageUrl: '/api/fashion/wardrobe-assets/top-product',
    }],
  })), undefined);
});

test('recognized outfit reuses existing wardrobe cards', () => {
  const moment = deriveWardrobeMoment(event({
    newItemIds: [],
    recognizedItemIds: ['top-1', 'bottom-1'],
    completionStatus: 'fully_recognized',
    repeatedOutfit: true,
    itemSummaries: [
      {
        closetItemId: 'top-1',
        slot: 'top',
        label: '浅蓝色上衣',
        status: 'recognized',
        imageStatus: 'ready',
        imageUrl: '/api/fashion/wardrobe-assets/top-product',
      },
      {
        closetItemId: 'bottom-1',
        slot: 'bottom',
        label: '浅灰色短裤',
        status: 'recognized',
        imageStatus: 'ready',
        imageUrl: '/api/fashion/wardrobe-assets/bottom-product',
      },
    ],
  }));

  assert.equal(moment?.headline, '认出来了，是这套');
  assert.ok(moment?.items.every((item) => item.status === 'recognized'));
  assert.ok(moment?.items.every((item) => item.imageState === 'ready'));
});

test('mixed and partial captures remain useful without blocking resolved items', () => {
  const mixed = deriveWardrobeMoment(event({
    newItemIds: ['top-1'],
    recognizedItemIds: ['bottom-1'],
    itemSummaries: [
      { closetItemId: 'top-1', slot: 'top', label: '米色上衣', status: 'new', imageStatus: 'processing' },
      { closetItemId: 'bottom-1', slot: 'bottom', label: '灰色短裤', status: 'recognized', imageStatus: 'ready', imageUrl: '/bottom.png' },
    ],
  }));
  const partial = deriveWardrobeMoment(event({
    newItemIds: ['top-1'],
    recognizedItemIds: [],
    completionStatus: 'partially_resolved',
    itemSummaries: [
      { closetItemId: 'top-1', slot: 'top', label: '米色上衣', status: 'new', imageStatus: 'ready', imageUrl: '/top.png' },
    ],
    pendingItems: [{ resolutionId: 'pending-bottom', slot: 'bottom', label: '灰色短裤', state: 'ready_to_ask' }],
  }));

  assert.match(mixed?.headline ?? '', /认识灰色短裤/);
  assert.deepEqual(partial?.items.map((item) => item.status), ['new', 'pending']);
  assert.equal(partial?.headline, '已记下清楚的部分');
});

test('failed presentation image falls back to the protected garment crop', () => {
  const moment = deriveWardrobeMoment(event({
    newItemIds: ['top-1'],
    itemSummaries: [{
      closetItemId: 'top-1',
      slot: 'top',
      label: '浅蓝色上衣',
      status: 'new',
      imageStatus: 'needs_review',
      fallbackImageUrl: '/api/fashion/wardrobe-assets/top-crop',
    }],
  }));

  assert.equal(moment?.headline, '已加入你的衣橱');
  assert.equal(moment?.items[0]?.imageState, 'fallback');
  assert.equal(moment?.items[0]?.imageUrl, '/api/fashion/wardrobe-assets/top-crop');
});

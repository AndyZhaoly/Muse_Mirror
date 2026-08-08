import type { AmbientCaptureCompletedEvent } from '../../agentClient.js';
import type { WardrobeMoment, WardrobeMomentItem } from './mirrorScreenTypes.js';

function resolvedItem(
  item: AmbientCaptureCompletedEvent['itemSummaries'][number],
): WardrobeMomentItem {
  const canonicalReady = item.imageStatus === 'ready' && Boolean(item.imageUrl);
  const fallbackReady = (
    item.imageStatus === 'failed' ||
    item.imageStatus === 'needs_review' ||
    item.status === 'recognized'
  ) && Boolean(item.fallbackImageUrl);

  return {
    id: item.closetItemId,
    slot: item.slot,
    label: item.label,
    status: item.status,
    imageState: canonicalReady ? 'ready' : fallbackReady ? 'fallback' : 'processing',
    imageUrl: canonicalReady ? item.imageUrl : fallbackReady ? item.fallbackImageUrl : undefined,
  };
}

function momentCopy(
  event: AmbientCaptureCompletedEvent,
  items: readonly WardrobeMomentItem[],
): Pick<WardrobeMoment, 'headline' | 'summary' | 'supportingText'> {
  const newItems = items.filter((item) => item.status === 'new');
  const recognizedItems = items.filter((item) => item.status === 'recognized');
  const pendingItems = items.filter((item) => item.status === 'pending');
  const processing = items.some((item) => item.imageState === 'processing');

  if (pendingItems.length > 0) {
    return {
      headline: items.length > pendingItems.length ? '已记下清楚的部分' : '我还在确认这身',
      summary: items.length > pendingItems.length
        ? `${items.length - pendingItems.length} 件已记下`
        : `${pendingItems.length} 件还在确认`,
      supportingText: `${pendingItems.map((item) => item.label).join('、')}我还在确认`,
    };
  }

  if (newItems.length > 0 && recognizedItems.length > 0) {
    const familiar = recognizedItems.length === 1 ? recognizedItems[0]?.label : undefined;
    return {
      headline: familiar ? `认识${familiar}，也发现了新的` : '认识熟悉的，也发现了新的',
      summary: `${newItems.length} 件新单品 · ${recognizedItems.length} 件衣橱已有`,
      supportingText: processing ? '衣橱正在更新' : '新单品已经和熟悉的衣服放在一起了。',
    };
  }

  if (newItems.length > 0) {
    return {
      headline: '已加入你的衣橱',
      summary: `${newItems.length} 件新单品`,
      supportingText: processing ? '衣橱正在更新' : '下次穿它们，我会认得。',
    };
  }

  return {
    headline: event.repeatedOutfit ? '认出来了，是这套' : '今天这身我认得',
    summary: `${recognizedItems.length} 件衣橱已有`,
    supportingText: '今日穿着已记录',
  };
}

export function deriveWardrobeMoment(
  event?: AmbientCaptureCompletedEvent,
): WardrobeMoment | undefined {
  if (!event) return undefined;

  const items: WardrobeMomentItem[] = [
    ...event.itemSummaries.map(resolvedItem),
    ...event.pendingItems.map((item) => ({
      id: item.resolutionId,
      slot: item.slot,
      label: item.label,
      status: 'pending' as const,
      imageState: 'pending' as const,
    })),
  ];
  if (items.length === 0) return undefined;

  return {
    eventId: event.eventId,
    captureId: event.captureId,
    episodeId: event.episodeId,
    ownerUserId: event.userId,
    ...momentCopy(event, items),
    items,
    updatedAt: event.updatedAt ?? event.committedAt,
  };
}

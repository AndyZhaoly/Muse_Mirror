import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentActivity, AgentArtifact } from '../web/src/agentClient.js';
import {
  classifyMirrorArtifact,
  deriveMirrorScreenState,
} from '../web/src/components/mirror/mirrorScreenController.js';
import type {
  MirrorScreenControllerInput,
  MirrorScreenMessage,
} from '../web/src/components/mirror/mirrorScreenTypes.js';
import type { MirrorSituationDecision } from '../src/domain/mirrorSituation.js';

const idleVoice = {
  enabled: false,
  state: 'disabled' as const,
  partialTranscript: '',
  error: undefined,
};

function input(overrides: Partial<MirrorScreenControllerInput> = {}): MirrorScreenControllerInput {
  return {
    messages: [],
    activeAssistantId: null,
    responding: false,
    generating: false,
    liveActivity: [],
    hasPendingApproval: false,
    voice: idleVoice,
    agentStatusLabel: '在线',
    perceptionLabel: '镜子预览中',
    ...overrides,
  };
}

function toolActivity(
  toolName: string,
  status: AgentActivity['status'] = 'started',
): AgentActivity {
  return {
    id: `${toolName}-${status}`,
    type: status === 'failed' ? 'tool.failed' : status === 'completed' ? 'tool.completed' : 'tool.started',
    turnId: 'turn-1',
    timestamp: 1,
    status,
    toolName,
  };
}

function lookBoard(id = 'board-1'): Extract<AgentArtifact, { type: 'look_board' }> {
  return {
    type: 'look_board',
    id,
    boardStyle: 'clean_merch',
    title: '西湖散步搭配',
    hero: {
      imageUrl: '/out/hero.png',
      imageId: 'hero-1',
      mimeType: 'image/png',
      subject: 'anonymous_model',
      framing: 'full_body',
      facePolicy: 'exclude',
    },
    items: [],
    disclaimer: 'AI 预览',
    aiGenerated: true,
    layoutVersion: 'v1',
  };
}

function itemGrid(): Extract<AgentArtifact, { type: 'item_grid' }> {
  return {
    type: 'item_grid',
    id: 'grid-1',
    title: '衣柜候选',
    items: [{ id: 'item-1', name: '白衬衫', imageUrl: '/shirt.png', source: 'closet' }],
  };
}

function situationDecision(
  action: MirrorSituationDecision['action'] = 'ask_ownership',
): MirrorSituationDecision {
  return {
    action,
    reasonCodes: ['CLOSET_UNMATCHED', 'OWNERSHIP_UNKNOWN'],
    interruption: action === 'ask_ownership' ? 'ask_once' : 'none',
    needsMoreObservation: false,
    privacyPaused: false,
    eligibility: {
      wearRecord: 'prohibited',
      garmentCandidate: 'prohibited',
      closetPersistence: 'prohibited',
    },
    presentation: {
      visibility: 'foreground',
      contentKind: 'garment_ingestion',
      title: '这件衣物需要确认归属',
      detail: '只有确认后才能继续。',
      tone: 'attention',
    },
  };
}

test('empty state is idle conversation without approval or artifact', () => {
  const state = deriveMirrorScreenState(input());
  assert.equal(state.phase, 'idle');
  assert.equal(state.priority, 0);
  assert.equal(state.contentKind, 'conversation');
  assert.equal(state.caption.showTyping, false);
  assert.equal(state.caption.museTextSource, 'idle_fallback');
  assert.equal(state.showApproval, false);
  assert.equal(state.primaryArtifact, undefined);
});

test('ambient capture completion owns the passive canvas instead of stale conversation content', () => {
  const state = deriveMirrorScreenState(input({
    messages: [
      { id: 'u1', role: 'user', text: '上一轮问题' },
      { id: 'a1', role: 'assistant', text: '上一轮回答' },
    ],
    ambientCaptureEvent: {
      eventId: 'event-1',
      type: 'outfit_capture_completed',
      userId: 'user-1',
      sessionId: 'session-1',
      captureId: 'capture-1',
      episodeId: 'episode-1',
      newItemIds: ['top-1'],
      recognizedItemIds: ['bottom-1'],
      itemSummaries: [
        { closetItemId: 'top-1', slot: 'top', label: '蓝色上衣', status: 'new' },
        { closetItemId: 'bottom-1', slot: 'bottom', label: '米色长裤', status: 'recognized' },
      ],
      repeatedOutfit: false,
      committedAt: '2026-08-05T00:00:00.000Z',
    },
  }));

  assert.equal(state.phase, 'showing_result');
  assert.equal(state.priority, 30);
  assert.equal(state.contentKind, 'garment_ingestion');
  assert.equal(state.caption.latestUserText, undefined);
  assert.equal(state.caption.museText, undefined);
  assert.equal(state.ambientCaptureEvent?.captureId, 'capture-1');
});

test('active assistant turn hides an older ambient completion event', () => {
  const state = deriveMirrorScreenState(input({
    messages: [{ id: 'a2', role: 'assistant' }],
    activeAssistantId: 'a2',
    responding: true,
    ambientCaptureEvent: {
      eventId: 'event-1',
      type: 'outfit_capture_completed',
      userId: 'user-1',
      sessionId: 'session-1',
      captureId: 'capture-1',
      episodeId: 'episode-1',
      newItemIds: [],
      recognizedItemIds: [],
      itemSummaries: [],
      repeatedOutfit: true,
      committedAt: '2026-08-05T00:00:00.000Z',
    },
  }));

  assert.equal(state.phase, 'thinking');
  assert.equal(state.ambientCaptureEvent, undefined);
});

test('situation decision is projected as a hint without changing conversation lifecycle', () => {
  const decision = situationDecision();
  const state = deriveMirrorScreenState(input({ situationDecision: decision }));

  assert.equal(state.phase, 'idle');
  assert.equal(state.priority, 0);
  assert.equal(state.contentKind, 'garment_ingestion');
  assert.equal(state.situationDecision, decision);
  assert.equal(state.caption.museTextSource, 'idle_fallback');
});

test('hidden situation decision does not claim a situation content kind', () => {
  const decision = situationDecision('remain_silent');
  decision.presentation = {
    ...decision.presentation,
    visibility: 'hidden',
  };
  const state = deriveMirrorScreenState(input({ situationDecision: decision }));

  assert.equal(state.contentKind, 'conversation');
  assert.equal(state.situationDecision?.action, 'remain_silent');
});

test('listening outranks a completed result and does not reuse old activity', () => {
  const state = deriveMirrorScreenState(input({
    messages: [{ id: 'a1', role: 'assistant', text: '上一轮回答', activity: [toolActivity('get_weather')] }],
    liveActivity: [toolActivity('observe_current_frame')],
    voice: { ...idleVoice, enabled: true, state: 'listening' },
  }));
  assert.equal(state.phase, 'listening');
  assert.equal(state.priority, 50);
  assert.equal(state.caption.activityLabel, undefined);
});

test('recognizing projects partial transcript without mutating messages', () => {
  const messages: MirrorScreenMessage[] = [{ id: 'u1', role: 'user', text: '正式消息' }];
  const state = deriveMirrorScreenState(input({
    messages,
    voice: { ...idleVoice, enabled: true, state: 'recognizing', partialTranscript: '晚上要去……' },
  }));
  assert.equal(state.phase, 'recognizing');
  assert.equal(state.caption.latestUserText, '晚上要去……');
  assert.equal(messages[0]?.text, '正式消息');
});

test('empty active assistant stays in the active turn and hides the previous answer', () => {
  const state = deriveMirrorScreenState(input({
    messages: [
      { id: 'a1', role: 'assistant', text: '上一轮答案' },
      { id: 'u2', role: 'user', text: '新问题' },
      { id: 'a2', role: 'assistant', isTyping: false },
    ],
    activeAssistantId: 'a2',
    responding: true,
  }));
  assert.equal(state.phase, 'thinking');
  assert.equal(state.ownerMessageId, 'a2');
  assert.equal(state.caption.museText, undefined);
  assert.equal(state.caption.showTyping, true);
});

test('active tool activity is converted to product language', () => {
  const state = deriveMirrorScreenState(input({
    messages: [{
      id: 'a1',
      role: 'assistant',
      activity: [toolActivity('observe_current_frame')],
    }],
    activeAssistantId: 'a1',
    responding: true,
  }));
  assert.equal(state.phase, 'thinking');
  assert.equal(state.caption.activityLabel, '正在看当前画面');
  assert.doesNotMatch(state.caption.activityLabel ?? '', /observe_current_frame/);
  assert.equal(state.caption.showTyping, true);
});

test('live activity is used only for an existing active assistant', () => {
  const active = deriveMirrorScreenState(input({
    messages: [{ id: 'a1', role: 'assistant' }],
    activeAssistantId: 'a1',
    liveActivity: [toolActivity('recommend_from_closet')],
    responding: true,
  }));
  const inactive = deriveMirrorScreenState(input({
    liveActivity: [toolActivity('recommend_from_closet')],
  }));
  assert.equal(active.caption.activityLabel, '正在查真实衣柜');
  assert.equal(inactive.caption.activityLabel, undefined);
});

test('active commentary replaces typing while keeping thinking phase', () => {
  const state = deriveMirrorScreenState(input({
    messages: [{ id: 'a1', role: 'assistant', commentary: '我先看一下当前画面。' }],
    activeAssistantId: 'a1',
    responding: true,
  }));
  assert.equal(state.phase, 'thinking');
  assert.equal(state.caption.museText, '我先看一下当前画面。');
  assert.equal(state.caption.museTextSource, 'commentary');
  assert.equal(state.caption.showTyping, false);
});

test('active final answer replaces commentary', () => {
  const state = deriveMirrorScreenState(input({
    messages: [{
      id: 'a1',
      role: 'assistant',
      commentary: '我先确认一下。',
      text: '我能看到你的上半身。',
    }],
    activeAssistantId: 'a1',
  }));
  assert.equal(state.phase, 'showing_result');
  assert.equal(state.caption.museText, '我能看到你的上半身。');
  assert.equal(state.caption.museTextSource, 'answer');
});

test('speaking keeps the active result visible', () => {
  const state = deriveMirrorScreenState(input({
    messages: [{ id: 'a1', role: 'assistant', text: '这套可以。' }],
    activeAssistantId: 'a1',
    voice: { ...idleVoice, enabled: true, state: 'speaking' },
  }));
  assert.equal(state.phase, 'speaking');
  assert.equal(state.caption.museText, '这套可以。');
});

test('speaking also keeps the latest completed result visible without active turn', () => {
  const state = deriveMirrorScreenState(input({
    messages: [{ id: 'a1', role: 'assistant', text: '完成了。' }],
    voice: { ...idleVoice, enabled: true, state: 'speaking' },
  }));
  assert.equal(state.phase, 'speaking');
  assert.equal(state.priority, 40);
  assert.equal(state.caption.museText, '完成了。');
});

test('pending approval has highest priority', () => {
  const state = deriveMirrorScreenState(input({
    messages: [{ id: 'a1', role: 'assistant', text: '需要你确认照片使用。' }],
    activeAssistantId: 'a1',
    hasPendingApproval: true,
    voice: { ...idleVoice, enabled: true, state: 'speaking' },
  }));
  assert.equal(state.phase, 'awaiting_approval');
  assert.equal(state.priority, 100);
  assert.equal(state.showApproval, true);
});

test('approval preserves its explanatory caption', () => {
  const state = deriveMirrorScreenState(input({
    messages: [{ id: 'a1', role: 'assistant', text: '生成预览需要使用当前照片。' }],
    activeAssistantId: 'a1',
    hasPendingApproval: true,
  }));
  assert.equal(state.caption.museText, '生成预览需要使用当前照片。');
  assert.equal(state.caption.museTextSource, 'answer');
});

test('active Look Board owns the primary artifact and content kind', () => {
  const state = deriveMirrorScreenState(input({
    messages: [{ id: 'a1', role: 'assistant', text: '搭好了。', artifacts: [lookBoard()] }],
    activeAssistantId: 'a1',
  }));
  assert.equal(state.primaryArtifact?.ownerMessageId, 'a1');
  assert.equal(state.primaryArtifact?.summary, '西湖散步搭配 · Look Board 已生成');
  assert.equal(state.contentKind, 'look_board');
});

test('new active turn never falls back to a previous Look Board', () => {
  const state = deriveMirrorScreenState(input({
    messages: [
      { id: 'a1', role: 'assistant', text: '旧结果', artifacts: [lookBoard()] },
      { id: 'u2', role: 'user', text: '普通问题' },
      { id: 'a2', role: 'assistant' },
    ],
    activeAssistantId: 'a2',
    responding: true,
  }));
  assert.equal(state.primaryArtifact, undefined);
  assert.equal(state.contentKind, 'conversation');
});

test('latest completed assistant owns artifact projection instead of older messages', () => {
  const state = deriveMirrorScreenState(input({
    messages: [
      { id: 'a1', role: 'assistant', text: '旧结果', artifacts: [lookBoard()] },
      { id: 'u2', role: 'user', text: '普通问题' },
      { id: 'a2', role: 'assistant', text: '普通文字回答' },
    ],
  }));
  assert.equal(state.ownerMessageId, 'a2');
  assert.equal(state.caption.museText, '普通文字回答');
  assert.equal(state.primaryArtifact, undefined);
});

test('latest completed assistant can own a closet artifact', () => {
  const state = deriveMirrorScreenState(input({
    messages: [{ id: 'a1', role: 'assistant', text: '这是衣柜候选。', artifacts: [itemGrid()] }],
  }));
  assert.equal(state.primaryArtifact?.ownerMessageId, 'a1');
  assert.equal(state.contentKind, 'closet');
});

test('notice artifacts are never primary', () => {
  const notice: AgentArtifact = { type: 'notice', id: 'n1', level: 'info', text: '提示' };
  const state = deriveMirrorScreenState(input({
    messages: [{ id: 'a1', role: 'assistant', text: '知道了。', artifacts: [notice] }],
  }));
  assert.equal(state.primaryArtifact, undefined);
  assert.equal(state.contentKind, 'conversation');
});

test('try-on image is classified separately from a generic visual', () => {
  const tryOn: Extract<AgentArtifact, { type: 'image' }> = {
    type: 'image',
    id: 'try-1',
    label: '上身预览',
    source: 'ai_try_on',
    url: '/try.png',
    mimeType: 'image/png',
    aiGenerated: true,
    disclaimer: 'AI 预览',
  };
  assert.equal(classifyMirrorArtifact(tryOn), 'try_on');
});

test('artifact classification covers current visual and product types', () => {
  const itemVisual: Extract<AgentArtifact, { type: 'item_visual' }> = {
    type: 'item_visual',
    id: 'visual-1',
    source: 'concept',
    imageUrl: '/shoe.png',
    label: '白鞋',
    category: 'shoes',
    badge: 'AI 概念单品',
  };
  const products: Extract<AgentArtifact, { type: 'product_cards' }> = {
    type: 'product_cards',
    id: 'products-1',
    title: '真实商品',
    products: [],
  };
  assert.equal(classifyMirrorArtifact(itemVisual), 'visual');
  assert.equal(classifyMirrorArtifact(products), 'products');
});

test('unknown artifact classification safely falls back to conversation', () => {
  const unknown = { type: 'future_artifact', id: 'future-1' } as unknown as AgentArtifact;
  assert.equal(classifyMirrorArtifact(unknown), 'conversation');
});

test('voice error is nonblocking when a readable result exists', () => {
  const state = deriveMirrorScreenState(input({
    messages: [{ id: 'a1', role: 'assistant', text: '文字结果仍然可读。' }],
    voice: { ...idleVoice, enabled: true, state: 'error', error: 'TTS 暂不可用' },
  }));
  assert.equal(state.phase, 'showing_result');
  assert.equal(state.caption.museText, '文字结果仍然可读。');
  assert.equal(state.voice.error, 'TTS 暂不可用');
});

test('invalid active assistant ID safely falls back to the completed answer', () => {
  const state = deriveMirrorScreenState(input({
    messages: [{ id: 'a1', role: 'assistant', text: '最近完成的回答' }],
    activeAssistantId: 'missing',
  }));
  assert.equal(state.phase, 'showing_result');
  assert.equal(state.ownerMessageId, 'a1');
  assert.equal(state.caption.museText, '最近完成的回答');
});

test('generating without an active message uses the visual fallback without stale activity', () => {
  const state = deriveMirrorScreenState(input({
    generating: true,
    liveActivity: [toolActivity('observe_current_frame')],
  }));
  assert.equal(state.phase, 'thinking');
  assert.equal(state.caption.activityLabel, '正在准备视觉结果');
  assert.equal(state.caption.showTyping, true);
});

test('controller does not mutate messages, artifacts, or activity', () => {
  const artifact = lookBoard();
  const activity = toolActivity('create_style_visual');
  const messages: MirrorScreenMessage[] = [{
    id: 'a1',
    role: 'assistant',
    text: '生成中',
    artifacts: [artifact],
    activity: [activity],
  }];
  const before = JSON.stringify({ messages, activity: [activity] });
  deriveMirrorScreenState(input({ messages, activeAssistantId: 'a1', liveActivity: [activity] }));
  assert.equal(JSON.stringify({ messages, activity: [activity] }), before);
  assert.equal(messages[0]?.artifacts?.[0], artifact);
});

test('sequence A preserves captions from listening through speaking', () => {
  const idle = deriveMirrorScreenState(input());
  const listening = deriveMirrorScreenState(input({ voice: { ...idleVoice, enabled: true, state: 'listening' } }));
  const recognizing = deriveMirrorScreenState(input({
    voice: { ...idleVoice, enabled: true, state: 'recognizing', partialTranscript: '今晚去聚餐' },
  }));
  const thinking = deriveMirrorScreenState(input({
    messages: [{ id: 'u1', role: 'user', text: '今晚去聚餐' }, { id: 'a1', role: 'assistant' }],
    activeAssistantId: 'a1',
    responding: true,
  }));
  const commentary = deriveMirrorScreenState(input({
    messages: [{ id: 'u1', role: 'user', text: '今晚去聚餐' }, { id: 'a1', role: 'assistant', commentary: '我先看看衣柜。' }],
    activeAssistantId: 'a1',
    responding: true,
  }));
  const result = deriveMirrorScreenState(input({
    messages: [{ id: 'u1', role: 'user', text: '今晚去聚餐' }, { id: 'a1', role: 'assistant', text: '这套适合今晚。' }],
    activeAssistantId: 'a1',
  }));
  const speaking = deriveMirrorScreenState(input({
    messages: [{ id: 'u1', role: 'user', text: '今晚去聚餐' }, { id: 'a1', role: 'assistant', text: '这套适合今晚。' }],
    activeAssistantId: 'a1',
    voice: { ...idleVoice, enabled: true, state: 'speaking' },
  }));
  const completed = deriveMirrorScreenState(input({
    messages: [{ id: 'u1', role: 'user', text: '今晚去聚餐' }, { id: 'a1', role: 'assistant', text: '这套适合今晚。' }],
  }));

  assert.deepEqual(
    [idle.phase, listening.phase, recognizing.phase, thinking.phase, commentary.phase, result.phase, speaking.phase, completed.phase],
    ['idle', 'listening', 'recognizing', 'thinking', 'thinking', 'showing_result', 'speaking', 'showing_result'],
  );
  assert.equal(recognizing.caption.latestUserText, '今晚去聚餐');
  assert.equal(commentary.caption.museText, '我先看看衣柜。');
  assert.equal(speaking.caption.museText, '这套适合今晚。');
});

test('sequence B keeps a visual tool turn scoped from activity to final answer', () => {
  const old: MirrorScreenMessage = { id: 'a0', role: 'assistant', text: '旧答案' };
  const started = deriveMirrorScreenState(input({
    messages: [old, { id: 'u1', role: 'user', text: '看看外套' }, { id: 'a1', role: 'assistant' }],
    activeAssistantId: 'a1',
    responding: true,
    liveActivity: [toolActivity('observe_current_frame')],
  }));
  const commentary = deriveMirrorScreenState(input({
    messages: [old, { id: 'u1', role: 'user', text: '看看外套' }, { id: 'a1', role: 'assistant', commentary: '我在看现在的画面。' }],
    activeAssistantId: 'a1',
    responding: true,
  }));
  const final = deriveMirrorScreenState(input({
    messages: [old, { id: 'u1', role: 'user', text: '看看外套' }, { id: 'a1', role: 'assistant', text: '能看到这件外套的上半部分。' }],
    activeAssistantId: 'a1',
  }));
  assert.equal(started.caption.museText, undefined);
  assert.equal(started.caption.activityLabel, '正在看当前画面');
  assert.equal(commentary.caption.museText, '我在看现在的画面。');
  assert.equal(final.caption.museText, '能看到这件外套的上半部分。');
});

test('sequence C never restores an old Look Board summary after a new ordinary turn', () => {
  const oldBoard: MirrorScreenMessage = {
    id: 'a1',
    role: 'assistant',
    text: '旧 Look Board',
    artifacts: [lookBoard()],
  };
  const old = deriveMirrorScreenState(input({ messages: [oldBoard] }));
  const thinking = deriveMirrorScreenState(input({
    messages: [oldBoard, { id: 'u2', role: 'user', text: '换个话题' }, { id: 'a2', role: 'assistant' }],
    activeAssistantId: 'a2',
    responding: true,
  }));
  const final = deriveMirrorScreenState(input({
    messages: [oldBoard, { id: 'u2', role: 'user', text: '换个话题' }, { id: 'a2', role: 'assistant', text: '当然，可以聊别的。' }],
  }));
  assert.equal(old.contentKind, 'look_board');
  assert.equal(thinking.primaryArtifact, undefined);
  assert.equal(final.primaryArtifact, undefined);
  assert.equal(final.contentKind, 'conversation');
});

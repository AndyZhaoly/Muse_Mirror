import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  deriveCurrentCanvasContent,
  toCanvasPlainText,
} from '../web/src/components/mirror/mirrorCanvasContent.js';

test('Mirror Canvas derives the latest user and completed Muse answer', () => {
  const messages = [
    { id: 'a1', role: 'assistant' as const, text: '较早的回答' },
    { id: 'u1', role: 'user' as const, text: '第一问' },
    { id: 'u2', role: 'user' as const, text: '现在这一问' },
    { id: 'a2', role: 'assistant' as const, text: '当前回答' },
  ];

  assert.deepEqual(deriveCurrentCanvasContent(messages), {
    latestUserText: '现在这一问',
    latestAssistantText: '当前回答',
    latestAssistantCommentary: undefined,
    assistantMessageId: 'a2',
    assistantIsTyping: false,
  });
});

test('active commentary is the temporary current-moment caption, not a final answer', () => {
  const result = deriveCurrentCanvasContent([
    { id: 'a1', role: 'assistant', text: '上一轮完整答案' },
    { id: 'u1', role: 'user', text: '帮我看一下当前画面' },
    { id: 'a2', role: 'assistant', commentary: '我先看一下当前画面。', isTyping: true },
  ], 'a2');

  assert.equal(result.latestAssistantCommentary, '我先看一下当前画面。');
  assert.equal(result.latestAssistantText, undefined);
  assert.equal(result.assistantMessageId, 'a2');
  assert.equal(result.assistantIsTyping, false);
});

test('streamed answer replaces commentary once final-answer text arrives', () => {
  const result = deriveCurrentCanvasContent([
    { id: 'u1', role: 'user', text: '你能看到我吗' },
    {
      id: 'a1',
      role: 'assistant',
      commentary: '我先确认当前画面。',
      text: '我能看到你的上半身，',
      isTyping: true,
    },
  ], 'a1');

  assert.equal(result.latestAssistantText, '我能看到你的上半身，');
  assert.equal(result.latestAssistantCommentary, undefined);
  assert.equal(result.assistantIsTyping, false);
});

test('empty active assistant stays scoped to the current turn while waiting for the first packet', () => {
  const messages = [
    { id: 'a1', role: 'assistant' as const, text: '上一轮答案' },
    { id: 'u1', role: 'user' as const, text: '新问题' },
    { id: 'a2', role: 'assistant' as const, isTyping: false },
  ];

  assert.deepEqual(deriveCurrentCanvasContent(messages, 'a2'), {
    latestUserText: '新问题',
    latestAssistantText: undefined,
    latestAssistantCommentary: undefined,
    assistantMessageId: 'a2',
    assistantIsTyping: true,
  });

  const typing = deriveCurrentCanvasContent([
    ...messages.slice(0, -1),
    { id: 'a2', role: 'assistant' as const, isTyping: true },
  ], 'a2');
  assert.equal(typing.latestAssistantText, undefined);
  assert.equal(typing.assistantIsTyping, true);
});

test('whitespace-only active content never leaks a completed answer from the previous turn', () => {
  const result = deriveCurrentCanvasContent([
    { id: 'a1', role: 'assistant', text: '黑裤可以，换白鞋会更轻松。' },
    { id: 'u1', role: 'user', text: '再看看我刚换的外套。' },
    { id: 'a2', role: 'assistant', text: '  ', commentary: '\n', isTyping: false },
  ], 'a2');

  assert.equal(result.latestAssistantText, undefined);
  assert.equal(result.latestAssistantCommentary, undefined);
  assert.equal(result.assistantMessageId, 'a2');
  assert.equal(result.assistantIsTyping, true);
});

test('completed answer is used only when there is no active assistant turn', () => {
  const messages = [
    { id: 'u1', role: 'user' as const, text: '上一问' },
    { id: 'a1', role: 'assistant' as const, text: '上一轮完整答案' },
  ];

  assert.deepEqual(deriveCurrentCanvasContent(messages), {
    latestUserText: '上一问',
    latestAssistantText: '上一轮完整答案',
    latestAssistantCommentary: undefined,
    assistantMessageId: 'a1',
    assistantIsTyping: false,
  });
});

test('Mirror Canvas stays presentation-only and approval is not duplicated', () => {
  const app = readFileSync('web/src/App.tsx', 'utf8');
  const canvas = readFileSync('web/src/components/mirror/MirrorAgentCanvas.tsx', 'utf8');
  const drawer = readFileSync('web/src/components/mirror/ConversationDrawer.tsx', 'utf8');

  assert.equal((app.match(/<ConsentCard/g) ?? []).length, 1);
  assert.doesNotMatch(canvas, /MessageBubble|ActivityTimeline|messages\.map/);
  assert.match(drawer, /aria-expanded/);
  assert.match(drawer, /aria-controls/);
  assert.match(app, /id="complete-conversation"/);
});

test('Canvas plain-text projection removes Markdown chrome without changing source data', () => {
  const source = '## 建议\n- **浅蓝衬衫**，参考[完整说明](https://example.com)。';
  const original = source.slice();

  assert.equal(toCanvasPlainText(source), '建议\n浅蓝衬衫，参考完整说明。');
  assert.equal(source, original);
});

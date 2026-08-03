import assert from 'node:assert/strict';
import test from 'node:test';
import { OutfitEvaluatorService } from '../src/services/outfitEvaluatorService.js';
import { createEmptySessionState } from '../src/runtime/stateStore.js';
import type { FashionAgentContext, OutfitCandidate } from '../src/types.js';

const context: FashionAgentContext = {
  sessionId: 'test',
  userId: 'test',
  turnId: 'test',
  locale: 'zh-CN',
  nowIso: new Date().toISOString(),
  permissions: {
    allowVisualAnalysis: false,
    allowAiImageGeneration: false,
    allowPhotoUseForTryOn: false,
    allowPersistentMemory: false,
  },
  state: createEmptySessionState(),
};

test('complete coherent outfit passes the lightweight evaluator', () => {
  const outfit: OutfitCandidate = {
    id: 'good',
    occasion: '朋友晚餐',
    items: [
      { category: 'top', name: '白色 T 恤', color: 'white' },
      { category: 'outerwear', name: '卡其夹克', color: 'khaki' },
      { category: 'bottom', name: '蓝色直筒牛仔裤', color: 'blue' },
      { category: 'shoes', name: '白色运动鞋', color: 'white' },
    ],
  };
  const result = new OutfitEvaluatorService().evaluate(outfit, context);
  assert.equal(result.pass, true);
});

test('formal outfit without shoes does not pass', () => {
  const outfit: OutfitCandidate = {
    id: 'incomplete',
    occasion: '商务会议',
    items: [
      { category: 'top', name: '白衬衫', color: 'white' },
      { category: 'bottom', name: '灰色西裤', color: 'gray' },
    ],
  };
  const result = new OutfitEvaluatorService().evaluate(outfit, context);
  assert.equal(result.pass, false);
  assert.ok(result.issues.some((issue) => issue.includes('鞋子')));
});

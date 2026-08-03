import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { FashionTurnHarness } from '../src/server/gemmaFashionRuntime.js';
import { createServiceContainer } from '../src/runtime/serviceContainer.js';
import { InMemorySessionStateStore } from '../src/runtime/stateStore.js';
import type {
  FashionTurnInput,
  OutfitCandidate,
  VisualObservation,
} from '../src/types.js';

function createHarness(
  brain: ConstructorParameters<typeof FashionTurnHarness>[0]['brain'],
  options: {
    config?: Partial<ReturnType<typeof loadConfig>>;
  } = {},
) {
  const config = { ...loadConfig(), mockTools: true, ...options.config };
  const services = createServiceContainer(config);
  const stateStore = new InMemorySessionStateStore();
  return {
    harness: new FashionTurnHarness({
      config,
      services,
      stateStore,
      histories: new Map(),
      brain,
    }),
    services,
    stateStore,
  };
}

function input(overrides: Partial<FashionTurnInput> = {}): FashionTurnInput {
  return {
    sessionId: 'harness-test',
    userId: 'user',
    message: 'hello',
    locale: 'zh-CN',
    permissions: {
      allowVisualAnalysis: false,
      allowAiImageGeneration: true,
      allowPhotoUseForTryOn: false,
      allowPersistentMemory: false,
    },
    ...overrides,
  };
}

const observation: VisualObservation = {
  visibleItems: [
    { category: 'top', description: '浅色上衣', color: 'white', fit: 'regular' },
  ],
  mainColors: ['white'],
  silhouette: 'relaxed',
  proportionNotes: [],
  formality: 'casual',
  strengths: ['清爽'],
  issues: [],
  uncertainties: [],
};

test('greeting can be answered by Muse planning with zero tools', async () => {
  const calls: string[] = [];
  const { harness } = createHarness(async (args) => {
    calls.push(args.mode ?? 'unknown');
    return JSON.stringify({
      answerDraft: '在，我是 Muse Mirror。',
      confidence: 0.95,
      toolCalls: [],
    });
  });

  const result = await harness.runTurn(input({ message: '你好' }));
  assert.equal(result.status, 'completed');
  assert.equal(result.text, '在，我是 Muse Mirror。');
  assert.deepEqual(calls, ['plan']);
  assert.equal(result.decisionSummary, undefined);
  assert.ok(result.activity.some((item) => item.label === 'Muse 已理解本轮需求'));
  assert.equal(result.activity.some((item) => item.type.startsWith('wardrobe.') || item.type.startsWith('perception.')), false);
});

test('tool-dependent request is handled by Muse main agent, not a direct gate', async () => {
  const calls: string[] = [];
  const { harness, services } = createHarness(async (args) => {
    calls.push(args.mode ?? 'unknown');
    if (args.mode === 'synthesis') {
      assert.equal(args.visualObservation?.visibleItems.length, 1);
      return JSON.stringify({ message: '我看到了当前画面，颜色是清爽的。' });
    }
    return JSON.stringify({
      confidence: 0.9,
      toolCalls: [{ name: 'observe_current_frame', arguments: {} }],
    });
  });
  services.vision.analyze = async () => observation;

  const result = await harness.runTurn(
    input({
      message: '你好，你现在能看到我穿什么吗？',
      cameraLocalActive: true,
      permissions: { allowVisualAnalysis: true },
      attachments: [
        {
          id: 'photo_mixed',
          kind: 'user_photo',
          mimeType: 'image/jpeg',
          localPath: path.resolve('./examples/mock_user_photo.jpg'),
          makeCurrent: true,
        },
      ],
    }),
  );

  assert.equal(result.status, 'completed');
  assert.match(result.text, /当前画面|颜色/);
  assert.deepEqual(calls, ['plan', 'synthesis']);
  assert.ok(result.activity.some((item) => item.type === 'perception.completed'));
});

test('Muse main agent can call multiple tools in the same turn', async () => {
  const calls: string[] = [];
  const { harness, services } = createHarness(async (args) => {
    calls.push(args.mode ?? 'unknown');
    if (args.mode === 'plan') {
      return JSON.stringify({
        confidence: 0.9,
        toolCalls: [
          { name: 'observe_current_frame', arguments: {} },
          { name: 'recommend_from_closet', arguments: { query: '聚餐', limit: 12 } },
        ],
      });
    }
    assert.equal(args.visualObservation?.visibleItems.length, 1);
    assert.ok(args.closetItems.length > 0);
    return JSON.stringify({
      message: '我会结合当前画面和衣柜单品来搭。',
      selectedItemIds: args.closetItems.slice(0, 2).map((item) => item.id),
    });
  });
  services.vision.analyze = async () => observation;

  const result = await harness.runTurn(input({
    message: '看一下我现在这身，再用衣柜搭一套',
    cameraLocalActive: true,
    permissions: { allowVisualAnalysis: true },
    attachments: [
      {
        id: 'photo_multi',
        kind: 'user_photo',
        mimeType: 'image/jpeg',
        localPath: path.resolve('./examples/mock_user_photo.jpg'),
        makeCurrent: true,
      },
    ],
  }));
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['plan', 'synthesis']);
  assert.ok(result.activity.some((item) => item.label === 'Muse 的计划' && item.displayDetail?.includes('真实衣柜')));
  assert.ok(result.activity.some((item) => item.type === 'perception.completed'));
  assert.ok(result.activity.some((item) => item.type === 'wardrobe.completed'));
  assert.ok(result.decisionSummary);
  assert.ok(result.decisionSummary.checked.some((item) => item.startsWith('当前画面')));
  assert.ok(result.decisionSummary.checked.some((item) => item.startsWith('真实衣柜')));
});

test('simple question uses Muse planning plus one final model call without tools', async () => {
  const calls: string[] = [];
  const { harness } = createHarness(async (args) => {
    calls.push(args.mode ?? 'unknown');
    if (args.mode === 'plan') {
      return JSON.stringify({ confidence: 0.4, toolCalls: [] });
    }
    return JSON.stringify({
      message: '今天可以走清爽一点的路线。',
    });
  });

  const result = await harness.runTurn(input({ message: '今天穿什么感觉比较好？' }));
  assert.equal(result.status, 'completed');
  assert.equal(result.text, '今天可以走清爽一点的路线。');
  assert.deepEqual(calls, ['plan', 'synthesis']);
  assert.ok(result.activity.some((item) => item.label === 'Muse 已理解本轮需求'));
  assert.equal(result.activity.some((item) => item.type.startsWith('wardrobe.') || item.type.startsWith('perception.')), false);
});

test('free suggestion saves outfit without closet cards', async () => {
  const { harness } = createHarness(async (args) => {
    if (args.mode === 'plan') {
      return JSON.stringify({
        answerDraft: '柜子外我会给你一套亚麻衬衫配高腰阔腿裤。',
        confidence: 0.9,
        toolCalls: [],
        saveOutfit: {
          id: 'linen_free',
          name: '亚麻松弛感',
          items: [
            { category: 'top', name: '亚麻衬衫', color: '米色', source: 'suggested' },
            { category: 'bottom', name: '高腰阔腿裤', color: '白色', source: 'suggested' },
            { category: 'shoes', name: '皮凉鞋', color: '棕色', source: 'suggested' },
          ],
        },
      });
    }
    return JSON.stringify({
      message: '柜子外我会给你一套亚麻衬衫配高腰阔腿裤。',
    });
  });

  const result = await harness.runTurn(input({ message: '不用衣柜，自由想一套' }));
  assert.equal(result.status, 'completed');
  assert.equal(result.artifacts.some((artifact) => artifact.type === 'item_grid'), false);
  assert.equal(result.state.activeOutfitId, 'linen_free');
});

test('truncated structured response never renders raw JSON braces to the user', async () => {
  const { harness } = createHarness(async (args) => {
    if (args.mode === 'plan') {
      return JSON.stringify({ confidence: 0.4, toolCalls: [] });
    }
    return '{"text":"这套方向可以，先保持清爽利落';
  });

  const result = await harness.runTurn(input({ message: '今天怎么穿？' }));
  assert.equal(result.status, 'completed');
  assert.equal(result.text, '这套方向可以，先保持清爽利落');
});

test('current outfit question analyzes the authorized frame before synthesis', async () => {
  const streamedLabels: string[] = [];
  const { harness, services } = createHarness(async (args) => {
    if (args.mode === 'plan') {
      return JSON.stringify({ toolCalls: [{ name: 'observe_current_frame', arguments: {} }], confidence: 0.4 });
    }
    assert.equal(args.visualObservation?.visibleItems.length, 1);
    return JSON.stringify({ message: '这身清爽，浅色上衣可以保留。' });
  });
  services.vision.analyze = async () => observation;

  const result = await harness.runTurn(
    input({
      message: '我这样可以吗？',
      onActivity: (activity) => {
        streamedLabels.push(activity.label ?? activity.type);
      },
      permissions: { allowVisualAnalysis: true },
      attachments: [
        {
          id: 'photo_1',
          kind: 'user_photo',
          mimeType: 'image/jpeg',
          localPath: path.resolve('./examples/mock_user_photo.jpg'),
          makeCurrent: true,
        },
      ],
    }),
  );

  assert.equal(result.status, 'completed');
  assert.match(result.text, /清爽/);
  assert.ok(streamedLabels.includes('正在看当前画面'));
  assert.ok(result.activity.some((item) => item.label === '看完当前画面'));
});

test('mirror visibility question observes current frame and does not search closet', async () => {
  const calls: string[] = [];
  const { harness, services } = createHarness(async (args) => {
    calls.push(args.mode ?? 'unknown');
    if (args.mode === 'plan') {
      return JSON.stringify({ toolCalls: [{ name: 'observe_current_frame', arguments: {} }], confidence: 0.9 });
    }
    assert.equal(args.visualObservation?.visibleItems.length, 1);
    return JSON.stringify({ message: '能看到你当前画面的一部分。' });
  });
  services.vision.analyze = async () => observation;
  services.closet.search = () => {
    throw new Error('closet should not be called');
  };

  const result = await harness.runTurn(
    input({
      message: '现在能看到我吗？',
      cameraLocalActive: true,
      permissions: { allowVisualAnalysis: true },
      attachments: [
        {
          id: 'photo_status',
          kind: 'user_photo',
          mimeType: 'image/jpeg',
          localPath: path.resolve('./examples/mock_user_photo.jpg'),
          makeCurrent: true,
        },
      ],
    }),
  );

  assert.equal(result.status, 'completed');
  assert.match(result.text, /看到/);
  assert.deepEqual(calls, ['plan', 'synthesis']);
  assert.equal(result.activity.some((item) => item.type.startsWith('wardrobe.')), false);
  assert.ok(result.activity.some((item) => item.label === '看完当前画面'));
});

test('unsupported visual direct answer is escalated to perception evidence', async () => {
  const calls: string[] = [];
  let visionCalls = 0;
  const { harness, services } = createHarness(async (args) => {
    calls.push(args.mode ?? 'unknown');
    if (args.mode === 'plan') {
      return JSON.stringify({
        answerDraft: '目前我还没有看到你的画面。',
        confidence: 0.95,
        toolCalls: [],
      });
    }
    assert.equal(args.visualObservation?.visibleItems.length, 1);
    return JSON.stringify({ message: '能看到一部分：浅色上衣比较清爽。' });
  });
  services.vision.analyze = async () => {
    visionCalls += 1;
    return observation;
  };

  const result = await harness.runTurn(
    input({
      message: '你能看见我吗？',
      cameraLocalActive: true,
      permissions: { allowVisualAnalysis: true },
      attachments: [
        {
          id: 'photo_visual_guard',
          kind: 'user_photo',
          mimeType: 'image/jpeg',
          localPath: path.resolve('./examples/mock_user_photo.jpg'),
          makeCurrent: true,
        },
      ],
    }),
  );

  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['plan', 'synthesis']);
  assert.equal(visionCalls, 1);
  assert.match(result.text, /看到|浅色上衣/);
  assert.ok(result.activity.some((item) => item.type === 'perception.completed'));
});

test('mirror visibility question is honest when local camera is on but backend has no frame', async () => {
  const { harness } = createHarness(async (args) => {
    if (args.mode === 'plan') {
      return JSON.stringify({ toolCalls: [{ name: 'observe_current_frame', arguments: {} }], confidence: 0.9 });
    }
    assert.equal(args.visualObservation, undefined);
    return JSON.stringify({ message: '我这边还没有拿到清晰的视觉分析结果。' });
  });

  const result = await harness.runTurn(
    input({
      message: '现在呢',
      cameraLocalActive: true,
      permissions: { allowVisualAnalysis: true },
    }),
  );

  assert.equal(result.status, 'completed');
  assert.match(result.text, /没有拿到清晰的视觉分析结果|还没拿到清晰的视觉分析结果|没有可分析的镜子画面/);
  assert.equal(result.activity.some((item) => item.type.startsWith('wardrobe.')), false);
});

test('Muse plan can require mirror observation before synthesis', async () => {
  const { harness, services } = createHarness(async (args) => {
    if (args.mode === 'synthesis') {
      assert.equal(args.visualObservation?.visibleItems.length, 1);
      return JSON.stringify({ message: '我看到了当前画面，会按这身继续判断。' });
    }
    return JSON.stringify({
      confidence: 0.9,
      toolCalls: [{ name: 'observe_current_frame', arguments: {} }],
    });
  });
  services.vision.analyze = async () => observation;

  const result = await harness.runTurn(
    input({
      message: '帮我判断一下',
      cameraLocalActive: true,
      permissions: { allowVisualAnalysis: true },
      attachments: [
        {
          id: 'photo_decision',
          kind: 'user_photo',
          mimeType: 'image/jpeg',
          localPath: path.resolve('./examples/mock_user_photo.jpg'),
          makeCurrent: true,
        },
      ],
    }),
  );

  assert.equal(result.status, 'completed');
  assert.match(result.text, /当前画面/);
  assert.ok(result.activity.some((item) => item.label === '看完当前画面'));
});

test('fresh visual cache avoids a new vision model call', async () => {
  const { harness, services, stateStore } = createHarness(async (args) => {
    if (args.mode === 'plan') return JSON.stringify({ toolCalls: [{ name: 'observe_current_frame', arguments: {} }], confidence: 0.4 });
    assert.equal(args.visualObservation?.mainColors[0], 'white');
    return JSON.stringify({ message: '我用刚才的画面观察继续看。' });
  }, {
    config: { visualCacheTtlMs: 60000 },
  });
  stateStore.get('harness-test').visualCache = {
    observation,
    cachedAt: new Date().toISOString(),
    source: 'quick',
  };
  services.vision.analyze = async () => {
    throw new Error('vision should not be called');
  };

  const result = await harness.runTurn(
    input({
      message: '我这样可以吗？',
      permissions: { allowVisualAnalysis: true },
    }),
  );

  assert.equal(result.status, 'completed');
  assert.ok(result.activity.some((item) => item.label === '读取刚才的画面观察'));
});

test('expired visual cache uses the default Gemma4 vision pass without deep review', async () => {
  const calls: string[] = [];
  const { harness, services, stateStore } = createHarness(async (args) => {
    if (args.mode === 'plan') return JSON.stringify({ toolCalls: [{ name: 'observe_current_frame', arguments: {} }], confidence: 0.4 });
    assert.equal(args.visualObservation?.mainColors[0], 'white');
    return JSON.stringify({ message: '我重新看清楚了。' });
  }, {
    config: {
      visualCacheTtlMs: 1,
      quickVisionModel: 'gemma4-vision-test',
      deepVisionModel: 'qwen-deep-disabled',
    },
  });
  stateStore.get('harness-test').visualCache = {
    observation,
    cachedAt: new Date(Date.now() - 10000).toISOString(),
    source: 'quick',
  };
  services.vision.analyze = async (_image, _focus, options = {}) => {
    calls.push(options.model ?? 'default');
    return observation;
  };

  const result = await harness.runTurn(
    input({
      message: '仔细看我这样可以吗？',
      permissions: { allowVisualAnalysis: true },
      attachments: [
        {
          id: 'photo_deep',
          kind: 'user_photo',
          mimeType: 'image/jpeg',
          localPath: path.resolve('./examples/mock_user_photo.jpg'),
          makeCurrent: true,
        },
      ],
    }),
  );

  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['gemma4-vision-test']);
  assert.equal(stateStore.get('harness-test').visualCache?.source, 'quick');
});

test('deep vision review is opt-in', async () => {
  const calls: string[] = [];
  const deepObservation: VisualObservation = {
    ...observation,
    mainColors: ['black'],
    uncertainties: [],
  };
  const { harness, services } = createHarness(async (args) => {
    if (args.mode === 'plan') return JSON.stringify({ toolCalls: [{ name: 'observe_current_frame', arguments: {} }], confidence: 0.4 });
    assert.equal(args.visualObservation?.mainColors[0], 'black');
    return JSON.stringify({ message: '我用复核后的视觉结果继续。' });
  }, {
    config: {
      visualCacheTtlMs: 1,
      quickVisionModel: 'quick-test',
      deepVisionModel: 'deep-test',
      deepVisionReview: true,
    },
  });
  services.vision.analyze = async (_image, _focus, options = {}) => {
    calls.push(options.model ?? 'default');
    if (options.model === 'quick-test') {
      return { ...observation, visibleItems: [], uncertainties: ['看不清'] };
    }
    return deepObservation;
  };

  const result = await harness.runTurn(
    input({
      message: '仔细看我这样可以吗？',
      permissions: { allowVisualAnalysis: true },
      attachments: [
        {
          id: 'photo_deep_opt_in',
          kind: 'user_photo',
          mimeType: 'image/jpeg',
          localPath: path.resolve('./examples/mock_user_photo.jpg'),
          makeCurrent: true,
        },
      ],
    }),
  );

  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, ['quick-test', 'deep-test']);
});

test('closet recommendation only displays real candidate item ids', async () => {
  let candidateIds: string[] = [];
  const { harness } = createHarness(async (args) => {
    if (args.mode === 'plan') {
      return JSON.stringify({
        confidence: 0.45,
        toolCalls: [{ name: 'recommend_from_closet', arguments: { query: '通勤 轻松', limit: 12 } }],
      });
    }
    assert.ok((args.closetLooks?.length ?? 0) > 0);
    candidateIds = args.closetItems.map((item) => item.id);
    return JSON.stringify({
      message: '我从你的衣柜里选了一套更利落的搭配。',
      selectedItemIds: candidateIds.slice(0, 3),
      artifactTitle: '真实衣柜推荐',
      outfitName: '轻松通勤',
    });
  });

  const result = await harness.runTurn(input({ message: '用我的衣柜搭一套通勤的' }));
  assert.equal(result.status, 'completed');
  const grid = result.artifacts.find((artifact) => artifact.type === 'item_grid');
  assert.ok(grid && grid.type === 'item_grid');
  assert.ok(grid.items.length > 0);
	  assert.ok(result.decisionSummary);
	  assert.ok(result.decisionSummary.checked.some((item) => item.startsWith('真实衣柜')));
	  assert.ok(result.decisionSummary.constraintsApplied.some((item) => item.includes('通用低风险')));
	  assert.ok(result.decisionSummary.keyTradeoffs.some((item) => item.includes('真实衣柜')));
  assert.deepEqual(
    grid.items.map((item) => item.id),
    candidateIds.slice(0, grid.items.length),
  );
});

test('invalid closet item ids are filtered from cards and evidence refs', async () => {
  let validId = '';
  const { harness } = createHarness(async (args) => {
    if (args.mode === 'plan') {
      return JSON.stringify({
        confidence: 0.45,
        toolCalls: [{ name: 'recommend_from_closet', arguments: { query: '通勤 轻松', limit: 12 } }],
      });
    }
    validId = args.closetItems[0]?.id ?? '';
    assert.ok(validId);
    return JSON.stringify({
      message: '我从你的衣柜里选这件，再补一件不存在的黑色夹克。',
      selectedItemIds: [validId, 'closet_fake_black_jacket'],
      artifactTitle: '真实衣柜推荐',
    });
  });

  const result = await harness.runTurn(input({ message: '用我的衣柜搭一套通勤的' }));
  assert.equal(result.status, 'completed');
  const grid = result.artifacts.find((artifact) => artifact.type === 'item_grid');
  assert.ok(grid && grid.type === 'item_grid');
  assert.deepEqual(grid.items.map((item) => item.id), [validId]);
  assert.deepEqual(result.grounding?.closetItemIds, [validId]);
  assert.match(result.text, /真实衣柜里确认存在/);
  assert.equal(result.text.includes('黑色夹克'), false);
});

test('partial closet recommendation keeps real cards and saves suggested complements', async () => {
  let selectedIds: string[] = [];
  const { harness, stateStore } = createHarness(async (args) => {
    if (args.mode === 'plan') {
      return JSON.stringify({
        confidence: 0.45,
        toolCalls: [{ name: 'recommend_from_closet', arguments: { query: '聚餐 轻松', limit: 12 } }],
      });
    }
    const top = args.closetItems.find((item) => item.category === 'top');
    const bottom = args.closetItems.find((item) => item.category === 'bottom');
    assert.ok(top);
    assert.ok(bottom);
    selectedIds = [top.id, bottom.id];
    return JSON.stringify({
      message: `衣柜里可以用 ${top.name} 和 ${bottom.name}，但缺一双更合适的鞋。`,
      selectedItemIds: selectedIds,
      suggestedOutfit: {
        id: 'hybrid_dinner',
        name: '衣柜加一件补足',
        items: [
          { category: 'shoes', name: '尖头低跟鞋', color: '黑色', source: 'suggested' },
        ],
      },
      artifactTitle: '今晚可用的衣柜单品',
    });
  });

  const result = await harness.runTurn(input({ message: '用我的衣柜搭一套今晚聚餐的' }));
  assert.equal(result.status, 'completed');
  const grid = result.artifacts.find((artifact) => artifact.type === 'item_grid');
  assert.ok(grid && grid.type === 'item_grid');
  assert.equal(grid.title, '衣柜里可用的真实单品');
  assert.deepEqual(
    grid.items.map((item) => item.id),
    selectedIds,
  );
  assert.match(result.text, /不会把不存在的衣柜单品/);
  const activeOutfit = stateStore.get('harness-test').activeOutfit;
  assert.ok(activeOutfit);
  assert.equal(activeOutfit.items.filter((item) => item.source === 'closet').length, 2);
  assert.ok(activeOutfit.items.some((item) => item.source === 'suggested_complement' && item.category === 'shoes'));
});

test('free suggestion saves outfit without closet cards', async () => {
  const { harness } = createHarness(async () =>
    JSON.stringify({
      answerDraft: '柜子外我会给你一套亚麻衬衫配高腰阔腿裤。',
      confidence: 0.9,
      saveOutfit: {
        id: 'linen_free',
        name: '亚麻松弛感',
        items: [
          { category: 'top', name: '亚麻衬衫', color: '米色', source: 'suggested' },
          { category: 'bottom', name: '高腰阔腿裤', color: '白色', source: 'suggested' },
          { category: 'shoes', name: '皮凉鞋', color: '棕色', source: 'suggested' },
        ],
      },
    }),
  );

  const result = await harness.runTurn(input({ message: '不用衣柜，自由想一套' }));
  assert.equal(result.status, 'completed');
  assert.equal(result.artifacts.some((artifact) => artifact.type === 'item_grid'), false);
  assert.equal(result.state.activeOutfitId, 'linen_free');
});

test('visual request never shows a fake generated image when image service is unavailable', async () => {
  const activeOutfit: OutfitCandidate = {
    id: 'active',
    name: '当前方案',
    items: [
      { category: 'top', name: '白衬衫', color: '白色', source: 'suggested' },
      { category: 'bottom', name: '牛仔裤', color: '蓝色', source: 'suggested' },
      { category: 'shoes', name: '乐福鞋', color: '黑色', source: 'suggested' },
    ],
  };
  const { harness, stateStore } = createHarness(async () =>
    JSON.stringify({
      answerDraft: '我来准备这套的视觉参考。',
      confidence: 0.9,
      toolCalls: [
        { name: 'generate_outfit_visual', arguments: { type: 'outfit_visual', mode: 'flatlay', aspectRatio: '4:5' } },
      ],
    }),
  );
  stateStore.get('harness-test').activeOutfit = activeOutfit;

  const result = await harness.runTurn(input({ message: '想看看这套' }));
  assert.equal(result.status, 'completed');
  const notice = result.artifacts.find((artifact) => artifact.type === 'notice');
  assert.ok(notice && notice.type === 'notice');
  assert.equal(result.artifacts.some((artifact) => artifact.type === 'image'), false);
});

test('tool errors keep product-facing activity copy', async () => {
  const { harness, services } = createHarness(async (args) => {
    if (args.mode === 'plan') return JSON.stringify({ toolCalls: [{ name: 'observe_current_frame', arguments: {} }], confidence: 0.4 });
    return JSON.stringify({ message: '当前画面没看清，我先按你的文字继续。' });
  });
  services.vision.analyze = async () => {
    throw new Error('fetch failed');
  };

  const result = await harness.runTurn(
    input({
      message: '我这样可以吗？',
      permissions: { allowVisualAnalysis: true },
      attachments: [
        {
          id: 'photo_2',
          kind: 'user_photo',
          mimeType: 'image/jpeg',
          localPath: path.resolve('./examples/mock_user_photo.jpg'),
          makeCurrent: true,
        },
      ],
    }),
  );
  const renderedActivity = JSON.stringify(result.activity);
  assert.equal(renderedActivity.includes('fetch failed'), false);
  assert.ok(result.activity.some((item) => item.label === '当前画面暂时没看清'));
});

test('style tone override does not become presentation preference', async () => {
  const { harness } = createHarness(async () =>
    JSON.stringify({
      answerDraft: '好，我会把衣柜建议调得更利落。',
      confidence: 0.92,
      toolCalls: [],
    }),
  );

  const result = await harness.runTurn(input({
    message: '风格调利落一点',
    stylingProfileOverride: {
      styleTone: 'crisp',
      scope: 'session',
    },
  }));

	  assert.equal(result.status, 'completed');
	  assert.equal(result.state.stylingProfile?.presentationPreference, 'unknown');
	  assert.equal(result.state.stylingProfile?.recommendationScope, 'neutral_core');
	  assert.equal(result.state.stylingProfile?.styleTone, 'crisp');
});

test('turn styling override does not leak into the next recommendation', async () => {
  const { harness } = createHarness(async () =>
    JSON.stringify({
      answerDraft: '这轮我按偏女装处理。',
      confidence: 0.92,
      toolCalls: [],
    }),
  );

  const first = await harness.runTurn(input({
    message: '这套想偏女装一点',
    stylingProfileOverride: {
      presentationPreference: 'feminine',
      presentationOpenness: 'open',
      scope: 'turn',
    },
  }));
	  const second = await harness.runTurn(input({ message: '下一套继续' }));

	  assert.equal(first.status, 'completed');
	  assert.equal(first.state.stylingProfile?.presentationPreference, 'unknown');
	  assert.equal(second.status, 'completed');
	  assert.equal(second.state.stylingProfile?.presentationPreference, 'unknown');
});

test('profile-bound closet candidate cannot be reused for image generation after profile changes', async () => {
  let call = 0;
  const { harness } = createHarness(async (args) => {
    call += 1;
    if (call === 1) {
      return JSON.stringify({
        confidence: 0.9,
        toolCalls: [{ name: 'recommend_from_closet', arguments: { query: '聚餐', limit: 12 } }],
      });
    }
    if (call === 2) {
      const selected = args.closetItems.slice(0, 3).map((item) => item.id);
      return JSON.stringify({
        message: '这几件从剪裁和风格上更适配，实际尺寸仍需试穿确认。',
        selectedItemIds: selected,
        grounding: {
          closetItemIds: selected,
        },
      });
    }
    if (call === 3) {
      return JSON.stringify({
        confidence: 0.9,
        toolCalls: [{ name: 'generate_outfit_visual', arguments: { type: 'outfit_visual' } }],
      });
    }
    return JSON.stringify({
      message: '我准备生成图。',
      visualRequest: { type: 'outfit_visual' },
    });
  });

  const first = await harness.runTurn(input({ message: '用我的衣柜搭一套聚餐' }));
  assert.equal(first.status, 'completed');
  assert.ok(first.state.activeOutfitId);
  assert.ok(first.grounding?.stylingProfileSnapshotId);

  const second = await harness.runTurn(input({
    message: '想看看这套',
    stylingProfileOverride: {
      presentationPreference: 'feminine',
      presentationOpenness: 'open',
      scope: 'session',
    },
  }));

  assert.equal(second.status, 'completed');
  const notice = second.artifacts.find((artifact) => artifact.type === 'notice');
  assert.ok(notice && notice.type === 'notice');
  assert.match(notice.text, /切换了穿衣方向|重新校验/);
});

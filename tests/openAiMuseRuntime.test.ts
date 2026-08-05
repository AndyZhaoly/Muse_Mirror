import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadConfig, resolveOpenAIReasoningEffort } from '../src/config.js';
import { createServiceContainer } from '../src/runtime/serviceContainer.js';
import { InMemorySessionStateStore } from '../src/runtime/stateStore.js';
import { buildOpenAITools, OpenAIMuseRuntime } from '../src/server/openAiMuseRuntime.js';
import type { ClosetRecommendationResult, FashionTurnInput, OutfitCandidate, OutfitSnapshot, StoredImage, StylingProfile } from '../src/types.js';

function openAIConfig() {
  return {
    ...loadConfig(),
    runtimeProvider: 'muse' as const,
    agentProvider: 'openai' as const,
    agentModel: 'gpt-5.4',
    openaiAgentModel: 'gpt-5.4',
    openaiVisionModel: 'gpt-5.4-mini',
    openaiImageToolHostModel: 'gpt-5.4-mini',
    openaiImageModel: 'gpt-image-2',
    openaiReasoningEffort: 'low' as const,
    imageProvider: 'mock' as const,
    visionProvider: 'mock' as const,
    mockTools: true,
  };
}

function openAIImageConfig() {
  return {
    ...openAIConfig(),
    imageProvider: 'openai' as const,
    closetDataPath: path.resolve('./data/mock-closet.json'),
    closetPresentationMetadataPath: path.resolve('./data/mock-presentation-metadata.json'),
  };
}

function input(overrides: Partial<FashionTurnInput> = {}): FashionTurnInput {
  return {
    sessionId: 'openai-runtime-test',
    userId: 'user',
    message: '你好',
    locale: 'zh-CN',
    permissions: {
      allowVisualAnalysis: false,
      allowAiImageGeneration: false,
      allowPhotoUseForTryOn: false,
      allowPersistentMemory: false,
    },
    ...overrides,
  };
}

function functionCall(callId: string, name: string, args: unknown) {
  return {
    type: 'function_call',
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  };
}

function finalMessage(text: string) {
  return {
    type: 'message',
    phase: 'final_answer',
    content: [
      {
        type: 'output_text',
        text,
      },
    ],
  };
}

const testProfile: StylingProfile = {
  presentationPreference: 'unrestricted',
  presentationOpenness: 'unrestricted',
  fitPreference: 'regular',
  source: 'explicit_user',
};

function seedClosetCommittedOutfit(
  runtime: OpenAIMuseRuntime,
  sessionId = 'openai-runtime-test',
): { recommendation: ClosetRecommendationResult; candidateId: string; photo: StoredImage } {
  const state = runtime.stateStore.get(sessionId);
  state.stylingProfile = testProfile;
  const recommendation = runtime.services.closet.recommend({
    query: '朋友聚餐',
    profile: testProfile,
    limit: 4,
  }).result;
  const candidate = recommendation.candidates[0];
  assert.ok(candidate);
  const items = runtime.services.closet.getByIds(candidate.itemIds);
  const outfit: OutfitCandidate = {
    id: 'test_committed_outfit',
    name: candidate.title,
    items: items.map((item) => ({
      category: item.category,
      name: item.name,
      color: item.color,
      fit: item.fit,
      source: 'closet',
      itemId: item.id,
    })),
    provenance: candidate.provenance,
  };
  const photo: StoredImage = {
    id: 'photo_current',
    ownerUserId: 'user',
    sessionId,
    kind: 'user_photo',
    mimeType: 'image/jpeg',
    localPath: path.resolve('./data/mock-items/white-tee.svg'),
    createdAt: new Date().toISOString(),
    aiGenerated: false,
  };
  state.images[photo.id] = photo;
  state.currentUserImageId = photo.id;
  state.visualCache = {
    imageId: photo.id,
    source: 'quick',
    cachedAt: new Date().toISOString(),
    observation: {
      visibleItems: [{ category: 'top', description: '上半身', color: 'black', fit: 'regular' }],
      mainColors: ['black'],
      silhouette: 'upper body visible',
      proportionNotes: [],
      formality: 'casual',
      strengths: [],
      issues: [],
      uncertainties: [],
    },
  };
  state.perception = {
    cameraActive: true,
    status: 'observed',
    visibleRegion: 'upper_body',
    summary: '上半身可见',
  };
  state.activeOutfit = outfit;
  state.committedOutfit = {
    type: 'closet_candidate',
    id: 'committed_test',
    recommendationId: recommendation.recommendationId,
    candidateId: candidate.id,
    outfit,
    itemIds: items.map((item) => item.id),
    closetVersion: recommendation.closetVersion,
    profileSnapshotId: recommendation.profileSnapshotId,
    policyVersion: recommendation.policyVersion,
    createdAt: new Date().toISOString(),
  };
  state.activeClosetRecommendation = recommendation;
  return { recommendation, candidateId: candidate.id, photo };
}

function outputForCall(request: any, callId: string): any {
  const item = request.input.find(
    (candidate: any) => candidate?.type === 'function_call_output' && candidate.call_id === callId,
  );
  assert.ok(item, `missing function_call_output for ${callId}`);
  const parsed = JSON.parse(item.output);
  assert.equal(parsed.ok, true);
  return parsed.data;
}

function recommendationFunctionCall(callId = 'call_notice_recommend') {
  return functionCall(callId, 'recommend_from_closet', {
    query: '朋友聚餐',
    categories: null,
    colors: null,
    formality: null,
    limit: 12,
    mustUseItemIds: null,
    keepItemIds: null,
    recommendationScope: null,
    expressionIntensity: null,
    styleTone: null,
    preferenceMemoryScope: null,
    profileScope: null,
  });
}

function forceNoticeRecommendation(
  runtime: OpenAIMuseRuntime,
  options: { complete: boolean; fitStatus: 'unknown' | 'likely' },
): void {
  const closet = runtime.services.closet;
  const originalRecommend = closet.recommend.bind(closet);
  closet.recommend = (recommendInput) => {
    const base = originalRecommend(recommendInput);
    const allItems = closet.search({ query: '', limit: 50 });
    const requiredCategories = options.complete
      ? ['top', 'bottom', 'shoes']
      : ['top', 'bottom'];
    const items = requiredCategories.map((category) => {
      const item = allItems.find((candidate) => candidate.category === category);
      assert.ok(item, `missing ${category} fixture`);
      return item;
    });
    const originalCandidate = base.result.candidates[0];
    assert.ok(originalCandidate);
    const candidateId = `candidate_notice_${options.complete ? 'complete' : 'partial'}_${options.fitStatus}`;
    const candidate = {
      ...originalCandidate,
      id: candidateId,
      title: '测试搭配候选',
      itemIds: items.map((item) => item.id),
      categories: items.map((item) => item.category),
      completeness: options.complete ? 'complete' as const : 'partial' as const,
      fitStatus: options.fitStatus,
      provenance: {
        ...originalCandidate.provenance,
        candidateId,
      },
    };
    const missingCategories = options.complete ? [] : ['shoes'];
    const result: ClosetRecommendationResult = {
      ...base.result,
      status: options.complete ? 'success' : 'insufficient_complete_look',
      candidates: [candidate],
      coverage: {
        ...base.result.coverage,
        missingCategories,
      },
      suggestedComplements: options.complete
        ? []
        : [{
            category: 'shoes',
            name: '鞋子',
            reason: '补足完整搭配',
            source: 'suggested_complement',
          }],
    };
    return {
      result,
      items,
      looks: [{
        id: candidate.id,
        title: candidate.title,
        itemIds: candidate.itemIds,
        categories: candidate.categories,
        completeness: candidate.completeness,
        score: candidate.score,
      }],
    };
  };
}

async function runVoiceNoticeTurn(options: {
  complete: boolean;
  fitStatus: 'unknown' | 'likely';
  modelText?: string;
}) {
  const config = openAIConfig();
  const requests: any[] = [];
  let authoritativeResultText = '';
  const runtime = new OpenAIMuseRuntime({
    config,
    services: createServiceContainer(config),
    stateStore: new InMemorySessionStateStore(),
    responseCreate: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          id: 'resp_notice_recommend',
          status: 'completed',
          output_text: '',
          output: [recommendationFunctionCall()],
        };
      }
      if (requests.length === 2) {
        outputForCall(request, 'call_notice_recommend');
        const text = options.modelText ?? '这套适合约会。白色运动鞋会更轻松。';
        return {
          id: 'resp_notice_final',
          status: 'completed',
          output_text: text,
          output: [finalMessage(text)],
        };
      }
      assert.ok(request.input.some(
        (item: any) => item?.role === 'assistant' && item.content === authoritativeResultText,
      ));
      return {
        id: 'resp_notice_followup',
        status: 'completed',
        output_text: '好的。',
        output: [finalMessage('好的。')],
      };
    },
  });
  forceNoticeRecommendation(runtime, options);
  const result = await runtime.runTurn(input({
    message: '从衣柜给我搭一套',
    inputSource: 'voice',
  }));
  if (result.status !== 'completed') assert.fail('expected completed voice result');
  authoritativeResultText = result.text;
  return { runtime, result, requests };
}

test('OpenAI Muse direct greeting is one Responses call with store false and encrypted reasoning include', async () => {
  const config = openAIConfig();
  const requests: any[] = [];
  const runtime = new OpenAIMuseRuntime({
    config,
    services: createServiceContainer(config),
    stateStore: new InMemorySessionStateStore(),
    responseCreate: async (request) => {
      requests.push(request);
      return {
        id: 'resp_direct',
        status: 'completed',
        output_text: '在，我是 Muse Mirror。',
        output: [finalMessage('在，我是 Muse Mirror。')],
      };
    },
  });

  const result = await runtime.runTurn(input({ message: '你好' }));

  if (result.status !== 'completed') assert.fail('expected completed result');
  assert.equal(result.text, '在，我是 Muse Mirror。');
  assert.deepEqual(result.activity, []);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].stream, true);
  assert.equal(requests[0].store, false);
  assert.deepEqual(requests[0].include, ['reasoning.encrypted_content']);
  assert.equal(requests[0].reasoning.effort, 'low');
  assert.doesNotMatch(requests[0].instructions, /Voice Response Contract/);
  assert.equal(result.spokenText, undefined);
  assert.equal(result.telemetry?.interactionMode, 'text');
});

test('voice mode adds its response contract, returns grounded spokenText, and keeps full text in history', async () => {
  const config = openAIConfig();
  const requests: any[] = [];
  const authoritative = '## 建议\n- 不建议换厚外套，因为室内会太热。\n- 保留这件衬衫，换白鞋就够了。\n- 屏幕上还有完整说明：https://example.com/look';
  const runtime = new OpenAIMuseRuntime({
    config,
    services: createServiceContainer(config),
    stateStore: new InMemorySessionStateStore(),
    responseCreate: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          id: 'resp_voice',
          status: 'completed',
          output_text: authoritative,
          output: [finalMessage(authoritative)],
          usage: {
            input_tokens: 120,
            output_tokens: 32,
            input_tokens_details: { cached_tokens: 40 },
          },
        };
      }
      assert.ok(request.input.some(
        (item: any) => item?.role === 'assistant' && item.content === authoritative,
      ));
      return {
        id: 'resp_text_followup',
        status: 'completed',
        output_text: '这是文字模式的完整后续回答。',
        output: [finalMessage('这是文字模式的完整后续回答。')],
      };
    },
  });

  const voiceResult = await runtime.runTurn(input({
    message: '黑裤子可以吗？',
    inputSource: 'voice',
    traceId: 'voice_trace_123',
  }));
  if (voiceResult.status !== 'completed') assert.fail('expected completed voice result');
  assert.equal(voiceResult.text, authoritative);
  assert.ok(voiceResult.spokenText);
  assert.notEqual(voiceResult.spokenText, authoritative);
  assert.doesNotMatch(voiceResult.spokenText, /[#*]|https?:\/\//);
  assert.ok(Array.from(voiceResult.spokenText).length <= 80);
  assert.match(requests[0].instructions, /Voice Response Contract/);
  assert.match(requests[0].instructions, /不确定性、安全信息和重要限制/);
  assert.equal(requests[0].reasoning.effort, 'low');
  assert.equal(voiceResult.telemetry?.traceId, 'voice_trace_123');
  assert.equal(voiceResult.telemetry?.interactionMode, 'voice');
  assert.equal(voiceResult.telemetry?.inputTokens, 120);
  assert.equal(voiceResult.telemetry?.outputTokens, 32);
  assert.equal(voiceResult.telemetry?.cachedInputTokens, 40);
  assert.equal(voiceResult.telemetry?.textChars, Array.from(authoritative).length);
  assert.equal(voiceResult.telemetry?.spokenChars, Array.from(voiceResult.spokenText).length);

  const textResult = await runtime.runTurn(input({ message: '详细说说', inputSource: 'text' }));
  if (textResult.status !== 'completed') assert.fail('expected completed text result');
  assert.equal(textResult.spokenText, undefined);
  assert.doesNotMatch(requests[1].instructions, /Voice Response Contract/);
});

test('voice turn preserves fit uncertainty in spokenText and authoritative history', async () => {
  const { runtime, result } = await runVoiceNoticeTurn({
    complete: true,
    fitStatus: 'unknown',
  });

  assert.match(result.text, /实际肩线、腰围和裤长仍建议试穿确认/);
  assert.match(result.spokenText ?? '', /试穿确认/);
  assert.doesNotMatch(result.spokenText ?? '', /从剪裁和风格上看这几件更适配/);
  assert.ok(Array.from(result.spokenText ?? '').length <= 80);

  const followup = await runtime.runTurn(input({ message: '继续', inputSource: 'text' }));
  assert.equal(followup.status, 'completed');
});

test('voice turn preserves an incomplete closet gap without inventing closet items', async () => {
  const { result } = await runVoiceNoticeTurn({
    complete: false,
    fitStatus: 'likely',
  });

  assert.match(result.text, /不够组成完整一套/);
  assert.match(result.text, /主要缺\s*鞋子/);
  assert.match(result.text, /柜外补充会单独标记/);
  assert.match(result.spokenText ?? '', /衣柜现有单品还不够组成完整一套/);
  assert.match(result.spokenText ?? '', /缺鞋子/);
  assert.doesNotMatch(result.spokenText ?? '', /柜外补充会单独标记，不会冒充你的衣柜/);
});

test('voice turn keeps fit and closet notices together without reading the long disclaimer', async () => {
  const { result } = await runVoiceNoticeTurn({
    complete: false,
    fitStatus: 'unknown',
  });

  assert.match(result.spokenText ?? '', /试穿确认/);
  assert.match(result.spokenText ?? '', /缺鞋子/);
  assert.ok(Array.from(result.spokenText ?? '').length <= 80);
  assert.doesNotMatch(result.spokenText ?? '', /柜外补充会单独标记，不会冒充你的衣柜/);
  assert.doesNotMatch(result.spokenText ?? '', /第一|第二/);
});

test('reasoning effort uses voice override only when the configured model supports it', async () => {
  assert.equal(resolveOpenAIReasoningEffort('gpt-5', 'minimal', 'low'), 'minimal');
  assert.equal(resolveOpenAIReasoningEffort('gpt-5.4', 'minimal', 'low'), 'low');
  assert.equal(resolveOpenAIReasoningEffort('gpt-5.4', 'minimal', 'minimal'), 'low');
  assert.equal(resolveOpenAIReasoningEffort('gpt-5.4', 'medium', 'low'), 'medium');

  const config = {
    ...openAIConfig(),
    openaiAgentModel: 'gpt-5',
    openaiVoiceReasoningEffort: 'minimal' as const,
  };
  const requests: any[] = [];
  const runtime = new OpenAIMuseRuntime({
    config,
    services: createServiceContainer(config),
    stateStore: new InMemorySessionStateStore(),
    responseCreate: async (request) => {
      requests.push(request);
      return {
        id: `resp_${requests.length}`,
        status: 'completed',
        output_text: '好的。',
        output: [finalMessage('好的。')],
      };
    },
  });

  await runtime.runTurn(input({ message: '你好', inputSource: 'voice' }));
  await runtime.runTurn(input({ message: '你好', inputSource: 'text' }));
  assert.equal(requests[0].reasoning.effort, 'minimal');
  assert.equal(requests[1].reasoning.effort, 'low');
});

test('latency trace logs contain metrics but never user text or provider secrets', async () => {
  const config = { ...openAIConfig(), trace: true };
  const logs: string[] = [];
  const originalInfo = console.info;
  console.info = (...values: unknown[]) => { logs.push(values.map(String).join(' ')); };
  try {
    const runtime = new OpenAIMuseRuntime({
      config,
      services: createServiceContainer(config),
      stateStore: new InMemorySessionStateStore(),
      responseCreate: async () => ({
        id: 'resp_private',
        status: 'completed',
        output_text: '收到。',
        output: [finalMessage('收到。')],
      }),
    });
    await runtime.runTurn(input({
      message: '这是不能进入日志的私人原文 sk-secret-value',
      inputSource: 'voice',
      traceId: 'safe_trace',
    }));
  } finally {
    console.info = originalInfo;
  }
  assert.ok(logs.some((line) => line.includes('[MuseLatency]')));
  const serialized = logs.join('\n');
  assert.doesNotMatch(serialized, /不能进入日志的私人原文|sk-secret-value|收到。/);
});

test('OpenAI Muse replays full response output before function call outputs and commits closet candidate', async () => {
  const config = openAIConfig();
  const requests: any[] = [];
  const runtime = new OpenAIMuseRuntime({
    config,
    services: createServiceContainer(config),
    stateStore: new InMemorySessionStateStore(),
    responseCreate: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          id: 'resp_recommend',
          status: 'completed',
          output_text: '',
          output: [
            {
              type: 'reasoning',
              encrypted_content: 'encrypted_reasoning_blob',
            },
	            functionCall('call_recommend', 'recommend_from_closet', {
	              query: '聚餐',
	              categories: null,
	              colors: null,
	              formality: null,
	              limit: 12,
	              mustUseItemIds: null,
	              keepItemIds: null,
	              recommendationScope: null,
	              expressionIntensity: null,
	              styleTone: null,
	              preferenceMemoryScope: null,
	              profileScope: null,
	            }),
          ],
        };
      }
      if (requests.length === 2) {
        assert.ok(
          request.input.some((item: any) => item?.type === 'reasoning' && item.encrypted_content === 'encrypted_reasoning_blob'),
        );
        assert.ok(
          request.input.some((item: any) => item?.type === 'function_call' && item.call_id === 'call_recommend'),
        );
        const recommendation = outputForCall(request, 'call_recommend');
	        return {
	          id: 'resp_final',
	          status: 'completed',
	          output_text: '我会用这套真实衣柜候选，整体更利落，也会提醒你实际尺寸仍需试穿确认。',
	          output: [
	            finalMessage('我会用这套真实衣柜候选，整体更利落，也会提醒你实际尺寸仍需试穿确认。'),
	          ],
	        };
	      }
	      throw new Error('unexpected request');
    },
  });

	  const result = await runtime.runTurn(input({ message: '用我的衣柜搭一套今晚聚餐' }));

	  assert.equal(result.status, 'completed');
	  assert.equal(requests.length, 2);
  const grid = result.artifacts.find((artifact) => artifact.type === 'item_grid');
  assert.ok(grid && grid.type === 'item_grid');
  assert.ok(grid.items.length > 0);
	  assert.ok(result.grounding?.closetRecommendationIds?.length);
	  assert.ok(result.grounding?.selectedLookCandidateIds?.length);
	  assert.ok(result.activity.some((item) => item.type === 'tool.completed' && item.toolName === 'recommend_from_closet'));
	  assert.ok(result.activity.every((item) => item.toolName !== 'commit_outfit_selection'));
	  const activityCopy = result.activity.map((item) => `${item.label ?? ''} ${item.displayDetail ?? ''}`).join('\n');
	  assert.doesNotMatch(activityCopy, /正在理解|已决定|已整理/);
	});

test('OpenAI Muse internally commits the main closet candidate before final answer', async () => {
  const config = openAIConfig();
  const requests: any[] = [];
  const runtime = new OpenAIMuseRuntime({
    config,
    services: createServiceContainer(config),
    stateStore: new InMemorySessionStateStore(),
    responseCreate: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          id: 'resp_recommend',
          status: 'completed',
          output_text: '',
          output: [
	            functionCall('call_recommend', 'recommend_from_closet', {
	              query: '聚餐',
	              categories: null,
	              colors: null,
	              formality: null,
	              limit: 12,
	              mustUseItemIds: null,
	              keepItemIds: null,
	              recommendationScope: null,
	              expressionIntensity: null,
	              styleTone: null,
	              preferenceMemoryScope: null,
	              profileScope: null,
	            }),
          ],
        };
      }
      if (requests.length === 2) {
	        const recommendation = outputForCall(request, 'call_recommend');
	        assert.ok(recommendation.mainCandidate);
	        return {
	          id: 'resp_final',
	          status: 'completed',
	          output_text: '这套已绑定真实衣柜候选。',
	          output: [finalMessage('这套已绑定真实衣柜候选。')],
	        };
	      }
	      throw new Error('unexpected request');
    },
  });

	  const result = await runtime.runTurn(input({ message: '用我的衣柜搭一套今晚聚餐' }));

	  assert.equal(result.status, 'completed');
	  assert.equal(requests.length, 2);
	  assert.ok(result.artifacts.some((artifact) => artifact.type === 'item_grid'));
	  assert.ok(result.grounding?.selectedLookCandidateIds?.length);
	});

test('OpenAI tool schemas are strict and do not expose disabled product search', () => {
  const tools = buildOpenAITools(openAIConfig());
  assert.equal(tools.some((tool) => tool.name === 'search_products'), false);
  assert.equal(tools.some((tool) => tool.name === 'get_perception_status'), false);
  assert.equal(tools.some((tool) => tool.name === 'commit_outfit_selection'), false);
  for (const tool of tools) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.strict, true);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(
      [...Object.keys(tool.parameters.properties)].sort(),
      [...tool.parameters.required].sort(),
    );
  }
});

test('OpenAI visual tools expose only high-level orchestrator tools when image provider is enabled', () => {
  const tools = buildOpenAITools(openAIImageConfig());
  const names = new Set(tools.map((tool) => tool.name));
  assert.equal(names.has('commit_outfit'), true);
  assert.equal(names.has('create_style_visual'), true);
  assert.equal(names.has('update_style_visual'), true);
  assert.equal(names.has('edit_style_visual'), false);
  assert.equal(names.has('restore_visual_version'), false);
  assert.equal(names.has('generate_outfit_visual'), false);
  assert.equal(names.has('generate_try_on_preview'), false);
  assert.equal(names.has('edit_try_on_preview'), false);
  const createVisual = tools.find((tool) => tool.name === 'create_style_visual');
  assert.ok(createVisual);
  assert.equal(Boolean(createVisual.parameters.properties.visualType), false);
  assert.equal(Boolean(createVisual.parameters.properties.target), true);
  assert.equal(Boolean(createVisual.parameters.properties.itemRef), true);
  assert.ok(createVisual.parameters.properties.target.enum.includes('item_collection'));
  for (const tool of tools) {
    assert.equal(tool.strict, true);
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(
      [...Object.keys(tool.parameters.properties)].sort(),
      [...tool.parameters.required].sort(),
    );
  }
});

test('OpenAI Muse incomplete response without final text is not treated as success', async () => {
  const config = openAIConfig();
  const runtime = new OpenAIMuseRuntime({
    config,
    services: createServiceContainer(config),
    stateStore: new InMemorySessionStateStore(),
    responseCreate: async () => ({
      id: 'resp_incomplete',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_text: '',
      output: [],
    }),
  });

  await assert.rejects(
    () => runtime.runTurn(input({ message: '帮我搭一套' })),
    /没有成功返回|没有完整返回|暂时不可用/,
  );
});

test('partial visual evidence can answer visibility chat without being replaced as unseen', async () => {
  const config = openAIConfig();
  const requests: any[] = [];
  const runtime = new OpenAIMuseRuntime({
    config,
    services: createServiceContainer(config),
    stateStore: new InMemorySessionStateStore(),
    responseCreate: async (request) => {
      requests.push(request);
	      if (requests.length === 1) {
	        return {
	          id: 'resp_status',
	          status: 'completed',
	          output_text: '',
	          output: [functionCall('call_status', 'observe_current_frame', {})],
	        };
	      }
      return {
        id: 'resp_final_status',
        status: 'completed',
        output_text: '能看到你的一部分：上半身和浅蓝色短袖比较清楚，下装和鞋没进画面。',
        output: [finalMessage('能看到你的一部分：上半身和浅蓝色短袖比较清楚，下装和鞋没进画面。')],
      };
    },
	  });
	  const state = runtime.stateStore.get('openai-runtime-test');
	  const photo: StoredImage = {
	    id: 'frame_partial',
	    ownerUserId: 'user',
	    sessionId: 'openai-runtime-test',
	    kind: 'user_photo',
	    mimeType: 'image/jpeg',
	    localPath: path.resolve('./data/mock-items/white-tee.svg'),
	    createdAt: new Date().toISOString(),
	    aiGenerated: false,
	  };
	  state.images[photo.id] = photo;
	  state.currentUserImageId = photo.id;
	  state.visualCache = {
	    imageId: photo.id,
	    source: 'quick',
	    cachedAt: new Date().toISOString(),
	    observationId: 'obs_partial',
	    sourceFrameId: photo.id,
	    analyzedAt: Date.now(),
	    expiresAt: Date.now() + 10_000,
	    observation: {
	      visibleItems: [{ category: 'top', description: '浅蓝色短袖', color: 'light blue', fit: 'regular' }],
	      mainColors: ['light blue'],
	      silhouette: 'upper body visible',
	      proportionNotes: [],
	      formality: 'casual',
	      strengths: [],
	      issues: [],
	      uncertainties: ['下装和鞋不可见'],
	    },
	  };
	  state.perception = {
	    cameraActive: true,
	    latestFrameId: 'frame_partial',
    frameReceivedAt: Date.now(),
    sourceFrameId: 'frame_partial',
    analyzedAt: Date.now(),
    expiresAt: Date.now() + 10_000,
    status: 'frame_received',
    visibleRegion: 'upper_body',
    confidence: 0.45,
    summary: '看到浅蓝色短袖和上半身，但下装和鞋不可见',
  };

  const result = await runtime.runTurn(input({
    message: '看得到我吗',
    permissions: {
      allowVisualAnalysis: true,
      allowAiImageGeneration: false,
      allowPhotoUseForTryOn: false,
      allowPersistentMemory: false,
    },
  }));

	  assert.equal(result.status, 'completed');
	  assert.match(result.text, /能看到你的一部分/);
	  assert.doesNotMatch(result.text, /还没有拿到当前画面的视觉结果|还没有拿到清晰/);
	  assert.ok(result.activity.some((item) => item.type === 'tool.completed' && item.toolName === 'observe_current_frame'));
	  assert.ok(result.activity.every((item) => !item.label?.includes('Muse 看到了部分画面')));
	});

test('try-on request asks for photo approval before calling image generation', async () => {
  const config = openAIImageConfig();
  const services = createServiceContainer(config);
  let imageCalls = 0;
  services.visualGeneration = {
    generate: async () => {
      imageCalls += 1;
      return { bytes: Buffer.from('fake'), mimeType: 'image/png' };
    },
  };
  const runtime = new OpenAIMuseRuntime({
    config,
    services,
    stateStore: new InMemorySessionStateStore(),
    responseCreate: async () => ({
      id: 'resp_tryon',
      status: 'completed',
      output_text: '',
      output: [
        functionCall('call_tryon', 'generate_try_on_preview', {
          recommendationId: null,
          candidateId: null,
          aspectRatio: '4:5',
          extraInstruction: null,
          requestedScope: 'auto',
        }),
      ],
    }),
  });
  seedClosetCommittedOutfit(runtime);

  const result = await runtime.runTurn(input({
    message: '这套穿我身上看看',
    permissions: {
      allowVisualAnalysis: true,
      allowAiImageGeneration: true,
      allowPhotoUseForTryOn: false,
      allowPersistentMemory: false,
    },
  }));

  assert.equal(result.status, 'approval_required');
  assert.equal(imageCalls, 0);
  assert.equal(result.approvals[0]?.toolName, 'create_style_visual');
});

test('freeform outfit is committed as snapshot before try-on approval', async () => {
  const config = openAIImageConfig();
  const services = createServiceContainer(config);
  let imageCalls = 0;
  services.visualGeneration = {
    generate: async () => {
      imageCalls += 1;
      return { bytes: Buffer.from('fake'), mimeType: 'image/png' };
    },
  };
  let runtime: OpenAIMuseRuntime;
  runtime = new OpenAIMuseRuntime({
    config,
    services,
    stateStore: new InMemorySessionStateStore(),
    responseCreate: async (request) => {
      const commitOutput = request.input.find(
        (item: any) => item?.type === 'function_call_output' && item.call_id === 'call_commit_freeform',
      );
      if (!commitOutput) {
        return {
          id: 'resp_commit_freeform',
          status: 'completed',
          output_text: '',
          output: [
            functionCall('call_commit_freeform', 'commit_outfit', {
              source: 'freeform_concept',
              recommendationId: null,
              candidateId: null,
              outfitSnapshotId: null,
              title: '西湖边清爽方案',
              items: [
                { category: 'top', color: '白色', description: '白色基础 T 恤' },
                { category: 'bottom', color: '浅蓝', description: '浅蓝直筒牛仔裤' },
                { category: 'shoes', color: '灰白', description: '灰白运动鞋' },
              ],
            }),
          ],
        };
      }
      const snapshotId = JSON.parse(commitOutput.output).data.outfitSnapshotId;
      return {
        id: 'resp_create_tryon',
        status: 'completed',
        output_text: '',
        output: [
          functionCall('call_create_tryon', 'create_style_visual', {
            visualType: 'try_on',
            outfitRefType: 'snapshot',
            recommendationId: null,
            candidateId: null,
            outfitSnapshotId: snapshotId,
            aspectRatio: '4:5',
            mode: null,
            requestedScope: 'auto',
            faceMode: null,
            conceptTitle: null,
            conceptDescription: null,
            extraInstruction: null,
          }),
        ],
      };
    },
  });
  const state = runtime.stateStore.get('openai-runtime-test');
  const photo: StoredImage = {
    id: 'photo_current',
    ownerUserId: 'user',
    sessionId: 'openai-runtime-test',
    kind: 'user_photo',
    mimeType: 'image/jpeg',
    localPath: path.resolve('./data/mock-items/white-tee.svg'),
    createdAt: new Date().toISOString(),
    aiGenerated: false,
  };
  state.images[photo.id] = photo;
  state.currentUserImageId = photo.id;
  state.visualCache = {
    imageId: photo.id,
    source: 'quick',
    cachedAt: new Date().toISOString(),
    observation: {
      visibleItems: [{ category: 'top', description: '上半身', color: 'white', fit: 'regular' }],
      mainColors: ['white'],
      silhouette: 'upper body visible',
      proportionNotes: [],
      formality: 'casual',
      strengths: [],
      issues: [],
      uncertainties: [],
    },
  };
  state.perception = {
    cameraActive: true,
    status: 'observed',
    visibleRegion: 'upper_body',
    summary: '上半身可见',
  };

  const result = await runtime.runTurn(input({
    message: '可以给我上身图看看吗',
    permissions: {
      allowVisualAnalysis: true,
      allowAiImageGeneration: true,
      allowPhotoUseForTryOn: false,
      allowPersistentMemory: false,
    },
  }));

  assert.equal(result.status, 'approval_required');
  assert.equal(imageCalls, 0);
  assert.equal(Object.values(state.outfitSnapshots ?? {}).length, 1);
  const pending = Object.values(state.pendingVisualRequests ?? {})[0];
  assert.ok(pending);
  assert.equal(pending.status, 'awaiting_approval');
  assert.equal(state.outfitSnapshots?.[pending.outfitSnapshotId]?.type, 'freeform_concept');
});

test('update_style_visual updates pending snapshot without starting generation', async () => {
  const config = openAIImageConfig();
  const services = createServiceContainer(config);
  let imageCalls = 0;
  services.visualGeneration = {
    generate: async () => {
      imageCalls += 1;
      return { bytes: Buffer.from('fake'), mimeType: 'image/png' };
    },
  };
  const stateStore = new InMemorySessionStateStore();
  const runtime = new OpenAIMuseRuntime({
    config,
    services,
    stateStore,
    responseCreate: async (request): Promise<any> => {
      if (!request.input.some((item: any) => item?.type === 'function_call_output')) {
        const currentState = stateStore.get('openai-runtime-test');
        return {
          id: 'resp_update_pending',
          status: 'completed',
          output_text: '',
          output: [
            functionCall('call_update_visual', 'update_style_visual', {
              action: 'edit',
              requestId: currentState.activePendingVisualRequestId ?? null,
              versionRef: 'current',
              versionId: null,
              recommendationId: null,
              candidateId: null,
              aspectRatio: '4:5',
              requestedScope: 'auto',
              replaceCategory: 'top',
              newCategory: 'top',
              newColor: '浅蓝',
              title: null,
              changeRequest: '把上衣换成浅蓝上衣',
              extraInstruction: null,
            }),
          ],
        };
      }
      return {
        id: 'resp_final_update_pending',
        status: 'completed',
        output_text: '我把待生成方案里的上衣改成浅蓝了，还没有开始生成。',
        output: [finalMessage('我把待生成方案里的上衣改成浅蓝了，还没有开始生成。')],
      };
    },
  });
  const state = runtime.stateStore.get('openai-runtime-test');
  const snapshot: OutfitSnapshot = {
    type: 'freeform_concept' as const,
    snapshotId: 'snapshot_pending',
    label: 'ai_concept_not_in_closet' as const,
    title: '西湖边清爽方案',
    items: [
      { category: 'top', color: '白色', description: '白色基础 T 恤' },
      { category: 'bottom', color: '浅蓝', description: '浅蓝直筒牛仔裤' },
    ],
    outfit: {
      id: 'freeform_pending',
      name: '西湖边清爽方案',
      items: [
        { category: 'top', name: '白色基础 T 恤', color: '白色', source: 'suggested_complement' as const },
        { category: 'bottom', name: '浅蓝直筒牛仔裤', color: '浅蓝', source: 'suggested_complement' as const },
      ],
    },
    createdAt: new Date().toISOString(),
  };
  state.outfitSnapshots = { [snapshot.snapshotId]: snapshot };
  state.activeOutfitSnapshotId = snapshot.snapshotId;
  state.pendingVisualRequests = {
    visual_req_pending: {
      requestId: 'visual_req_pending',
      sessionId: 'openai-runtime-test',
      originTurnId: 'turn_previous',
      outfitSnapshotId: snapshot.snapshotId,
      visualType: 'try_on',
      status: 'awaiting_approval',
      expiresAt: new Date(Date.now() + 1000 * 60).toISOString(),
      idempotencyKey: 'idem_pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
  state.activePendingVisualRequestId = 'visual_req_pending';

  const result = await runtime.runTurn(input({
    message: '浅蓝上衣',
    permissions: {
      allowVisualAnalysis: true,
      allowAiImageGeneration: true,
      allowPhotoUseForTryOn: false,
      allowPersistentMemory: false,
    },
  }));

  assert.equal(result.status, 'completed');
  assert.equal(imageCalls, 0);
  const updatedRequest = state.pendingVisualRequests.visual_req_pending;
  assert.ok(updatedRequest);
  assert.equal(updatedRequest.status, 'ready');
  const updatedSnapshot = state.outfitSnapshots[updatedRequest.outfitSnapshotId];
  assert.equal(updatedSnapshot?.type, 'freeform_concept');
  assert.ok(updatedSnapshot?.type === 'freeform_concept');
  assert.equal(
    updatedSnapshot.type === 'freeform_concept'
      ? updatedSnapshot.items.find((item) => item.category === 'top')?.color
      : undefined,
    '浅蓝',
  );
  assert.equal(result.artifacts.some((artifact) => artifact.type === 'image'), false);
});

test('approved try-on resumes generation with user photo and closet reference images', async () => {
  const config = openAIImageConfig();
  const services = createServiceContainer(config);
  const imageCalls: Array<{
    prompt: string;
    sourceImages?: StoredImage[];
  }> = [];
  services.visualGeneration = {
    generate: async (request) => {
      imageCalls.push({ prompt: request.prompt, sourceImages: request.sourceImages });
      return { bytes: Buffer.from('fake'), mimeType: 'image/png' };
    },
  };
  const runtime = new OpenAIMuseRuntime({
    config,
    services,
    stateStore: new InMemorySessionStateStore(),
    responseCreate: async () => ({
      id: 'resp_tryon',
      status: 'completed',
      output_text: '',
      output: [
        functionCall('call_tryon', 'generate_try_on_preview', {
          recommendationId: null,
          candidateId: null,
          aspectRatio: '4:5',
          extraInstruction: null,
          requestedScope: 'auto',
        }),
      ],
    }),
  });
  const { photo } = seedClosetCommittedOutfit(runtime);
  const approval = await runtime.runTurn(input({
    message: '这套穿我身上看看',
    permissions: {
      allowVisualAnalysis: true,
      allowAiImageGeneration: true,
      allowPhotoUseForTryOn: false,
      allowPersistentMemory: false,
    },
  }));
  assert.equal(approval.status, 'approval_required');

  const state = runtime.stateStore.get('openai-runtime-test');
  const newerPhoto: StoredImage = {
    id: 'photo_newer_unapproved',
    ownerUserId: 'user',
    sessionId: 'openai-runtime-test',
    kind: 'user_photo',
    mimeType: 'image/jpeg',
    localPath: path.resolve('./data/mock-items/black-jeans.svg'),
    createdAt: new Date().toISOString(),
    aiGenerated: false,
  };
  state.images[newerPhoto.id] = newerPhoto;
  state.currentUserImageId = newerPhoto.id;

  const result = await runtime.resumeTurn({
    sessionId: 'openai-runtime-test',
    userId: 'user',
    serializedRunState: approval.serializedRunState,
    decisions: [{ index: 0, approved: true }],
    permissions: {
      allowVisualAnalysis: true,
      allowAiImageGeneration: true,
      allowPhotoUseForTryOn: true,
      allowPersistentMemory: false,
    },
  });

  assert.equal(result.status, 'completed');
  assert.ok(result.artifacts.some((artifact) => artifact.type === 'image' && artifact.source === 'ai_try_on'));
  const imageArtifact = result.artifacts.find((artifact) => artifact.type === 'image' && artifact.source === 'ai_try_on');
  assert.ok(imageArtifact && imageArtifact.type === 'image');
  assert.equal(imageArtifact.previewScope, 'upper_body_faithful');
  assert.match(imageArtifact.disclaimer, /上半身|下装和鞋未在本图中展示/);
  assert.equal(imageCalls.length, 1);
  assert.notEqual(imageCalls[0]?.sourceImages?.[0]?.id, newerPhoto.id);
  assert.equal(imageCalls[0]?.sourceImages?.[0]?.id, photo.id);
  assert.ok((imageCalls[0]?.sourceImages?.length ?? 0) > 1);
  assert.match(imageCalls[0]?.prompt ?? '', /canonical garment references|Reference garments provided/);
  assert.match(imageCalls[0]?.prompt ?? '', /faithful upper-body try-on/);
});

test('head-and-shoulders source creates neckline preview instead of blocking try-on', async () => {
  const config = openAIImageConfig();
  const services = createServiceContainer(config);
  const imageCalls: Array<{ prompt: string; aspectRatio?: string }> = [];
  services.visualGeneration = {
    generate: async (request) => {
      imageCalls.push({ prompt: request.prompt, aspectRatio: request.aspectRatio });
      return { bytes: Buffer.from('fake'), mimeType: 'image/png' };
    },
  };
  const runtime = new OpenAIMuseRuntime({
    config,
    services,
    stateStore: new InMemorySessionStateStore(),
    responseCreate: async (request) => {
      if (request.input.some((item: any) => item?.type === 'function_call_output')) {
        return {
          id: 'resp_neckline_final',
          status: 'completed',
          output_text: '领口预览已放到左侧。',
          output: [finalMessage('领口预览已放到左侧。')],
        };
      }
      return {
        id: 'resp_neckline',
        status: 'completed',
        output_text: '',
        output: [
          functionCall('call_neckline', 'create_style_visual', {
            visualType: 'try_on',
            outfitRefType: 'active',
            recommendationId: null,
            candidateId: null,
            outfitSnapshotId: null,
            aspectRatio: '4:5',
            mode: null,
            requestedScope: 'auto',
            faceMode: null,
            conceptTitle: null,
            conceptDescription: null,
            extraInstruction: null,
          }),
        ],
      };
    },
  });
  seedClosetCommittedOutfit(runtime);
  const state = runtime.stateStore.get('openai-runtime-test');
  assert.ok(state.visualCache);
  state.visualCache.observation.visibleItems = [];
  state.perception = {
    cameraActive: true,
    status: 'observed',
    summary: '只看到脸和肩膀',
  };

  const result = await runtime.runTurn(input({
    message: '看看领口效果',
    permissions: {
      allowVisualAnalysis: true,
      allowAiImageGeneration: true,
      allowPhotoUseForTryOn: true,
      allowPersistentMemory: false,
    },
  }));

  const imageArtifact = result.artifacts.find((artifact) => artifact.type === 'image' && artifact.source === 'ai_try_on');
  assert.ok(imageArtifact && imageArtifact.type === 'image');
  assert.equal(imageArtifact.previewScope, 'neckline_preview');
  assert.match(imageArtifact.disclaimer, /领口|肩部/);
  assert.equal(imageCalls.length, 1);
  assert.match(imageCalls[0]?.prompt ?? '', /neckline-and-shoulders preview/);
});

test('full-body synthetic try-on requires separate consent when source is only upper body', async () => {
  const config = openAIImageConfig();
  const services = createServiceContainer(config);
  const imageCalls: Array<{ prompt: string; aspectRatio?: string }> = [];
  services.visualGeneration = {
    generate: async (request) => {
      imageCalls.push({ prompt: request.prompt, aspectRatio: request.aspectRatio });
      return { bytes: Buffer.from('fake'), mimeType: 'image/png' };
    },
  };
  const runtime = new OpenAIMuseRuntime({
    config,
    services,
    stateStore: new InMemorySessionStateStore(),
    responseCreate: async () => ({
      id: 'resp_full_synthetic',
      status: 'completed',
      output_text: '',
      output: [
        functionCall('call_full_synthetic', 'create_style_visual', {
          visualType: 'try_on',
          outfitRefType: 'active',
          recommendationId: null,
          candidateId: null,
          outfitSnapshotId: null,
          aspectRatio: '9:16',
          mode: null,
          requestedScope: 'full_body',
          faceMode: null,
          conceptTitle: null,
          conceptDescription: null,
          extraInstruction: null,
        }),
      ],
    }),
  });
  seedClosetCommittedOutfit(runtime);

  const approval = await runtime.runTurn(input({
    message: '整套穿我身上看看',
    permissions: {
      allowVisualAnalysis: true,
      allowAiImageGeneration: true,
      allowPhotoUseForTryOn: true,
      allowPersistentMemory: false,
    },
  }));

  assert.equal(approval.status, 'approval_required');
  assert.match(approval.approvals[0]?.reason ?? '', /AI 全身概念预览|AI 推测/);
  assert.equal(imageCalls.length, 0);

  const result = await runtime.resumeTurn({
    sessionId: 'openai-runtime-test',
    userId: 'user',
    serializedRunState: approval.serializedRunState,
    decisions: [{ index: 0, approved: true, faceMode: 'include' }],
    permissions: {
      allowVisualAnalysis: true,
      allowAiImageGeneration: true,
      allowPhotoUseForTryOn: true,
      allowPersistentMemory: false,
    },
  });

  assert.equal(result.status, 'completed');
  const imageArtifact = result.artifacts.find((artifact) => artifact.type === 'image' && artifact.source === 'ai_try_on');
  assert.ok(imageArtifact && imageArtifact.type === 'image');
  assert.equal(imageArtifact.previewScope, 'full_body_synthetic');
  assert.match(imageArtifact.disclaimer, /AI 推测/);
  assert.equal(imageArtifact.tryOnMetadata?.syntheticRegions.includes('legs'), true);
  assert.equal(imageCalls.length, 1);
  assert.equal(imageCalls[0]?.aspectRatio, '9:16');
  assert.match(imageCalls[0]?.prompt ?? '', /AI full-body concept preview/);
});

test('create_style_visual surfaces real internal visual stages', async () => {
  const config = openAIImageConfig();
  const services = createServiceContainer(config);
  services.visualGeneration = {
    generate: async () => ({ bytes: Buffer.from('fake'), mimeType: 'image/png' }),
  };
  const runtime = new OpenAIMuseRuntime({
    config,
    services,
    stateStore: new InMemorySessionStateStore(),
    responseCreate: async (request) => {
      if (!request.input.some((item: any) => item?.type === 'function_call_output')) {
        return {
          id: 'resp_visual_stages',
          status: 'completed',
          output_text: '',
          output: [
            functionCall('call_visual_stages', 'create_style_visual', {
              visualType: 'try_on',
              outfitRefType: 'active',
              recommendationId: null,
              candidateId: null,
              outfitSnapshotId: null,
              aspectRatio: '4:5',
              mode: null,
              requestedScope: 'auto',
              faceMode: null,
              conceptTitle: null,
              conceptDescription: null,
              extraInstruction: null,
            }),
          ],
        };
      }
      return {
        id: 'resp_visual_stages_final',
        status: 'completed',
        output_text: '上身预览已放到左侧。',
        output: [finalMessage('上身预览已放到左侧。')],
      };
    },
  });
  seedClosetCommittedOutfit(runtime);

  const result = await runtime.runTurn(input({
    message: '这套穿我身上看看',
    permissions: {
      allowVisualAnalysis: true,
      allowAiImageGeneration: true,
      allowPhotoUseForTryOn: true,
      allowPersistentMemory: false,
    },
  }));

  assert.equal(result.status, 'completed');
  const labels = result.activity.map((item) => item.label).filter((label): label is string => Boolean(label));
  assert.ok(labels.includes('正在准备本人照片'));
  assert.ok(labels.includes('正在匹配所选衣服'));
  assert.ok(labels.some((label) => label.startsWith('正在生成')));
  assert.ok(labels.includes('正在检查生成结果'));
  assert.ok(labels.includes('上身预览生成完成'));
  const visualStages = result.activity.filter((item) => item.toolName === 'create_style_visual' && item.label);
  assert.equal(new Set(visualStages.map((item) => item.id)).size, visualStages.length);
});

test('create_style_visual emits partial progress without saving partial to final artifacts', async () => {
  const config = openAIImageConfig();
  const services = createServiceContainer(config);
  const partialArtifacts: StoredImage[] = [];
  services.visualGeneration = {
    generate: async (request) => {
      request.onPartial?.({
        imageId: 'partial_img',
        url: '/generated/partial.png',
        mimeType: 'image/png',
        partialIndex: 0,
      });
      partialArtifacts.push(...request.sourceImages);
      return { bytes: Buffer.from('final'), mimeType: 'image/png' };
    },
  };
  const streamedArtifacts: any[] = [];
  const runtime = new OpenAIMuseRuntime({
    config,
    services,
    stateStore: new InMemorySessionStateStore(),
    responseCreate: async (request) => {
      if (!request.input.some((item: any) => item?.type === 'function_call_output')) {
        return {
          id: 'resp_visual',
          status: 'completed',
          output_text: '',
          output: [
            functionCall('call_visual', 'create_style_visual', {
              visualType: 'outfit_visual',
              outfitRefType: 'active',
              recommendationId: null,
              candidateId: null,
              outfitSnapshotId: null,
              aspectRatio: '4:5',
              mode: 'flatlay',
              requestedScope: null,
              conceptTitle: null,
              conceptDescription: null,
              extraInstruction: null,
            }),
          ],
        };
      }
      return {
        id: 'resp_final_visual',
        status: 'completed',
        output_text: '视觉参考已放到左侧。',
        output: [finalMessage('视觉参考已放到左侧。')],
      };
    },
  });
  seedClosetCommittedOutfit(runtime);

  const result = await runtime.runTurn(input({
    message: '看看这套搭起来什么感觉',
    permissions: {
      allowVisualAnalysis: false,
      allowAiImageGeneration: true,
      allowPhotoUseForTryOn: false,
      allowPersistentMemory: false,
    },
    onArtifact: (artifact) => streamedArtifacts.push(artifact),
  }));

  const partial = streamedArtifacts.find((artifact) => artifact.type === 'image' && artifact.partial);
  assert.ok(partial);
  assert.equal(result.status, 'completed');
  assert.equal(result.artifacts.some((artifact) => artifact.type === 'image' && artifact.partial), false);
  const lookBoard = result.artifacts.find((artifact) => artifact.type === 'look_board');
  assert.ok(lookBoard && lookBoard.type === 'look_board');
  assert.ok(lookBoard.visualVersionId);
  assert.ok(lookBoard.hero.imageUrl);
  assert.ok(lookBoard.items.length >= 2);
  assert.equal(lookBoard.items.some((item) => item.source === 'concept' && item.badge !== 'AI 概念单品'), false);
  assert.ok(result.state.visualSession?.currentVersionId);
  assert.ok(partialArtifacts.length > 0);
});

test('target item visual creates a single concept item without entering Look Board', async () => {
  const config = openAIImageConfig();
  const services = createServiceContainer(config);
  const outputKinds: string[] = [];
  services.visualGeneration = {
    generate: async (request) => {
      outputKinds.push(request.outputKind);
      return { bytes: Buffer.from('fake'), mimeType: 'image/png' };
    },
  };
  const runtime = new OpenAIMuseRuntime({
    config,
    services,
    stateStore: new InMemorySessionStateStore(),
    responseCreate: async (request) => {
      if (!request.input.some((item: any) => item?.type === 'function_call_output')) {
        return {
          id: 'resp_item_visual',
          status: 'completed',
          output_text: '',
          output: [
            functionCall('call_item_visual', 'create_style_visual', {
              target: 'item',
              goal: '看白色运动鞋概念图',
              itemRef: {
                source: 'concept',
                closetItemId: null,
                productId: null,
                conceptSpec: {
                  category: 'shoes',
                  subCategory: 'low-top sneakers',
                  color: 'clean white',
                  description: '简洁日常低帮白色运动鞋，无明显 logo',
                  silhouette: 'streamlined low-top sneaker',
                  fit: null,
                  materialHint: 'matte leather and mesh',
                  requiredDetails: [],
                  forbiddenDetails: [],
                },
              },
              outfitRef: null,
              personSource: null,
              assetPreference: 'concept_only',
              composition: null,
              subject: null,
              framing: 'single_item',
              facePolicy: null,
              requestedScope: null,
              extraInstruction: null,
            }),
          ],
        };
      }
      return {
        id: 'resp_item_visual_final',
        status: 'completed',
        output_text: '白色运动鞋概念图已放到左侧。',
        output: [finalMessage('白色运动鞋概念图已放到左侧。')],
      };
    },
  });

  const result = await runtime.runTurn(input({
    message: '白色运动鞋概念图给我看看',
    permissions: {
      allowVisualAnalysis: false,
      allowAiImageGeneration: true,
      allowPhotoUseForTryOn: false,
      allowPersistentMemory: false,
    },
  }));

  assert.equal(result.status, 'completed');
  assert.deepEqual(outputKinds, ['ai_concept_item']);
  assert.equal(result.artifacts.some((artifact) => artifact.type === 'look_board'), false);
  assert.equal(result.artifacts.some((artifact) => artifact.type === 'image' && artifact.source === 'ai_outfit_visual'), false);
  const itemVisual = result.artifacts.find((artifact) => artifact.type === 'item_visual');
  assert.ok(itemVisual && itemVisual.type === 'item_visual');
  assert.equal(itemVisual.badge, 'AI 概念单品');
  assert.equal(itemVisual.source, 'concept');
  assert.equal(Boolean(itemVisual.disclaimer?.includes('价格')), true);
  assert.equal(result.activity.some((item) => /Look Board|全身主视觉|有效单品/.test(`${item.label ?? ''}${item.displayDetail ?? ''}`)), false);
});

test('get_item_images reports concept fallback without generating AI images', async () => {
  const config = openAIImageConfig();
  const services = createServiceContainer(config);
  let visualCalls = 0;
  services.visualGeneration = {
    generate: async () => {
      visualCalls += 1;
      return { bytes: Buffer.from('unexpected'), mimeType: 'image/png' };
    },
  };
  const runtime = new OpenAIMuseRuntime({
    config,
    services,
    stateStore: new InMemorySessionStateStore(),
    responseCreate: async (request) => {
      if (!request.input.some((item: any) => item?.type === 'function_call_output')) {
        return {
          id: 'resp_item_not_found',
          status: 'completed',
          output_text: '',
          output: [
            functionCall('call_item_images_missing', 'get_item_images', {
              itemIds: ['missing_white_sneaker'],
              requestedItem: {
                category: 'shoes',
                subCategory: 'low-top sneakers',
                color: 'white',
                description: '白色运动鞋',
                silhouette: null,
                fit: null,
                materialHint: null,
                requiredDetails: [],
                forbiddenDetails: [],
              },
            }),
          ],
        };
      }
      const missing = outputForCall(request, 'call_item_images_missing');
      assert.equal(missing.status, 'not_found');
      assert.equal(missing.conceptFallbackAvailable, true);
      return {
        id: 'resp_item_not_found_final',
        status: 'completed',
        output_text: '衣柜里没有真实白鞋图，但可以生成 AI 概念单品图。',
        output: [finalMessage('衣柜里没有真实白鞋图，但可以生成 AI 概念单品图。')],
      };
    },
  });

  const result = await runtime.runTurn(input({ message: '白鞋真实图有吗？' }));

  assert.equal(result.status, 'completed');
  assert.equal(visualCalls, 0);
});

test('target item_collection shows completed generated concept items without new image calls', async () => {
  const config = openAIImageConfig();
  const services = createServiceContainer(config);
  let visualCalls = 0;
  services.visualGeneration = {
    generate: async () => {
      visualCalls += 1;
      return { bytes: Buffer.from('unexpected'), mimeType: 'image/png' };
    },
  };
  const runtime = new OpenAIMuseRuntime({
    config,
    services,
    stateStore: new InMemorySessionStateStore(),
    responseCreate: async (request) => {
      if (!request.input.some((item: any) => item?.type === 'function_call_output')) {
        return {
          id: 'resp_item_collection',
          status: 'completed',
          output_text: '',
          output: [
            functionCall('call_item_collection', 'create_style_visual', {
              target: 'item_collection',
              goal: '展示所有已生成的 AI 概念单品图',
              itemRef: null,
              outfitRef: null,
              personSource: null,
              assetPreference: null,
              composition: null,
              subject: null,
              framing: null,
              facePolicy: null,
              requestedScope: null,
              extraInstruction: null,
            }),
          ],
        };
      }
      const output = outputForCall(request, 'call_item_collection');
      assert.equal(output.status, 'completed');
      assert.equal(output.count, 2);
      return {
        id: 'resp_item_collection_final',
        status: 'completed',
        output_text: '这些是目前生成过的概念单品图。',
        output: [finalMessage('这些是目前生成过的概念单品图。')],
      };
    },
  });
  const state = runtime.stateStore.get('openai-runtime-test');
  state.conceptItemAssets = {
    concept_asset_1: {
      conceptItemAssetId: 'concept_asset_1',
      specHash: 'hash_1',
      category: 'shoes',
      title: '白色运动鞋',
      description: 'clean white sneaker',
      color: '白色',
      promptVersion: 'test',
      model: 'mock',
      quality: 'low',
      status: 'completed',
      imageId: 'img_1',
      imageUrl: '/generated/white-sneaker.png',
      createdAt: '2026-06-26T00:00:00.000Z',
      updatedAt: '2026-06-26T00:00:00.000Z',
    } as any,
    concept_asset_2: {
      conceptItemAssetId: 'concept_asset_2',
      specHash: 'hash_2',
      category: 'outerwear',
      title: '浅蓝衬衫',
      description: 'light blue shirt',
      color: '浅蓝',
      promptVersion: 'test',
      model: 'mock',
      quality: 'low',
      status: 'completed',
      imageId: 'img_2',
      imageUrl: '/generated/blue-shirt.png',
      createdAt: '2026-06-26T00:01:00.000Z',
      updatedAt: '2026-06-26T00:01:00.000Z',
    } as any,
    concept_asset_failed: {
      conceptItemAssetId: 'concept_asset_failed',
      specHash: 'hash_failed',
      category: 'bag',
      title: '失败单品',
      description: 'failed',
      color: '黑色',
      promptVersion: 'test',
      model: 'mock',
      quality: 'low',
      status: 'failed',
      createdAt: '2026-06-26T00:02:00.000Z',
      updatedAt: '2026-06-26T00:02:00.000Z',
    } as any,
  };

  const result = await runtime.runTurn(input({ message: '把所有生成过的单品图给我看' }));

  assert.equal(result.status, 'completed');
  assert.equal(visualCalls, 0);
  const collection = result.artifacts.find((artifact) => artifact.type === 'item_collection');
  assert.ok(collection && collection.type === 'item_collection');
  assert.equal(collection.items.length, 2);
  const firstItem = collection.items.at(0);
  assert.ok(firstItem);
  assert.equal(firstItem.label, '浅蓝衬衫');
  assert.equal(collection.items.every((item) => item.badge === 'AI 概念单品'), true);
});

test('look board attempts all concept item assets including required shoes', async () => {
  const config = openAIImageConfig();
  const services = createServiceContainer(config);
  const outputKinds: string[] = [];
  services.visualGeneration = {
    generate: async (request) => {
      outputKinds.push(request.outputKind);
      return { bytes: Buffer.from('fake'), mimeType: 'image/png' };
    },
  };
  const runtime = new OpenAIMuseRuntime({
    config,
    services,
    stateStore: new InMemorySessionStateStore(),
    responseCreate: async (request) => {
      if (!request.input.some((item: any) => item?.type === 'function_call_output')) {
        return {
          id: 'resp_four_concepts',
          status: 'completed',
          output_text: '',
          output: [
            functionCall('call_visual_four_concepts', 'create_style_visual', {
              visualType: 'outfit_visual',
              outfitRefType: 'active',
              recommendationId: null,
              candidateId: null,
              outfitSnapshotId: null,
              aspectRatio: '9:16',
              mode: 'mannequin',
              requestedScope: null,
              conceptTitle: null,
              conceptDescription: null,
              extraInstruction: null,
            }),
          ],
        };
      }
      return {
        id: 'resp_four_concepts_final',
        status: 'completed',
        output_text: 'Look Board 已放到左侧。',
        output: [finalMessage('Look Board 已放到左侧。')],
      };
    },
  });
  const state = runtime.stateStore.get('openai-runtime-test');
  const outfit: OutfitCandidate = {
    id: 'four_concept_outfit',
    name: '四件概念搭配',
    items: [
      { category: 'top', name: '黑色短袖圆领 T', color: '黑色', source: 'suggested_complement' },
      { category: 'outerwear', name: '浅蓝轻薄衬衫', color: '浅蓝', source: 'suggested_complement' },
      { category: 'bottom', name: '米白直筒裤', color: '米白', source: 'suggested_complement' },
      { category: 'shoes', name: '白色运动鞋', color: '白色', source: 'suggested_complement' },
    ],
  };
  state.activeOutfit = outfit;
  state.committedOutfit = {
    type: 'freeform_outfit',
    id: 'four_concept_snapshot',
    outfitSpecId: outfit.id,
    outfit,
    createdAt: new Date().toISOString(),
    disclaimer: 'ai_concept_not_in_closet',
  };

  const result = await runtime.runTurn(input({
    message: '看看这套搭起来什么感觉',
    permissions: {
      allowVisualAnalysis: false,
      allowAiImageGeneration: true,
      allowPhotoUseForTryOn: false,
      allowPersistentMemory: false,
    },
  }));

  assert.equal(result.status, 'completed');
  assert.equal(outputKinds.filter((kind) => kind === 'ai_concept_item').length, 4);
  assert.equal(outputKinds.filter((kind) => kind === 'ai_outfit_visual').length, 1);
  const lookBoard = result.artifacts.find((artifact) => artifact.type === 'look_board');
  assert.ok(lookBoard && lookBoard.type === 'look_board');
  assert.equal(lookBoard.items.length, 4);
  assert.ok(lookBoard.items.some((item) => item.slot === 'shoes'));
});

test('restore_visual_version switches the active visual without calling image generation', async () => {
  const config = openAIImageConfig();
  const services = createServiceContainer(config);
  let visualCalls = 0;
  services.visualGeneration = {
    generate: async () => {
      visualCalls += 1;
      return { bytes: Buffer.from('unexpected'), mimeType: 'image/png' };
    },
  };
  const runtime = new OpenAIMuseRuntime({
    config,
    services,
    stateStore: new InMemorySessionStateStore(),
    responseCreate: async (request) => {
      if (!request.input.some((item: any) => item?.type === 'function_call_output')) {
        return {
          id: 'resp_restore',
          status: 'completed',
          output_text: '',
          output: [
            functionCall('call_restore', 'restore_visual_version', {
              versionRef: 'previous',
              versionId: null,
            }),
          ],
        };
      }
      return {
        id: 'resp_final_restore',
        status: 'completed',
        output_text: '已恢复上一版。',
        output: [finalMessage('已恢复上一版。')],
      };
    },
  });
  const state = runtime.stateStore.get('openai-runtime-test');
  state.images.image_one = {
    id: 'image_one',
    ownerUserId: 'user',
    sessionId: 'openai-runtime-test',
    kind: 'ai_outfit_visual',
    mimeType: 'image/png',
    localPath: path.resolve('./out/image_one.png'),
    url: '/generated/image_one.png',
    createdAt: new Date().toISOString(),
    aiGenerated: true,
    label: '上一版',
  };
  state.images.image_two = {
    ...state.images.image_one,
    id: 'image_two',
    url: '/generated/image_two.png',
    label: '当前版',
  };
  state.visualVersions = {
    v1: {
      versionId: 'v1',
      artifactId: 'artifact_v1',
      imageId: 'image_one',
      outfitSnapshotId: 'outfit_one',
      operation: 'generate',
      scope: 'concept',
      model: 'gpt-5.4-mini',
      promptVersion: 'visual-loop-v2',
      verificationStatus: 'limited',
      limitations: [],
      createdAt: new Date(Date.now() - 1000).toISOString(),
    },
    v2: {
      versionId: 'v2',
      artifactId: 'artifact_v2',
      imageId: 'image_two',
      parentVersionId: 'v1',
      outfitSnapshotId: 'outfit_one',
      operation: 'edit',
      scope: 'concept',
      model: 'gpt-5.4-mini',
      promptVersion: 'visual-loop-v2',
      verificationStatus: 'limited',
      limitations: [],
      createdAt: new Date().toISOString(),
    },
  };
  state.visualSession = {
    currentVersionId: 'v2',
    currentArtifactId: 'artifact_v2',
  };

  const result = await runtime.runTurn(input({ message: '还是上一版好' }));

  assert.equal(visualCalls, 0);
  assert.equal(result.status, 'completed');
  const image = result.artifacts.find((artifact) => artifact.type === 'image');
  assert.ok(image && image.type === 'image');
  assert.equal(image.visualVersionId, 'v1');
  assert.equal(result.state.visualSession?.currentVersionId, 'v1');
});

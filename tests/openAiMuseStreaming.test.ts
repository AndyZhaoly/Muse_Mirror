import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import type http from 'node:http';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createServiceContainer } from '../src/runtime/serviceContainer.js';
import { InMemorySessionStateStore } from '../src/runtime/stateStore.js';
import { OpenAIMuseRuntime } from '../src/server/openAiMuseRuntime.js';
import { writeSse } from '../src/server/sse.js';
import type { FashionTurnInput } from '../src/types.js';

function config() {
  return {
    ...loadConfig(),
    runtimeProvider: 'muse' as const,
    agentProvider: 'openai' as const,
    agentModel: 'gpt-5.4',
    openaiAgentModel: 'gpt-5.4',
    openaiReasoningEffort: 'low' as const,
    imageProvider: 'mock' as const,
    visionProvider: 'mock' as const,
    weatherProvider: 'mock' as const,
    mockTools: true,
  };
}

function turnInput(overrides: Partial<FashionTurnInput> = {}): FashionTurnInput {
  return {
    sessionId: 'stream-test',
    userId: 'stream-user',
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out: ${label}`)), 2000)),
  ]);
}

function messageItem(id: string, phase: 'commentary' | 'final_answer' | undefined, text: string) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    ...(phase ? { phase } : {}),
    content: [{ type: 'output_text', text }],
  };
}

function functionCall(callId: string, name: string, args: unknown) {
  return {
    id: `fc_${callId}`,
    type: 'function_call',
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  };
}

function completedResponse(id: string, output: any[], outputText = '') {
  return { id, status: 'completed', output, output_text: outputText };
}

function textStream(args: {
  id: string;
  phase?: 'commentary' | 'final_answer';
  deltas: string[];
  output?: any[];
  beforeCompleted?: () => Promise<void>;
  afterDeltas?: () => void;
  phaseOnDone?: 'commentary' | 'final_answer';
}) {
  const text = args.deltas.join('');
  const initialItem = messageItem(args.id, args.phase, '');
  const finalItem = messageItem(args.id, args.phaseOnDone ?? args.phase, text);
  const output = args.output ?? [finalItem];
  return (async function* () {
    yield { type: 'response.output_item.added', output_index: 0, item: initialItem };
    for (const delta of args.deltas) {
      yield {
        type: 'response.output_text.delta',
        item_id: args.id,
        output_index: 0,
        content_index: 0,
        delta,
      };
    }
    if (args.phaseOnDone) {
      yield { type: 'response.output_item.done', output_index: 0, item: finalItem };
    }
    args.afterDeltas?.();
    await args.beforeCompleted?.();
    yield {
      type: 'response.completed',
      response: completedResponse(`resp_${args.id}`, output, text),
    };
  })();
}

function makeRuntime(responseCreate: (request: any) => Promise<any>) {
  const runtimeConfig = config();
  return new OpenAIMuseRuntime({
    config: runtimeConfig,
    services: createServiceContainer(runtimeConfig),
    stateStore: new InMemorySessionStateStore(),
    responseCreate,
  });
}

function seedFreshUpperBodyObservation(runtime: OpenAIMuseRuntime): void {
  const state = runtime.stateStore.get('stream-test');
  const now = Date.now();
  state.currentUserImageId = 'frame_stream';
  state.images.frame_stream = {
    id: 'frame_stream',
    ownerUserId: 'stream-user',
    sessionId: 'stream-test',
    kind: 'user_photo',
    mimeType: 'image/jpeg',
    createdAt: new Date(now).toISOString(),
    aiGenerated: false,
  };
  state.visualCache = {
    imageId: 'frame_stream',
    source: 'quick',
    cachedAt: new Date(now).toISOString(),
    observationId: 'obs_stream',
    sourceFrameId: 'frame_stream',
    analyzedAt: now,
    expiresAt: now + 20_000,
    observation: {
      visibleItems: [{ category: 'top', description: '黑色短袖', color: 'black', fit: 'regular' }],
      mainColors: ['black'],
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
    latestFrameId: 'frame_stream',
    frameCapturedAt: now,
    frameReceivedAt: now,
    observationId: 'obs_stream',
    sourceFrameId: 'frame_stream',
    analyzedAt: now,
    expiresAt: now + 20_000,
    status: 'observed',
    visibleRegion: 'upper_body',
    confidence: 0.9,
    summary: '看到黑色短袖和上半身',
  };
}

test('streams final-answer deltas before response.completed', async () => {
  const releaseCompleted = deferred();
  const reachedPause = deferred();
  const deltas: string[] = [];
  const runtime = makeRuntime(async () => textStream({
    id: 'msg_live',
    phase: 'final_answer',
    deltas: ['你', '好'],
    afterDeltas: () => reachedPause.resolve(),
    beforeCompleted: () => releaseCompleted.promise,
  }));

  const resultPromise = runtime.runTurn(turnInput({ onDelta: (delta) => deltas.push(delta) }));
  await waitFor(reachedPause.promise, 'provider pause');
  assert.deepEqual(deltas, ['你', '好']);
  releaseCompleted.resolve();
  const result = await resultPromise;
  assert.equal(result.status, 'completed');
  assert.equal(result.text, '你好');
  if (result.status === 'completed') {
    assert.ok(result.telemetry?.timings.first_final_answer_delta !== undefined);
    assert.ok(result.telemetry?.timings.final_result_ready !== undefined);
    assert.ok(
      (result.telemetry?.timings.first_final_answer_delta ?? Infinity) <=
      (result.telemetry?.timings.final_result_ready ?? -Infinity),
    );
  }
});

test('commentary deltas never enter final text while the tool call still executes', async () => {
  const requests: any[] = [];
  const deltas: string[] = [];
  const commentary: string[] = [];
  const runtime = makeRuntime(async (request) => {
    requests.push(request);
    if (requests.length === 1) {
      const call = functionCall('weather_1', 'get_weather', { location: '杭州' });
      return textStream({
        id: 'msg_commentary',
        phase: 'commentary',
        deltas: ['我先看一下天气'],
        output: [messageItem('msg_commentary', 'commentary', '我先看一下天气'), call],
      });
    }
    return textStream({ id: 'msg_weather_final', phase: 'final_answer', deltas: ['今天适合轻装出门。'] });
  });

  const result = await runtime.runTurn(turnInput({
    message: '今天天气适合穿什么？',
    onDelta: (delta) => deltas.push(delta),
    onCommentary: (text) => commentary.push(text),
  }));

  assert.equal(result.status, 'completed');
  assert.equal(deltas.join(''), '今天适合轻装出门。');
  assert.deepEqual(commentary, ['我先看一下天气']);
  assert.ok(result.activity.some((item) => item.toolName === 'get_weather' && item.status === 'completed'));
});

test('streams the second model round after a visual tool completes', async () => {
  const releaseCompleted = deferred();
  const reachedPause = deferred();
  const deltas: string[] = [];
  let calls = 0;
  const runtime = makeRuntime(async () => {
    calls += 1;
    if (calls === 1) {
      const call = functionCall('vision_1', 'observe_current_frame', {});
      return textStream({
        id: 'msg_visual_commentary',
        phase: 'commentary',
        deltas: ['我先看一下当前画面'],
        output: [messageItem('msg_visual_commentary', 'commentary', '我先看一下当前画面'), call],
      });
    }
    return textStream({
      id: 'msg_visual_final',
      phase: 'final_answer',
      deltas: ['看到你的上半身，', '黑色短袖比较清楚。'],
      afterDeltas: () => reachedPause.resolve(),
      beforeCompleted: () => releaseCompleted.promise,
    });
  });
  seedFreshUpperBodyObservation(runtime);

  const resultPromise = runtime.runTurn(turnInput({
    message: '你现在看到我穿什么吗？',
    permissions: { ...turnInput().permissions, allowVisualAnalysis: true },
    onDelta: (delta) => deltas.push(delta),
  }));
  await waitFor(reachedPause.promise, 'second round pause');
  assert.equal(deltas.join(''), '看到你的上半身，黑色短袖比较清楚。');
  releaseCompleted.resolve();
  const result = await resultPromise;
  assert.equal(result.status, 'completed');
  assert.ok(result.activity.some((item) => item.toolName === 'observe_current_frame' && item.status === 'completed'));
  if (result.status === 'completed') {
    const timings = result.telemetry?.timings;
    assert.equal(result.telemetry?.modelRounds, 2);
    assert.equal(result.telemetry?.usedVision, true);
    assert.ok(timings?.tool_started !== undefined);
    assert.ok(timings?.tool_completed !== undefined);
    assert.ok(timings?.first_final_answer_delta !== undefined);
    assert.ok((timings?.tool_started ?? Infinity) <= (timings?.tool_completed ?? -Infinity));
    assert.ok((timings?.tool_completed ?? Infinity) <= (timings?.first_final_answer_delta ?? -Infinity));
  }
});

test('does not resend a completed final answer after streaming its deltas', async () => {
  const deltas: string[] = [];
  const runtime = makeRuntime(async () => textStream({
    id: 'msg_once',
    phase: 'final_answer',
    deltas: ['今天', '适合', '穿衬衫'],
  }));

  const result = await runtime.runTurn(turnInput({ onDelta: (delta) => deltas.push(delta) }));
  assert.equal(deltas.join(''), '今天适合穿衬衫');
  assert.deepEqual(deltas, ['今天', '适合', '穿衬衫']);
  assert.equal(result.status, 'completed');
  assert.equal(result.text, '今天适合穿衬衫');
});

test('preserves provider order across multiple final message items and ignores non-text deltas', async () => {
  const deltas: string[] = [];
  const first = messageItem('msg_multi_1', 'final_answer', '第一行\n');
  const second = messageItem('msg_multi_2', 'final_answer', '第二行。');
  const runtime = makeRuntime(async () => (async function* () {
    yield { type: 'response.output_item.added', output_index: 0, item: first };
    yield { type: 'response.output_text.delta', item_id: first.id, output_index: 0, content_index: 0, delta: '第一行\n' };
    yield { type: 'response.function_call_arguments.delta', item_id: 'fc_hidden', output_index: 1, delta: '{"secret":' };
    yield { type: 'response.output_item.added', output_index: 2, item: second };
    yield { type: 'response.output_text.delta', item_id: second.id, output_index: 2, content_index: 0, delta: '第二行。' };
    yield {
      type: 'response.completed',
      response: completedResponse('resp_multi', [first, second], '第一行\n第二行。'),
    };
  })());

  const result = await runtime.runTurn(turnInput({ onDelta: (delta) => deltas.push(delta) }));
  assert.deepEqual(deltas, ['第一行\n', '第二行。']);
  assert.equal(deltas.join(''), '第一行\n第二行。');
  assert.doesNotMatch(deltas.join(''), /secret/);
  assert.equal(result.status, 'completed');
});

test('falls back to one complete delta for a non-streaming response', async () => {
  const deltas: string[] = [];
  const runtime = makeRuntime(async () => completedResponse(
    'resp_nonstream',
    [messageItem('msg_nonstream', 'final_answer', '普通响应也能显示。')],
    '普通响应也能显示。',
  ));

  const result = await runtime.runTurn(turnInput({ onDelta: (delta) => deltas.push(delta) }));
  assert.deepEqual(deltas, ['普通响应也能显示。']);
  assert.equal(result.status, 'completed');
  assert.equal(result.text, '普通响应也能显示。');
});

test('streams provider text but stores and returns the grounded final calibration', async () => {
  const requests: any[] = [];
  const deltas: string[] = [];
  const unsupportedClaim = '我现在看到你穿着一件黑色短袖。';
  const runtime = makeRuntime(async (request) => {
    requests.push(request);
    if (requests.length === 1) {
      return textStream({ id: 'msg_unguarded', phase: 'final_answer', deltas: [unsupportedClaim] });
    }
    return completedResponse('resp_followup', [messageItem('msg_followup', 'final_answer', '好的。')], '好的。');
  });

  const first = await runtime.runTurn(turnInput({ onDelta: (delta) => deltas.push(delta) }));
  assert.equal(deltas.join(''), unsupportedClaim);
  assert.equal(first.status, 'completed');
  assert.match(first.text, /还没有拿到当前画面的视觉结果/);

  await runtime.runTurn(turnInput({ message: '明白了' }));
  const historyAssistant = requests[1]?.input?.find(
    (item: any) => item?.role === 'assistant' && /还没有拿到当前画面的视觉结果/.test(item.content),
  );
  assert.ok(historyAssistant, 'history should contain the grounded result rather than streamed partial text');
});

test('retries a retryable failure before any final-answer delta is visible', async () => {
  let attempts = 0;
  const deltas: string[] = [];
  const runtime = makeRuntime(async () => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error('temporary upstream failure') as Error & { status: number };
      error.status = 500;
      throw error;
    }
    return textStream({ id: 'msg_retry_ok', phase: 'final_answer', deltas: ['重试后成功。'] });
  });

  const result = await runtime.runTurn(turnInput({ onDelta: (delta) => deltas.push(delta) }));
  assert.equal(attempts, 2);
  assert.deepEqual(deltas, ['重试后成功。']);
  assert.equal(result.status, 'completed');
});

test('does not silently retry after a final-answer delta was visible', async () => {
  let attempts = 0;
  const deltas: string[] = [];
  const runtime = makeRuntime(async () => {
    attempts += 1;
    return (async function* () {
      yield {
        type: 'response.output_item.added',
        output_index: 0,
        item: messageItem('msg_partial_failure', 'final_answer', ''),
      };
      yield {
        type: 'response.output_text.delta',
        item_id: 'msg_partial_failure',
        output_index: 0,
        content_index: 0,
        delta: '已经显示',
      };
      const error = new Error('stream disconnected') as Error & { status: number };
      error.status = 500;
      throw error;
    })();
  });

  await assert.rejects(
    () => runtime.runTurn(turnInput({ onDelta: (delta) => deltas.push(delta) })),
    /暂时没有成功返回/,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(deltas, ['已经显示']);
});

test('buffers unknown-phase text until confirmed and safely falls back if never confirmed', async (t) => {
  await t.test('flushes in order after a later final_answer phase', async () => {
    const releaseCompleted = deferred();
    const phaseConfirmed = deferred();
    const deltas: string[] = [];
    const runtime = makeRuntime(async () => textStream({
      id: 'msg_late_phase',
      deltas: ['晚', '到'],
      phaseOnDone: 'final_answer',
      afterDeltas: () => phaseConfirmed.resolve(),
      beforeCompleted: () => releaseCompleted.promise,
    }));
    const resultPromise = runtime.runTurn(turnInput({ onDelta: (delta) => deltas.push(delta) }));
    await waitFor(phaseConfirmed.promise, 'late phase confirmation');
    assert.deepEqual(deltas, ['晚', '到']);
    releaseCompleted.resolve();
    await resultPromise;
  });

  await t.test('does not stream an unresolved phase and emits one safe completed fallback', async () => {
    const releaseCompleted = deferred();
    const reachedPause = deferred();
    const deltas: string[] = [];
    const runtime = makeRuntime(async () => textStream({
      id: 'msg_unknown',
      deltas: ['未知阶段正文'],
      afterDeltas: () => reachedPause.resolve(),
      beforeCompleted: () => releaseCompleted.promise,
    }));
    const resultPromise = runtime.runTurn(turnInput({ onDelta: (delta) => deltas.push(delta) }));
    await waitFor(reachedPause.promise, 'unknown phase pause');
    assert.deepEqual(deltas, []);
    releaseCompleted.resolve();
    const result = await resultPromise;
    assert.deepEqual(deltas, ['未知阶段正文']);
    assert.equal(result.status, 'completed');
  });
});

test('writes ordered SSE deltas before result while keeping commentary separate', async () => {
  const releaseCompleted = deferred();
  const reachedPause = deferred();
  let calls = 0;
  const runtime = makeRuntime(async () => {
    calls += 1;
    if (calls === 1) {
      const call = functionCall('weather_sse', 'get_weather', { location: '杭州' });
      return textStream({
        id: 'msg_sse_commentary',
        phase: 'commentary',
        deltas: ['我先查看天气'],
        output: [messageItem('msg_sse_commentary', 'commentary', '我先查看天气'), call],
      });
    }
    return textStream({
      id: 'msg_sse_final',
      phase: 'final_answer',
      deltas: ['第一个', '，第二个。'],
      afterDeltas: () => reachedPause.resolve(),
      beforeCompleted: () => releaseCompleted.promise,
    });
  });
  const sink = new PassThrough();
  let raw = '';
  sink.on('data', (chunk) => { raw += chunk.toString('utf8'); });
  const response = sink as unknown as http.ServerResponse;

  const resultPromise = runtime.runTurn(turnInput({
    message: '结合天气给我一句建议',
    onDelta: (text) => writeSse(response, 'delta', { text }),
    onCommentary: (text) => writeSse(response, 'commentary', { text }),
  }));
  await waitFor(reachedPause.promise, 'SSE final pause');
  assert.match(raw, /event: commentary/);
  assert.match(raw, /event: delta[\s\S]*第一个[\s\S]*event: delta[\s\S]*第二个/);
  assert.doesNotMatch(raw.match(/event: delta[\s\S]*/)?.[0] ?? '', /我先查看天气/);
  assert.doesNotMatch(raw, /event: result/);

  releaseCompleted.resolve();
  const result = await resultPromise;
  writeSse(response, 'result', result);
  assert.ok(raw.indexOf('event: delta') < raw.indexOf('event: result'));
  assert.match(raw, /"text":"第一个，第二个。"/);
});

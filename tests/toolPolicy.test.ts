import assert from 'node:assert/strict';
import { RunContext } from '@openai/agents';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createServiceContainer } from '../src/runtime/serviceContainer.js';
import { createEmptySessionState } from '../src/runtime/stateStore.js';
import { createFashionTools } from '../src/tools/index.js';
import type { FashionAgentContext } from '../src/types.js';

function context(): FashionAgentContext {
  return {
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
}

const services = createServiceContainer({ ...loadConfig(), mockTools: true });
const tools = createFashionTools(services);

function named(name: string) {
  const found = tools.find((tool) => tool.name === name);
  assert.ok(found && found.type === 'function');
  return found;
}

test('try-on requires approval without photo and image consent', async () => {
  const ctx = context();
  const required = await named('generate_try_on_preview').needsApproval(
    new RunContext(ctx),
    { aspectRatio: '4:5' } as never,
  );
  assert.equal(required, true);

  ctx.permissions.allowAiImageGeneration = true;
  ctx.permissions.allowPhotoUseForTryOn = true;
  const allowed = await named('generate_try_on_preview').needsApproval(
    new RunContext(ctx),
    { aspectRatio: '4:5' } as never,
  );
  assert.equal(allowed, false);
});

test('persistent memory requires approval but session memory does not', async () => {
  const ctx = context();
  const tool = named('save_user_preference');
  assert.equal(
    await tool.needsApproval(new RunContext(ctx), {
      key: 'avoidItems',
      value: ['高跟鞋'],
      scope: 'persistent',
      evidence: '以后不要推荐高跟鞋',
    } as never),
    true,
  );
  assert.equal(
    await tool.needsApproval(new RunContext(ctx), {
      key: 'todayStyle',
      value: 'relaxed',
      scope: 'session',
      evidence: '今天想松弛一点',
    } as never),
    false,
  );
});

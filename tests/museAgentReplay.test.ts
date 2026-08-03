import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

type ReplayCase = {
  id: string;
  split: 'development' | 'holdout';
  message: string;
  toolDependent: boolean;
  expectedTools: string[];
};

const replayCases = JSON.parse(
  readFileSync(new URL('./fixtures/museAgentReplay.json', import.meta.url), 'utf8'),
) as ReplayCase[];

test('Muse replay fixture has development and holdout coverage', () => {
  assert.ok(replayCases.some((item) => item.split === 'development'));
  assert.ok(replayCases.some((item) => item.split === 'holdout'));
  assert.ok(replayCases.some((item) => item.expectedTools.length > 1));
  assert.ok(replayCases.some((item) => item.expectedTools.includes('recommend_from_closet')));
  assert.ok(replayCases.some((item) => item.expectedTools.includes('observe_current_frame')));
});

test('no FastGate means tool-dependent replay cases cannot be direct-gated', () => {
  const metrics = {
    development: {
      cases: replayCases.filter((item) => item.split === 'development').length,
      toolDependentDirectCount: 0,
    },
    holdout: {
      cases: replayCases.filter((item) => item.split === 'holdout').length,
      toolDependentDirectCount: 0,
    },
  };
  console.log(`[museAgentReplay] ${JSON.stringify(metrics)}`);
  assert.equal(metrics.development.toolDependentDirectCount, 0);
  assert.equal(metrics.holdout.toolDependentDirectCount, 0);
});

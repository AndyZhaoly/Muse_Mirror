import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MIRROR_SITUATION_SCENARIOS,
  getMirrorSituationScenario,
  runAllMirrorSituationScenarios,
  runMirrorSituationScenario,
} from '../src/policy/mirrorSituationScenarios.js';

test('scenario catalog has unique IDs and at least twelve deterministic fixtures', () => {
  const ids = MIRROR_SITUATION_SCENARIOS.map((scenario) => scenario.id);
  assert.ok(ids.length >= 12);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(MIRROR_SITUATION_SCENARIOS.every((scenario) => scenario.title && scenario.description));
});

test('all mirror situation scenario golden expectations pass', () => {
  const results = runAllMirrorSituationScenarios();
  const failures = results.filter((result) => !result.passed);
  assert.deepEqual(failures, []);
});

test('golden action sequence remains explicit and reviewable', () => {
  assert.deepEqual(
    MIRROR_SITUATION_SCENARIOS.map((scenario) => [scenario.id, scenario.expected.action]),
    [
      ['empty_mirror', 'remain_silent'],
      ['unknown_visitor', 'privacy_pause'],
      ['multiple_people', 'privacy_pause'],
      ['sensitive_dressing', 'privacy_pause'],
      ['stale_observation', 'observe_more'],
      ['limited_head_shoulders', 'observe_more'],
      ['high_motion', 'observe_more'],
      ['active_agent_task', 'defer'],
      ['matched_worn_item', 'remain_silent'],
      ['unmatched_worn_unknown_ownership', 'observe_more'],
      ['held_unmatched_stable', 'ask_ownership'],
      ['held_question_already_asked', 'defer'],
      ['confirmed_not_owned', 'remain_silent'],
      ['confirmed_owned_candidate', 'candidate_ready'],
      ['confirmed_owned_authorized', 'candidate_ready'],
    ],
  );
});

test('scenario runner is deterministic and does not mutate fixtures', () => {
  const scenario = getMirrorSituationScenario('held_unmatched_stable');
  assert.ok(scenario);
  const before = JSON.stringify(scenario);
  const first = runMirrorSituationScenario(scenario);
  const second = runMirrorSituationScenario(scenario);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(scenario), before);
});

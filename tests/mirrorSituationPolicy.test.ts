import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  createOutfitEpisode,
  reduceOutfitEpisode,
  reduceOutfitEpisodeEvents,
  type OutfitEpisode,
} from '../src/domain/outfitEpisode.js';
import type { MirrorSituationObservation } from '../src/domain/mirrorSituation.js';
import { decideMirrorSituation } from '../src/policy/mirrorSituationPolicy.js';

const TIME = '2026-08-05T08:00:00.000Z';

function observation(
  id: string,
  overrides: Partial<MirrorSituationObservation> = {},
): MirrorSituationObservation {
  return {
    observationId: id,
    observedAt: TIME,
    personCount: 1,
    identity: 'known_user',
    activity: 'stationary',
    motion: 'still',
    garmentPresentation: 'held',
    closetMatch: 'unmatched',
    ownership: 'unknown',
    coverage: 'upper_body',
    quality: 'good',
    freshness: 'fresh',
    activeTask: 'none',
    privacyRisk: 'none',
    userAvailableForInterruption: true,
    permissions: {
      wearRecording: 'unknown',
      closetPersistence: 'unknown',
    },
    confidence: {
      situation: 0.9,
      garment: 0.9,
      identity: 0.95,
    },
    ...overrides,
  };
}

function stableEpisode(
  first: MirrorSituationObservation,
  second: MirrorSituationObservation,
): OutfitEpisode {
  return reduceOutfitEpisodeEvents(
    createOutfitEpisode({ episodeId: 'episode-1', startedAt: TIME }),
    [
      { type: 'observation_received', observation: first },
      { type: 'observation_received', observation: second },
    ],
  );
}

test('policy is deterministic and does not mutate observation or episode', () => {
  const first = observation('o1');
  const second = observation('o2');
  const episode = stableEpisode(first, second);
  const before = JSON.stringify({ observation: second, episode });

  const one = decideMirrorSituation({ observation: second, episode });
  const two = decideMirrorSituation({ observation: second, episode });

  assert.deepEqual(one, two);
  assert.equal(JSON.stringify({ observation: second, episode }), before);
});

test('unmatched visual evidence never becomes ownership or a closet candidate by itself', () => {
  const first = observation('o1', { garmentPresentation: 'worn' });
  const second = observation('o2', { garmentPresentation: 'worn' });
  const decision = decideMirrorSituation({
    observation: second,
    episode: stableEpisode(first, second),
  });

  assert.equal(decision.action, 'observe_more');
  assert.equal(decision.eligibility.garmentCandidate, 'prohibited');
  assert.equal(decision.eligibility.closetPersistence, 'prohibited');
  assert.ok(decision.reasonCodes.includes('OWNERSHIP_UNKNOWN'));
});

test('stable held garment may ask ownership once but never persists it', () => {
  const first = observation('o1');
  const second = observation('o2');
  const episode = stableEpisode(first, second);
  const decision = decideMirrorSituation({ observation: second, episode });

  assert.equal(decision.action, 'ask_ownership');
  assert.equal(decision.interruption, 'ask_once');
  assert.equal(decision.eligibility.garmentCandidate, 'prohibited');
  assert.equal(decision.eligibility.closetPersistence, 'prohibited');
});

test('episode prevents duplicate ownership prompts', () => {
  const first = observation('o1');
  const second = observation('o2');
  const asked = reduceOutfitEpisode(stableEpisode(first, second), {
    type: 'ownership_question_asked',
    occurredAt: TIME,
  });
  const decision = decideMirrorSituation({ observation: second, episode: asked });

  assert.equal(decision.action, 'defer');
  assert.equal(decision.interruption, 'defer');
  assert.ok(decision.reasonCodes.includes('OWNERSHIP_ALREADY_REQUESTED'));
});

test('candidate eligibility requires confirmed ownership and a stable episode', () => {
  const first = observation('o1', { ownership: 'confirmed_user_owned' });
  const second = observation('o2', { ownership: 'confirmed_user_owned' });
  const unstable = reduceOutfitEpisode(
    createOutfitEpisode({ episodeId: 'episode-1', startedAt: TIME }),
    { type: 'observation_received', observation: first },
  );

  const beforeStable = decideMirrorSituation({ observation: first, episode: unstable });
  const afterStable = decideMirrorSituation({
    observation: second,
    episode: reduceOutfitEpisode(unstable, { type: 'observation_received', observation: second }),
  });

  assert.equal(beforeStable.eligibility.garmentCandidate, 'prohibited');
  assert.equal(afterStable.action, 'candidate_ready');
  assert.equal(afterStable.eligibility.garmentCandidate, 'eligible');
  assert.equal(afterStable.eligibility.closetPersistence, 'requires_user_confirmation');
});

test('explicit ownership confirmation in the episode outranks an unresolved visual ownership field', () => {
  const first = observation('o1');
  const second = observation('o2');
  const confirmed = reduceOutfitEpisode(
    stableEpisode(first, second),
    {
      type: 'ownership_confirmed',
      ownership: 'confirmed_user_owned',
      occurredAt: TIME,
    },
  );
  const decision = decideMirrorSituation({ observation: second, episode: confirmed });

  assert.equal(decision.action, 'candidate_ready');
  assert.ok(decision.reasonCodes.includes('OWNERSHIP_CONFIRMED_USER'));
  assert.equal(decision.eligibility.garmentCandidate, 'eligible');
});

test('one matched frame is not enough to make a wear record eligible', () => {
  const current = observation('o1', {
    garmentPresentation: 'worn',
    closetMatch: 'matched',
    ownership: 'confirmed_user_owned',
    permissions: {
      wearRecording: 'granted',
      closetPersistence: 'unknown',
    },
  });
  const episode = reduceOutfitEpisode(
    createOutfitEpisode({ episodeId: 'episode-1', startedAt: TIME }),
    { type: 'observation_received', observation: current },
  );
  const decision = decideMirrorSituation({ observation: current, episode });

  assert.equal(decision.action, 'remain_silent');
  assert.equal(decision.eligibility.wearRecord, 'prohibited');
  assert.ok(decision.reasonCodes.includes('EPISODE_NOT_STABLE'));
});

test('closet persistence becomes eligible only with explicit granted permission', () => {
  const permissions = {
    wearRecording: 'granted' as const,
    closetPersistence: 'granted' as const,
  };
  const first = observation('o1', { ownership: 'confirmed_user_owned', permissions });
  const second = observation('o2', { ownership: 'confirmed_user_owned', permissions });
  const decision = decideMirrorSituation({
    observation: second,
    episode: stableEpisode(first, second),
  });

  assert.equal(decision.eligibility.garmentCandidate, 'eligible');
  assert.equal(decision.eligibility.closetPersistence, 'eligible');
});

test('matched worn item can be wear-record eligible without becoming a new candidate', () => {
  const permissions = {
    wearRecording: 'granted' as const,
    closetPersistence: 'unknown' as const,
  };
  const first = observation('o1', {
    garmentPresentation: 'worn',
    closetMatch: 'matched',
    ownership: 'confirmed_user_owned',
    permissions,
  });
  const second = observation('o2', {
    garmentPresentation: 'worn',
    closetMatch: 'matched',
    ownership: 'confirmed_user_owned',
    permissions,
  });
  const decision = decideMirrorSituation({
    observation: second,
    episode: stableEpisode(first, second),
  });

  assert.equal(decision.action, 'remain_silent');
  assert.equal(decision.eligibility.wearRecord, 'eligible');
  assert.equal(decision.eligibility.garmentCandidate, 'prohibited');
});

test('privacy pause outranks active task and candidate eligibility', () => {
  const current = observation('o1', {
    personCount: 2,
    privacyRisk: 'multiple_people',
    activeTask: 'closet_recommendation',
    ownership: 'confirmed_user_owned',
  });
  const decision = decideMirrorSituation({
    observation: current,
    episode: createOutfitEpisode({ episodeId: 'episode-1', startedAt: TIME }),
  });

  assert.equal(decision.action, 'privacy_pause');
  assert.equal(decision.privacyPaused, true);
  assert.equal(decision.reasonCodes[0], 'MULTIPLE_PEOPLE_PRESENT');
  assert.equal(decision.eligibility.garmentCandidate, 'prohibited');
});

test('episode becomes stable only after two consecutive reliable matching signals', () => {
  const initial = createOutfitEpisode({ episodeId: 'episode-1', startedAt: TIME });
  const first = reduceOutfitEpisode(initial, {
    type: 'observation_received',
    observation: observation('o1'),
  });
  const changed = reduceOutfitEpisode(first, {
    type: 'observation_received',
    observation: observation('o2', { garmentPresentation: 'worn' }),
  });
  const stable = reduceOutfitEpisode(changed, {
    type: 'observation_received',
    observation: observation('o3', { garmentPresentation: 'worn' }),
  });

  assert.equal(first.status, 'observing');
  assert.equal(first.consecutiveReliableObservations, 1);
  assert.equal(changed.status, 'observing');
  assert.equal(changed.consecutiveReliableObservations, 1);
  assert.equal(stable.status, 'stable');
  assert.equal(stable.consecutiveReliableObservations, 2);
});

test('unreliable observation resets episode stability and ended episodes are immutable', () => {
  const first = observation('o1');
  const second = observation('o2');
  const stable = stableEpisode(first, second);
  const reset = reduceOutfitEpisode(stable, {
    type: 'observation_received',
    observation: observation('o3', { quality: 'limited' }),
  });
  const ended = reduceOutfitEpisode(reset, { type: 'episode_ended', occurredAt: TIME });
  const afterEnd = reduceOutfitEpisode(ended, {
    type: 'observation_received',
    observation: observation('o4'),
  });

  assert.equal(reset.status, 'observing');
  assert.equal(reset.consecutiveReliableObservations, 0);
  assert.equal(ended.status, 'ended');
  assert.equal(afterEnd, ended);
});

test('policy and reducer source contain no provider, clock, random, DOM, or storage dependency', () => {
  const policy = readFileSync('src/policy/mirrorSituationPolicy.ts', 'utf8');
  const reducer = readFileSync('src/domain/outfitEpisode.ts', 'utf8');
  const source = `${policy}\n${reducer}`;

  assert.doesNotMatch(
    source,
    /\bfetch\b|OpenAI|Vision|Date\.now|new Date|Math\.random|localStorage|sessionStorage|document\.|window\.|setTimeout|setInterval/,
  );
});

import {
  createOutfitEpisode,
  reduceOutfitEpisodeEvents,
  type OutfitEpisode,
  type OutfitEpisodeEvent,
} from '../domain/outfitEpisode.js';
import type {
  MirrorSituationAction,
  MirrorSituationDecision,
  MirrorSituationObservation,
  MirrorSituationReasonCode,
} from '../domain/mirrorSituation.js';
import { decideMirrorSituation } from './mirrorSituationPolicy.js';

export interface MirrorSituationScenarioExpectation {
  action: MirrorSituationAction;
  reasonCodes: MirrorSituationReasonCode[];
  wearRecord: MirrorSituationDecision['eligibility']['wearRecord'];
  garmentCandidate: MirrorSituationDecision['eligibility']['garmentCandidate'];
  closetPersistence: MirrorSituationDecision['eligibility']['closetPersistence'];
}

export interface MirrorSituationScenario {
  id: string;
  title: string;
  description: string;
  observation: MirrorSituationObservation;
  episode: OutfitEpisode;
  expected: MirrorSituationScenarioExpectation;
}

export interface MirrorSituationScenarioResult {
  scenarioId: string;
  passed: boolean;
  decision: MirrorSituationDecision;
  mismatches: string[];
}

const BASE_TIME = '2026-08-05T08:00:00.000Z';

function observation(
  id: string,
  overrides: Partial<MirrorSituationObservation> = {},
): MirrorSituationObservation {
  return {
    observationId: id,
    observedAt: BASE_TIME,
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
      situation: 0.92,
      garment: 0.9,
      identity: 0.96,
    },
    ...overrides,
  };
}

function episodeFor(
  id: string,
  observations: readonly MirrorSituationObservation[],
  events: readonly OutfitEpisodeEvent[] = [],
): OutfitEpisode {
  return reduceOutfitEpisodeEvents(
    createOutfitEpisode({ episodeId: `episode_${id}`, startedAt: BASE_TIME }),
    [
      ...observations.map((item): OutfitEpisodeEvent => ({
        type: 'observation_received',
        observation: item,
      })),
      ...events,
    ],
  );
}

function stablePair(
  id: string,
  overrides: Partial<MirrorSituationObservation> = {},
): [MirrorSituationObservation, MirrorSituationObservation] {
  return [
    observation(`${id}_1`, overrides),
    observation(`${id}_2`, overrides),
  ];
}

function expected(
  action: MirrorSituationAction,
  reasonCodes: MirrorSituationReasonCode[],
  overrides: Partial<Omit<MirrorSituationScenarioExpectation, 'action' | 'reasonCodes'>> = {},
): MirrorSituationScenarioExpectation {
  return {
    action,
    reasonCodes,
    wearRecord: 'prohibited',
    garmentCandidate: 'prohibited',
    closetPersistence: 'prohibited',
    ...overrides,
  };
}

const heldUnknown = stablePair('held_unknown');
const heldAlreadyAsked = stablePair('held_asked');
const ownedCandidate = stablePair('owned_candidate', {
  ownership: 'confirmed_user_owned',
});
const ownedAuthorized = stablePair('owned_authorized', {
  ownership: 'confirmed_user_owned',
  permissions: {
    wearRecording: 'granted',
    closetPersistence: 'granted',
  },
});
const matchedWorn = stablePair('matched_worn', {
  garmentPresentation: 'worn',
  closetMatch: 'matched',
  ownership: 'confirmed_user_owned',
  permissions: {
    wearRecording: 'granted',
    closetPersistence: 'unknown',
  },
});

export const MIRROR_SITUATION_SCENARIOS: readonly MirrorSituationScenario[] = [
  {
    id: 'empty_mirror',
    title: '镜子前无人',
    description: '无人出现时保持安静。',
    observation: observation('empty', {
      personCount: 0,
      identity: 'no_person',
      activity: 'absent',
      garmentPresentation: 'none',
      coverage: 'none',
    }),
    episode: episodeFor('empty', []),
    expected: expected('remain_silent', ['NO_PERSON_PRESENT']),
  },
  {
    id: 'unknown_visitor',
    title: '未知访客',
    description: '不能确认当前用户时进入隐私暂停。',
    observation: observation('visitor', {
      identity: 'unknown_person',
      privacyRisk: 'unknown_person',
    }),
    episode: episodeFor('visitor', []),
    expected: expected('privacy_pause', ['UNKNOWN_PERSON_PRESENT']),
  },
  {
    id: 'multiple_people',
    title: '多人画面',
    description: '多人画面不生成穿着记录或衣物候选。',
    observation: observation('multiple', {
      personCount: 2,
      privacyRisk: 'multiple_people',
    }),
    episode: episodeFor('multiple', []),
    expected: expected('privacy_pause', ['MULTIPLE_PEOPLE_PRESENT']),
  },
  {
    id: 'sensitive_dressing',
    title: '穿脱衣隐私情境',
    description: '敏感情境立即隐私暂停。',
    observation: observation('dressing', {
      activity: 'dressing',
      privacyRisk: 'sensitive_context',
    }),
    episode: episodeFor('dressing', []),
    expected: expected('privacy_pause', ['PRIVACY_RISK_PRESENT']),
  },
  {
    id: 'stale_observation',
    title: '观察已过期',
    description: '旧画面不能支持新决策。',
    observation: observation('stale', { freshness: 'stale' }),
    episode: episodeFor('stale', []),
    expected: expected('observe_more', ['KNOWN_USER_PRESENT', 'OBSERVATION_STALE']),
  },
  {
    id: 'limited_head_shoulders',
    title: '只有头肩且画面有限',
    description: '衣物覆盖不足时继续静默观察。',
    observation: observation('limited', {
      coverage: 'head_shoulders',
      quality: 'limited',
    }),
    episode: episodeFor('limited', []),
    expected: expected('observe_more', ['KNOWN_USER_PRESENT', 'OBSERVATION_LIMITED']),
  },
  {
    id: 'high_motion',
    title: '用户正在转身',
    description: '移动中不形成新衣物结论。',
    observation: observation('motion', {
      activity: 'turning',
      motion: 'high_motion',
    }),
    episode: episodeFor('motion', []),
    expected: expected('observe_more', ['KNOWN_USER_PRESENT', 'HIGH_MOTION']),
  },
  {
    id: 'active_agent_task',
    title: '已有 Agent 任务',
    description: '正在对话或生成时不插入新的衣物询问。',
    observation: observation('active_task', {
      activeTask: 'closet_recommendation',
    }),
    episode: episodeFor('active_task', []),
    expected: expected('defer', ['KNOWN_USER_PRESENT', 'ACTIVE_TASK_IN_PROGRESS']),
  },
  {
    id: 'matched_worn_item',
    title: '已匹配衣橱穿着',
    description: '已有衣橱匹配时保持安静；明确授权时可记录穿着。',
    observation: matchedWorn[1],
    episode: episodeFor('matched_worn', matchedWorn),
    expected: expected(
      'remain_silent',
      ['KNOWN_USER_PRESENT', 'GARMENT_WORN', 'CLOSET_ALREADY_MATCHED'],
      { wearRecord: 'eligible' },
    ),
  },
  {
    id: 'unmatched_worn_unknown_ownership',
    title: '穿着未匹配但归属未知',
    description: '未匹配不等于用户拥有；穿着场景不主动打断。',
    observation: observation('worn_unknown', {
      garmentPresentation: 'worn',
    }),
    episode: episodeFor('worn_unknown', [observation('worn_unknown_0', {
      garmentPresentation: 'worn',
    })]),
    expected: expected(
      'observe_more',
      ['KNOWN_USER_PRESENT', 'GARMENT_WORN', 'CLOSET_UNMATCHED', 'OWNERSHIP_UNKNOWN', 'EPISODE_NOT_STABLE'],
    ),
  },
  {
    id: 'held_unmatched_stable',
    title: '稳定举衣且未匹配',
    description: '稳定、可打扰的举衣场景只询问一次归属。',
    observation: heldUnknown[1],
    episode: episodeFor('held_unknown', heldUnknown),
    expected: expected(
      'ask_ownership',
      ['KNOWN_USER_PRESENT', 'GARMENT_HELD', 'CLOSET_UNMATCHED', 'OWNERSHIP_UNKNOWN'],
    ),
  },
  {
    id: 'held_question_already_asked',
    title: '归属已经问过',
    description: '同一 episode 不重复打扰。',
    observation: heldAlreadyAsked[1],
    episode: episodeFor('held_asked', heldAlreadyAsked, [{
      type: 'ownership_question_asked',
      occurredAt: BASE_TIME,
    }]),
    expected: expected(
      'defer',
      [
        'KNOWN_USER_PRESENT',
        'GARMENT_HELD',
        'CLOSET_UNMATCHED',
        'OWNERSHIP_UNKNOWN',
        'OWNERSHIP_ALREADY_REQUESTED',
      ],
    ),
  },
  {
    id: 'confirmed_not_owned',
    title: '确认不是用户衣物',
    description: '确认借用或他人物品后不生成用户衣橱候选。',
    observation: observation('not_owned', {
      ownership: 'confirmed_not_user_owned',
    }),
    episode: episodeFor('not_owned', []),
    expected: expected(
      'remain_silent',
      ['KNOWN_USER_PRESENT', 'GARMENT_HELD', 'CLOSET_UNMATCHED', 'OWNERSHIP_CONFIRMED_NOT_USER'],
    ),
  },
  {
    id: 'confirmed_owned_candidate',
    title: '确认自有的稳定候选',
    description: '可以形成临时候选；持久化仍需确认。',
    observation: ownedCandidate[1],
    episode: episodeFor('owned_candidate', ownedCandidate),
    expected: expected(
      'candidate_ready',
      [
        'KNOWN_USER_PRESENT',
        'GARMENT_HELD',
        'CLOSET_UNMATCHED',
        'OWNERSHIP_CONFIRMED_USER',
        'WEAR_RECORDING_PERMISSION_MISSING',
        'CLOSET_PERSISTENCE_REQUIRES_CONFIRMATION',
      ],
      { garmentCandidate: 'eligible', closetPersistence: 'requires_user_confirmation' },
    ),
  },
  {
    id: 'confirmed_owned_authorized',
    title: '确认自有且获准持久化',
    description: '策略只返回 eligible，本 PR 仍不执行写入。',
    observation: ownedAuthorized[1],
    episode: episodeFor('owned_authorized', ownedAuthorized),
    expected: expected(
      'candidate_ready',
      ['KNOWN_USER_PRESENT', 'GARMENT_HELD', 'CLOSET_UNMATCHED', 'OWNERSHIP_CONFIRMED_USER'],
      { garmentCandidate: 'eligible', closetPersistence: 'eligible' },
    ),
  },
];

export function getMirrorSituationScenario(id: string): MirrorSituationScenario | undefined {
  return MIRROR_SITUATION_SCENARIOS.find((scenario) => scenario.id === id);
}

export function runMirrorSituationScenario(
  scenario: MirrorSituationScenario,
): MirrorSituationScenarioResult {
  const decision = decideMirrorSituation({
    observation: scenario.observation,
    episode: scenario.episode,
  });
  const mismatches: string[] = [];
  if (decision.action !== scenario.expected.action) {
    mismatches.push(`action: expected ${scenario.expected.action}, received ${decision.action}`);
  }
  if (JSON.stringify(decision.reasonCodes) !== JSON.stringify(scenario.expected.reasonCodes)) {
    mismatches.push(
      `reasonCodes: expected ${scenario.expected.reasonCodes.join(',')}, received ${decision.reasonCodes.join(',')}`,
    );
  }
  if (decision.eligibility.wearRecord !== scenario.expected.wearRecord) {
    mismatches.push(
      `wearRecord: expected ${scenario.expected.wearRecord}, received ${decision.eligibility.wearRecord}`,
    );
  }
  if (decision.eligibility.garmentCandidate !== scenario.expected.garmentCandidate) {
    mismatches.push(
      `garmentCandidate: expected ${scenario.expected.garmentCandidate}, received ${decision.eligibility.garmentCandidate}`,
    );
  }
  if (decision.eligibility.closetPersistence !== scenario.expected.closetPersistence) {
    mismatches.push(
      `closetPersistence: expected ${scenario.expected.closetPersistence}, received ${decision.eligibility.closetPersistence}`,
    );
  }
  return {
    scenarioId: scenario.id,
    passed: mismatches.length === 0,
    decision,
    mismatches,
  };
}

export function runAllMirrorSituationScenarios(): MirrorSituationScenarioResult[] {
  return MIRROR_SITUATION_SCENARIOS.map(runMirrorSituationScenario);
}

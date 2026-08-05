import type { OutfitEpisode } from '../domain/outfitEpisode.js';
import type {
  MirrorSituationDecision,
  MirrorSituationObservation,
  MirrorSituationReasonCode,
} from '../domain/mirrorSituation.js';

export interface MirrorSituationPolicyInput {
  observation: MirrorSituationObservation;
  episode: OutfitEpisode;
}

const hiddenPresentation: MirrorSituationDecision['presentation'] = {
  visibility: 'hidden',
  contentKind: 'device_feedback',
  title: '保持安静',
  detail: '当前不需要打扰用户。',
  tone: 'neutral',
};

export function decideMirrorSituation(
  input: MirrorSituationPolicyInput,
): MirrorSituationDecision {
  const { observation, episode } = input;
  const reasons: MirrorSituationReasonCode[] = [];

  if (observation.personCount === 0 || observation.identity === 'no_person') {
    reasons.push('NO_PERSON_PRESENT');
    return decision('remain_silent', reasons);
  }

  if (observation.privacyRisk === 'camera_disabled') {
    reasons.push('CAMERA_DISABLED');
    return privacyDecision(reasons, '镜子观察已暂停', '摄像头当前不可用于情境观察。');
  }

  if (observation.personCount > 1 || observation.privacyRisk === 'multiple_people') {
    reasons.push('MULTIPLE_PEOPLE_PRESENT');
    return privacyDecision(reasons, '多人画面已暂停', '在多人画面中不生成穿着记录或衣物候选。');
  }

  if (observation.identity === 'unknown_person' || observation.privacyRisk === 'unknown_person') {
    reasons.push('UNKNOWN_PERSON_PRESENT');
    return privacyDecision(reasons, '未知访客画面已暂停', '无法确认是当前用户时不继续处理衣物信息。');
  }

  if (observation.privacyRisk === 'sensitive_context' || observation.activity === 'dressing') {
    reasons.push('PRIVACY_RISK_PRESENT');
    return privacyDecision(reasons, '隐私暂停', '当前情境不适合观察或记录穿着。');
  }

  if (observation.identity === 'unresolved') {
    reasons.push('IDENTITY_UNRESOLVED');
    return observeDecision(reasons, '需要更多观察', '身份状态尚不可靠，暂不生成衣物候选。');
  }

  reasons.push('KNOWN_USER_PRESENT');

  if (observation.freshness === 'stale') {
    reasons.push('OBSERVATION_STALE');
    return observeDecision(reasons, '等待新画面', '当前观察已经过期。');
  }
  if (observation.freshness === 'unknown') {
    reasons.push('OBSERVATION_FRESHNESS_UNKNOWN');
    return observeDecision(reasons, '确认画面时效', '当前观察的时效尚不明确。');
  }
  if (observation.quality === 'unusable') {
    reasons.push('OBSERVATION_UNUSABLE');
    return observeDecision(reasons, '画面暂不可用', '当前画面不足以支持穿着或衣物判断。');
  }
  if (observation.quality === 'limited') {
    reasons.push('OBSERVATION_LIMITED');
    return observeDecision(reasons, '继续静默观察', '当前画面信息有限，不急于打扰用户。');
  }
  if (observation.coverage === 'none' || observation.coverage === 'head_shoulders') {
    reasons.push('INSUFFICIENT_FRAME_COVERAGE');
    return observeDecision(reasons, '等待更完整画面', '目前没有足够的衣物覆盖范围。');
  }
  if (
    observation.motion === 'high_motion' ||
    observation.activity === 'turning' ||
    observation.activity === 'moving'
  ) {
    reasons.push('HIGH_MOTION');
    return observeDecision(reasons, '等待画面稳定', '用户仍在移动，暂不形成衣物结论。');
  }

  if (observation.activeTask !== 'none') {
    reasons.push('ACTIVE_TASK_IN_PROGRESS');
    return deferDecision(reasons, '已有任务进行中', '先完成当前 Agent 任务，不插入新的衣物询问。');
  }

  if (!observation.userAvailableForInterruption) {
    reasons.push('USER_NOT_AVAILABLE_FOR_INTERRUPTION');
    return deferDecision(reasons, '暂不打扰', '用户当前不适合被询问。');
  }

  if (observation.garmentPresentation === 'none' || observation.garmentPresentation === 'unknown') {
    reasons.push('NO_GARMENT_SIGNAL');
    return decision('remain_silent', reasons);
  }

  if (observation.garmentPresentation === 'worn') reasons.push('GARMENT_WORN');
  if (
    observation.garmentPresentation === 'held' ||
    observation.garmentPresentation === 'worn_and_held'
  ) {
    reasons.push('GARMENT_HELD');
  }

  if (observation.closetMatch === 'not_checked') {
    reasons.push('CLOSET_NOT_CHECKED');
    return observeDecision(reasons, '等待衣橱匹配', '还没有可靠的衣橱匹配结果。');
  }
  if (observation.closetMatch === 'ambiguous') {
    reasons.push('CLOSET_MATCH_AMBIGUOUS');
    return observeDecision(reasons, '匹配仍不确定', '多个衣橱单品都可能匹配，暂不生成新候选。');
  }
  if (observation.closetMatch === 'matched') {
    reasons.push('CLOSET_ALREADY_MATCHED');
    return decision('remain_silent', reasons, {
      wearRecord: wearRecordEligibility(observation, episode, reasons),
    });
  }

  reasons.push('CLOSET_UNMATCHED');
  const ownership = observation.ownership === 'unknown'
    ? episode.ownership
    : observation.ownership;

  if (ownership === 'confirmed_not_user_owned') {
    reasons.push('OWNERSHIP_CONFIRMED_NOT_USER');
    return decision('remain_silent', reasons);
  }

  if (ownership === 'unknown') {
    reasons.push('OWNERSHIP_UNKNOWN');
    if (episode.ownershipQuestion === 'asked') {
      reasons.push('OWNERSHIP_ALREADY_REQUESTED');
      return deferDecision(reasons, '等待用户确认', '已经问过一次，不重复打扰。');
    }
    if (
      episode.status === 'stable' &&
      (observation.garmentPresentation === 'held' || observation.garmentPresentation === 'worn_and_held')
    ) {
      return {
        ...decision('ask_ownership', reasons),
        interruption: 'ask_once',
        presentation: {
          visibility: 'foreground',
          contentKind: 'garment_ingestion',
          title: '这件衣物需要确认归属',
          detail: '衣橱中没有可靠匹配；只有用户确认后，未来流程才可以继续。',
          tone: 'attention',
        },
      };
    }
    if (episode.status !== 'stable') reasons.push('EPISODE_NOT_STABLE');
    return observeDecision(reasons, '继续观察', '未匹配不等于用户拥有，暂不询问或生成候选。');
  }

  reasons.push('OWNERSHIP_CONFIRMED_USER');
  if (episode.status !== 'stable') {
    reasons.push('EPISODE_NOT_STABLE');
    return observeDecision(reasons, '等待稳定观察', '所有权已确认，但仍需要稳定画面。');
  }

  const wearRecord = wearRecordEligibility(observation, episode, reasons);
  const closetPersistence = persistenceEligibility(observation, reasons);
  return {
    action: 'candidate_ready',
    reasonCodes: reasons,
    interruption: 'none',
    needsMoreObservation: false,
    privacyPaused: false,
    eligibility: {
      wearRecord,
      garmentCandidate: 'eligible',
      closetPersistence,
    },
    presentation: {
      visibility: 'ambient',
      contentKind: 'garment_ingestion',
      title: '衣物候选条件已满足',
      detail: closetPersistence === 'eligible'
        ? '情境与授权均满足；本模拟器仍不会执行衣橱写入。'
        : '可以形成临时候选，但持久化仍需要明确授权。',
      tone: 'neutral',
    },
  };
}

function decision(
  action: MirrorSituationDecision['action'],
  reasonCodes: MirrorSituationReasonCode[],
  eligibility: Partial<MirrorSituationDecision['eligibility']> = {},
): MirrorSituationDecision {
  return {
    action,
    reasonCodes,
    interruption: 'none',
    needsMoreObservation: false,
    privacyPaused: false,
    eligibility: {
      wearRecord: 'prohibited',
      garmentCandidate: 'prohibited',
      closetPersistence: 'prohibited',
      ...eligibility,
    },
    presentation: { ...hiddenPresentation },
  };
}

function observeDecision(
  reasonCodes: MirrorSituationReasonCode[],
  title: string,
  detail: string,
): MirrorSituationDecision {
  return {
    ...decision('observe_more', reasonCodes),
    needsMoreObservation: true,
    presentation: {
      visibility: 'ambient',
      contentKind: 'device_feedback',
      title,
      detail,
      tone: 'neutral',
    },
  };
}

function deferDecision(
  reasonCodes: MirrorSituationReasonCode[],
  title: string,
  detail: string,
): MirrorSituationDecision {
  return {
    ...decision('defer', reasonCodes),
    interruption: 'defer',
    presentation: {
      visibility: 'ambient',
      contentKind: 'device_feedback',
      title,
      detail,
      tone: 'neutral',
    },
  };
}

function privacyDecision(
  reasonCodes: MirrorSituationReasonCode[],
  title: string,
  detail: string,
): MirrorSituationDecision {
  return {
    ...decision('privacy_pause', reasonCodes),
    privacyPaused: true,
    presentation: {
      visibility: 'foreground',
      contentKind: 'device_feedback',
      title,
      detail,
      tone: 'privacy',
    },
  };
}

function wearRecordEligibility(
  observation: MirrorSituationObservation,
  episode: OutfitEpisode,
  reasons: MirrorSituationReasonCode[],
): MirrorSituationDecision['eligibility']['wearRecord'] {
  if (episode.status !== 'stable') {
    reasons.push('EPISODE_NOT_STABLE');
    return 'prohibited';
  }
  if (observation.permissions.wearRecording === 'denied') {
    reasons.push('WEAR_RECORDING_PERMISSION_DENIED');
    return 'prohibited';
  }
  if (observation.permissions.wearRecording !== 'granted') {
    reasons.push('WEAR_RECORDING_PERMISSION_MISSING');
    return 'prohibited';
  }
  return observation.garmentPresentation === 'worn' || observation.garmentPresentation === 'worn_and_held'
    ? 'eligible'
    : 'prohibited';
}

function persistenceEligibility(
  observation: MirrorSituationObservation,
  reasons: MirrorSituationReasonCode[],
): MirrorSituationDecision['eligibility']['closetPersistence'] {
  if (observation.permissions.closetPersistence === 'denied') {
    reasons.push('CLOSET_PERSISTENCE_PERMISSION_DENIED');
    return 'prohibited';
  }
  if (observation.permissions.closetPersistence !== 'granted') {
    reasons.push('CLOSET_PERSISTENCE_REQUIRES_CONFIRMATION');
    return 'requires_user_confirmation';
  }
  return 'eligible';
}

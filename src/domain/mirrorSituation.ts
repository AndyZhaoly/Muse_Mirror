export type MirrorObservedIdentity =
  | 'no_person'
  | 'known_user'
  | 'unknown_person'
  | 'unresolved';

export type MirrorObservedActivity =
  | 'absent'
  | 'approaching'
  | 'stationary'
  | 'turning'
  | 'moving'
  | 'holding_garment'
  | 'dressing'
  | 'leaving'
  | 'unknown';

export type MirrorMotionState = 'still' | 'moving' | 'high_motion' | 'unknown';

export type MirrorGarmentPresentation =
  | 'none'
  | 'worn'
  | 'held'
  | 'worn_and_held'
  | 'unknown';

export type MirrorClosetMatch = 'not_checked' | 'matched' | 'unmatched' | 'ambiguous';

export type MirrorGarmentOwnership =
  | 'confirmed_user_owned'
  | 'confirmed_not_user_owned'
  | 'unknown';

export type MirrorFrameCoverage =
  | 'none'
  | 'head_shoulders'
  | 'upper_body'
  | 'three_quarter'
  | 'full_body'
  | 'garment_only';

export type MirrorObservationQuality = 'unusable' | 'limited' | 'good';
export type MirrorObservationFreshness = 'fresh' | 'stale' | 'unknown';

export type MirrorActiveTask =
  | 'none'
  | 'conversation'
  | 'visual_analysis'
  | 'closet_recommendation'
  | 'try_on'
  | 'garment_capture'
  | 'other';

export type MirrorPrivacyRisk =
  | 'none'
  | 'unknown_person'
  | 'multiple_people'
  | 'sensitive_context'
  | 'camera_disabled';

export type MirrorPermissionState = 'unknown' | 'granted' | 'denied';

export interface MirrorSituationObservation {
  observationId: string;
  observedAt: string;
  personCount: number;
  identity: MirrorObservedIdentity;
  activity: MirrorObservedActivity;
  motion: MirrorMotionState;
  garmentPresentation: MirrorGarmentPresentation;
  closetMatch: MirrorClosetMatch;
  ownership: MirrorGarmentOwnership;
  coverage: MirrorFrameCoverage;
  quality: MirrorObservationQuality;
  freshness: MirrorObservationFreshness;
  activeTask: MirrorActiveTask;
  privacyRisk: MirrorPrivacyRisk;
  userAvailableForInterruption: boolean;
  permissions: {
    wearRecording: MirrorPermissionState;
    closetPersistence: MirrorPermissionState;
  };
  confidence: {
    situation: number;
    garment: number;
    identity: number;
  };
}

export type MirrorSituationAction =
  | 'remain_silent'
  | 'observe_more'
  | 'defer'
  | 'ask_ownership'
  | 'privacy_pause'
  | 'candidate_ready';

export type MirrorSituationReasonCode =
  | 'NO_PERSON_PRESENT'
  | 'KNOWN_USER_PRESENT'
  | 'IDENTITY_UNRESOLVED'
  | 'UNKNOWN_PERSON_PRESENT'
  | 'MULTIPLE_PEOPLE_PRESENT'
  | 'PRIVACY_RISK_PRESENT'
  | 'CAMERA_DISABLED'
  | 'ACTIVE_TASK_IN_PROGRESS'
  | 'USER_NOT_AVAILABLE_FOR_INTERRUPTION'
  | 'OBSERVATION_STALE'
  | 'OBSERVATION_FRESHNESS_UNKNOWN'
  | 'OBSERVATION_UNUSABLE'
  | 'OBSERVATION_LIMITED'
  | 'INSUFFICIENT_FRAME_COVERAGE'
  | 'HIGH_MOTION'
  | 'EPISODE_NOT_STABLE'
  | 'NO_GARMENT_SIGNAL'
  | 'GARMENT_WORN'
  | 'GARMENT_HELD'
  | 'CLOSET_NOT_CHECKED'
  | 'CLOSET_ALREADY_MATCHED'
  | 'CLOSET_MATCH_AMBIGUOUS'
  | 'CLOSET_UNMATCHED'
  | 'OWNERSHIP_UNKNOWN'
  | 'OWNERSHIP_CONFIRMED_USER'
  | 'OWNERSHIP_CONFIRMED_NOT_USER'
  | 'OWNERSHIP_ALREADY_REQUESTED'
  | 'WEAR_RECORDING_PERMISSION_MISSING'
  | 'WEAR_RECORDING_PERMISSION_DENIED'
  | 'CLOSET_PERSISTENCE_REQUIRES_CONFIRMATION'
  | 'CLOSET_PERSISTENCE_PERMISSION_DENIED';

export type MirrorPolicyEligibility = 'prohibited' | 'eligible';
export type MirrorPersistenceEligibility =
  | 'prohibited'
  | 'requires_user_confirmation'
  | 'eligible';

export interface MirrorSituationPresentationHint {
  visibility: 'hidden' | 'ambient' | 'foreground';
  contentKind: 'device_feedback' | 'garment_ingestion';
  title: string;
  detail: string;
  tone: 'neutral' | 'attention' | 'privacy';
}

export interface MirrorSituationDecision {
  action: MirrorSituationAction;
  reasonCodes: MirrorSituationReasonCode[];
  interruption: 'none' | 'defer' | 'ask_once';
  needsMoreObservation: boolean;
  privacyPaused: boolean;
  eligibility: {
    wearRecord: MirrorPolicyEligibility;
    garmentCandidate: MirrorPolicyEligibility;
    closetPersistence: MirrorPersistenceEligibility;
  };
  presentation: MirrorSituationPresentationHint;
}

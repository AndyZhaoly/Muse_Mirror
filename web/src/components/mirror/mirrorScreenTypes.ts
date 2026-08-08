import type { AgentActivity, AgentArtifact } from '../../agentClient.js';
import type { VoiceSessionState } from '../../voice/voiceTypes.js';
import type { MirrorSituationDecision } from '../../../../src/domain/mirrorSituation.js';
import type {
  AmbientCaptureClosetEntry,
  AmbientCaptureCompletedEvent,
  AmbientCaptureOutcome,
} from '../../agentClient.js';

export type MirrorInteractionPhase =
  | 'idle'
  | 'listening'
  | 'recognizing'
  | 'thinking'
  | 'showing_result'
  | 'speaking'
  | 'awaiting_approval'
  | 'error';

export type MirrorContentKind =
  | 'conversation'
  | 'closet'
  | 'recommendation'
  | 'look_board'
  | 'try_on'
  | 'visual'
  | 'products'
  | 'information'
  | 'device_feedback'
  | 'garment_ingestion';

export type MirrorScreenOwner =
  | 'blocking_interaction'
  | 'explicit_task'
  | 'wardrobe_moment'
  | 'idle';

export interface WardrobeMomentItem {
  id: string;
  slot: AmbientCaptureCompletedEvent['itemSummaries'][number]['slot'];
  label: string;
  status: 'new' | 'recognized' | 'pending';
  imageState: 'processing' | 'ready' | 'fallback' | 'pending';
  imageUrl?: string;
}

export interface WardrobeMoment {
  eventId: string;
  captureId: string;
  episodeId: string;
  ownerUserId: string;
  headline: string;
  summary: string;
  supportingText?: string;
  items: WardrobeMomentItem[];
  updatedAt: string;
}

export interface MirrorPrimaryArtifact {
  ownerMessageId: string;
  artifactType: string;
  contentKind: MirrorContentKind;
  summary: string;
  artifact: AgentArtifact;
}

export interface MirrorVoicePresentation {
  enabled: boolean;
  state: VoiceSessionState;
  partialTranscript?: string;
  error?: string;
  statusLabel?: string;
}

export interface MirrorScreenState {
  screenOwner: MirrorScreenOwner;
  phase: MirrorInteractionPhase;
  contentKind: MirrorContentKind;
  priority: number;
  ownerMessageId?: string;
  ambient: {
    agentStatusLabel: string;
    perceptionLabel: string;
  };
  caption: {
    latestUserText?: string;
    museText?: string;
    museTextSource?: 'answer' | 'commentary' | 'idle_fallback';
    activityLabel?: string;
    showTyping: boolean;
  };
  voice: MirrorVoicePresentation;
  primaryArtifact?: MirrorPrimaryArtifact;
  showApproval: boolean;
  isActiveTurn: boolean;
  situationDecision?: MirrorSituationDecision;
  wardrobeMoment?: WardrobeMoment;
  ambientCaptureEvent?: AmbientCaptureCompletedEvent;
  ambientCaptureStatus?: AmbientCaptureOutcome['status'];
  ambientClosetItems: AmbientCaptureClosetEntry[];
  ambientProductImageProviderReady: boolean;
  ambientProductImageBackfillPending: boolean;
}

export interface MirrorScreenMessage {
  id: string;
  role: 'assistant' | 'user';
  text?: string;
  commentary?: string;
  isTyping?: boolean;
  artifacts?: AgentArtifact[];
  activity?: AgentActivity[];
}

export interface MirrorScreenControllerInput {
  messages: readonly MirrorScreenMessage[];
  activeAssistantId?: string | null;
  responding: boolean;
  generating: boolean;
  liveActivity: readonly AgentActivity[];
  hasPendingApproval: boolean;
  voice: {
    enabled: boolean;
    state: VoiceSessionState;
    partialTranscript?: string;
    error?: string;
  };
  agentStatusLabel: string;
  perceptionLabel: string;
  situationDecision?: MirrorSituationDecision;
  ambientCaptureEvent?: AmbientCaptureCompletedEvent;
  ambientCaptureStatus?: AmbientCaptureOutcome['status'];
  ambientClosetItems?: AmbientCaptureClosetEntry[];
  ambientProductImageProviderReady?: boolean;
  ambientProductImageBackfillPending?: boolean;
  foregroundVisualTask?: boolean;
}

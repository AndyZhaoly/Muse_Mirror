export type AgentArtifact =
  | {
      type: 'item_grid';
      id: string;
      title: string;
      items: Array<{
        id: string;
        name: string;
        imageUrl: string;
        source: 'closet';
      }>;
    }
  | {
      type: 'product_cards';
      id: string;
      title: string;
      products: Array<{
        id: string;
        title: string;
        brand: string;
        price: number;
        currency: string;
        color: string;
        category: string;
        imageUrl: string;
        productUrl: string;
        source: string;
      }>;
    }
  | {
      type: 'image';
      id: string;
      label: string;
      source: 'ai_outfit_visual' | 'ai_try_on';
      url: string;
      mimeType: string;
      aiGenerated: true;
      disclaimer: string;
      visualVersionId?: string;
      visualSessionId?: string;
      previewScope?: 'upper_body' | 'full_body' | 'concept' | 'neckline_preview' | 'upper_body_faithful' | 'full_body_synthetic';
      tryOnMetadata?: {
        previewScope: 'upper_body' | 'full_body' | 'concept' | 'neckline_preview' | 'upper_body_faithful' | 'full_body_synthetic';
        sourceImageId: string;
        sourceCoverage: 'face_only' | 'head_shoulders' | 'upper_body' | 'three_quarter' | 'full_body';
        outfitSnapshotId: string;
        visibleItemRefs: string[];
        notVisualizedItemRefs: string[];
        syntheticRegions: string[];
        verificationStatus: 'passed' | 'limited' | 'failed';
        limitations: string[];
        promptVersion: string;
        model: string;
      };
      temporary?: boolean;
      partial?: boolean;
	      parentVersionId?: string;
	      operation?: 'outfit_visual' | 'try_on' | 'edit';
	      referenceItems?: Array<{
	        id: string;
	        name: string;
	        category: string;
	        color?: string;
	        imageUrl?: string;
	        source: 'closet' | 'concept';
      }>;
	    }
  | {
      type: 'item_visual';
      id: string;
      source: 'closet' | 'product' | 'concept';
      imageUrl: string;
      imageId?: string;
      mimeType?: string;
      label: string;
      category: string;
      color?: string;
      badge: '你的衣柜' | '真实商品' | 'AI 概念单品';
      aiGenerated?: boolean;
      disclaimer?: string;
      conceptItemAssetId?: string;
    }
  | {
      type: 'item_collection';
      id: string;
      title: string;
      source: 'concept';
      items: Array<{
        id: string;
        imageUrl: string;
        imageId?: string;
        label: string;
        category: string;
        color?: string;
        badge: 'AI 概念单品';
        conceptItemAssetId: string;
        aiGenerated: true;
        disclaimer: string;
      }>;
    }
  | {
      type: 'look_board';
      id: string;
      boardStyle: 'business_casual' | 'minimal_editorial' | 'clean_merch';
      title: string;
      subtitle?: string;
      dateLabel?: string;
      hero: {
        imageUrl: string;
        imageId: string;
        mimeType: string;
        subject: 'anonymous_model' | 'user';
        framing: 'upper_body' | 'three_quarter' | 'full_body';
        facePolicy: 'exclude' | 'preserve';
      };
      items: Array<{
        slot: 'top' | 'bottom' | 'outerwear' | 'shoes' | 'bag' | 'accessory';
        source: 'closet' | 'product' | 'concept';
        closetItemId?: string;
        productId?: string;
        conceptItemAssetId?: string;
        imageUrl: string;
        label: string;
        category: string;
        color?: string;
        badge: '你的衣柜' | '真实商品' | 'AI 概念单品';
        required: boolean;
      }>;
      disclaimer: string;
      aiGenerated: true;
      visualVersionId?: string;
      visualSessionId?: string;
      parentVersionId?: string;
      operation?: 'outfit_visual' | 'try_on' | 'edit';
      layoutVersion: string;
    }
  | {
      type: 'notice';
      id: string;
      level: 'info' | 'warning' | 'error';
      text: string;
    };

import type { ClosetItem } from '../../src/types.js';

export interface AgentActivity {
  id: string;
  type:
    | 'perception.started'
    | 'perception.completed'
    | 'perception.failed'
    | 'weather.started'
    | 'weather.completed'
    | 'weather.failed'
    | 'wardrobe.started'
    | 'wardrobe.completed'
    | 'wardrobe.failed'
    | 'strategy.started'
    | 'strategy.completed'
    | 'strategy.failed'
    | 'synthesis.started'
    | 'synthesis.completed'
    | 'synthesis.failed'
    | 'generation.started'
    | 'generation.completed'
    | 'generation.failed'
    | 'tool.started'
    | 'tool.completed'
    | 'tool.failed'
    | 'state.updated'
    | 'policy.warning'
    | 'turn.cancelled';
  turnId: string;
  timestamp: number;
  status: 'started' | 'completed' | 'failed' | 'cancelled';
  detail?: Record<string, unknown>;
  label?: string;
  displayDetail?: string;
  toolName?: string;
  elapsedMs?: number;
}

export interface PerceptionState {
  cameraActive: boolean;
  latestFrameId?: string;
  frameCapturedAt?: number;
  frameReceivedAt?: number;
  observationId?: string;
  sourceFrameId?: string;
  analyzedAt?: number;
  expiresAt?: number;
  status:
    | 'no_camera'
    | 'preview_only'
    | 'frame_received'
    | 'analyzing'
    | 'observed'
    | 'unclear'
    | 'failed';
  visibleRegion?: 'upper_body' | 'full_body' | 'partial';
  confidence?: number;
  summary?: string;
  failureReason?: string;
}

export interface AgentGrounding {
  perceptionObservationIds: string[];
  closetItemIds?: string[];
  productIds?: string[];
  closetRecommendationIds?: string[];
  selectedLookCandidateIds?: string[];
  stylingProfileSnapshotId?: string;
}

export interface MuseDecisionSummary {
  checked: string[];
  constraintsApplied: string[];
  keyTradeoffs: string[];
  conclusion: string;
  uncertainties: string[];
}

export type PresentationPreference =
  | 'masculine'
  | 'androgynous'
  | 'feminine'
  | 'fluid'
  | 'unrestricted'
  | 'unknown';

export type PresentationOpenness =
  | 'strict'
  | 'slightly_open'
  | 'open'
  | 'unrestricted';

export type StyleTone =
  | 'crisp'
  | 'soft'
  | 'relaxed'
  | 'minimal'
  | 'dramatic';

export type RecommendationScope =
  | 'neutral_core'
  | 'menswear_inclusive'
  | 'womenswear_inclusive'
  | 'all';

export type ExpressionIntensity =
  | 'restrained'
  | 'balanced'
  | 'bold';

export type PreferenceMemoryScope =
  | 'turn'
  | 'session'
  | 'persistent';

export type OverrideScope = 'turn' | 'task' | 'conversation';

export type MemoryStatus =
  | 'active'
  | 'paused'
  | 'superseded'
  | 'expired'
  | 'deleted';

export type MemoryValue =
  | {
      namespace: 'avoidance';
      key: 'garment_category' | 'neckline' | 'shoe_type' | 'color' | 'cut';
      values: string[];
      strength: 'soft' | 'hard';
    }
  | {
      namespace: 'style_preference';
      key: 'style_tone' | 'recommendation_scope' | 'expression_intensity';
      values: string[];
      preferenceStrength: 'weak' | 'medium' | 'strong';
    }
  | {
      namespace: 'fit_preference';
      key: 'fit' | 'comfort';
      values: string[];
      preferenceStrength: 'weak' | 'medium' | 'strong';
    }
  | {
      namespace: 'communication_preference';
      key: 'answer_style';
      values: string[];
    };

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  status: 'active' | 'archived' | 'deleted' | 'temporary';
  temporary?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  userId: string;
  role: 'user' | 'assistant' | 'tool';
  content: unknown;
  createdAt: string;
}

export interface UserMemory {
  id: string;
  userId: string;
  value: MemoryValue;
  status: MemoryStatus;
  explicitness: 'user_requested' | 'user_stated' | 'inferred';
  authorization: 'explicit' | 'implicit_durable_statement';
  confidence: number;
  validFrom?: string;
  validUntil?: string;
  source:
    | { type: 'conversation'; conversationId: string; messageId: string }
    | { type: 'settings'; settingsVersion: string }
    | { type: 'migration'; migrationId: string; legacyField: string }
    | { type: 'deleted_conversation'; originalSourceDeletedAt: string };
  supersedesMemoryId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExplicitPreferenceEvent {
  id: string;
  userId: string;
  conversationId: string;
  messageId: string;
  intent: {
    durabilityIntent: OverrideScope | 'persistent';
    memoryAuthorization: 'explicit' | 'implicit_durable_statement' | 'none' | 'explicitly_denied';
    value: MemoryValue;
    confidence: number;
  };
  status: 'captured' | 'applied' | 'needs_confirmation' | 'dismissed' | 'forbidden';
  createdAt: string;
}

export interface MemoryPolicy {
  usePersistentMemories: boolean;
  referencePastChats: boolean;
  allowExplicitMemoryWrites: boolean;
}

export interface MemoryUsageDisclosure {
  label: string;
  reason: string;
  editable: boolean;
}

export type PreferenceUiEvent =
  | {
      type: 'set_recommendation_scope';
      scope: RecommendationScope;
      persistence: OverrideScope | 'persistent';
    }
  | {
      type: 'set_expression_intensity';
      intensity: ExpressionIntensity;
      persistence: OverrideScope | 'persistent';
    }
  | {
      type: 'set_style_tone';
      tone: StyleTone;
      persistence: OverrideScope | 'persistent';
    };

export interface StylingProfile {
  presentationPreference: PresentationPreference;
  presentationOpenness: PresentationOpenness;
  recommendationScope?: RecommendationScope;
  expressionIntensity?: ExpressionIntensity;
  preferenceMemoryScope?: PreferenceMemoryScope;
  styleTone?: StyleTone;
  fitPreference?: 'fitted' | 'regular' | 'relaxed' | 'oversized';
  source: 'explicit_user' | 'demo_preset' | 'session_override' | 'unknown';
  updatedAt?: string;
}

export interface TurnPermissions {
  allowVisualAnalysis: boolean;
  allowAiImageGeneration: boolean;
  allowPhotoUseForTryOn: boolean;
  allowPersistentMemory: boolean;
}

export interface ApprovalRequest {
  index: number;
  reason: string;
  faceMode?: 'include' | 'conceal';
}

export type AgentTurnResult =
  | {
      status: 'completed';
      text: string;
      spokenText?: string;
      telemetry?: TurnLatencyTelemetry;
      artifacts: AgentArtifact[];
      activity: AgentActivity[];
      grounding?: AgentGrounding;
      decisionSummary?: MuseDecisionSummary;
      state: {
        activeOutfitId?: string;
        lastGeneratedImageId?: string;
        currentUserImageId?: string;
        perception?: PerceptionState;
        stylingProfile?: StylingProfile;
        grounding?: AgentGrounding;
        visualSession?: {
          activePersonImageId?: string;
          activeOutfitSnapshotId?: string;
          currentArtifactId?: string;
          currentVersionId?: string;
          tryOnSessionId?: string;
          photoGrantId?: string;
        };
        memoryUsage?: MemoryUsageDisclosure[];
        pendingMemoryCandidates?: ExplicitPreferenceEvent[];
      };
    }
  | {
      status: 'approval_required';
      approvals: ApprovalRequest[];
      resumeToken: string;
      artifacts: AgentArtifact[];
      activity: AgentActivity[];
    };

export interface TurnRequest {
  sessionId: string;
  userId: string;
  inputSource?: 'text' | 'voice';
  traceId?: string;
  conversationId?: string;
  temporary?: boolean;
  message: string;
  locale?: string;
  cameraLocalActive?: boolean;
  capturedImageDataUrl?: string | null;
  memoryPolicy?: Partial<MemoryPolicy>;
  preferenceUiEvents?: PreferenceUiEvent[];
  stylingProfileOverride?: {
    presentationPreference?: PresentationPreference;
    presentationOpenness?: PresentationOpenness;
    recommendationScope?: RecommendationScope;
    expressionIntensity?: ExpressionIntensity;
    preferenceMemoryScope?: PreferenceMemoryScope;
    styleTone?: StyleTone;
    scope: PreferenceMemoryScope;
  };
  permissions: Partial<TurnPermissions>;
}

export interface TurnLatencyTelemetry {
  traceId: string;
  turnId: string;
  interactionMode: 'text' | 'voice';
  timings: Partial<Record<
    | 'speech_end'
    | 'asr_final'
    | 'turn_submitted'
    | 'turn_started'
    | 'model_round_started'
    | 'first_model_stream_event'
    | 'tool_started'
    | 'tool_completed'
    | 'first_final_answer_delta'
    | 'final_result_ready'
    | 'tts_requested'
    | 'first_tts_audio_chunk'
    | 'playback_completed',
    number
  >>;
  modelRounds: number;
  usedVision: boolean;
  textChars: number;
  spokenChars: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export interface ResumeRequest {
  sessionId: string;
  userId: string;
  resumeToken: string;
	  decisions: Array<{
	    index: number;
	    approved: boolean;
	    rejectionMessage?: string;
	    faceMode?: 'include' | 'conceal';
	  }>;
  permissions: Partial<TurnPermissions>;
}

export interface AgentStatus {
  ok: boolean;
  runtime?: string;
  provider: 'openai' | 'gemma4';
  model: string;
  mockTools: boolean;
  visionProvider?: string;
  visionModel?: string;
  quickVisionModel?: string;
  deepVisionModel?: string;
  mirrorFrameIntervalMs?: number;
  closetDataPath?: string;
  closetPresentationMetadataPath?: string;
  agentReady: boolean;
  reasoning?: {
    text: 'minimal' | 'low' | 'medium' | 'high';
    voiceConfigured: 'minimal' | 'low' | 'medium' | 'high';
    voiceResolved: 'minimal' | 'low' | 'medium' | 'high';
  };
  capabilities?: {
    runtime: string;
    brain: {
      provider: string;
      model?: string;
      configured: boolean;
      verified: boolean;
      ready: boolean;
      lastCheckedAt?: string;
      errorCode?: string;
    };
    vision: {
      provider: string;
      model?: string;
      configured: boolean;
      verified: boolean;
      ready: boolean;
      lastCheckedAt?: string;
      errorCode?: string;
    };
    imageToolHost: {
      provider: string;
      model?: string;
      configured: boolean;
      verified: boolean;
      ready: boolean;
      lastCheckedAt?: string;
      errorCode?: string;
    };
    image: {
      provider: string;
      model?: string;
      configured: boolean;
      verified: boolean;
      generationReady: boolean;
      editReady: boolean;
      tryOnAdapterReady: boolean;
      lastCheckedAt?: string;
      errorCode?: string;
    };
    weather: {
      provider: string;
      configured: boolean;
      verified: boolean;
      ready: boolean;
      lastCheckedAt?: string;
      errorCode?: string;
    };
    products: {
      provider: string;
      configured: boolean;
      verified: boolean;
      ready: boolean;
      lastCheckedAt?: string;
      errorCode?: string;
    };
  };
  ambientCapture?: {
    observationProviderReady: boolean;
    identityVerifierReady: boolean;
    identityTopK: number;
    productImageProvider: string;
    productImageModel: string;
    productImageProviderReady: boolean;
    productImageVerifierReady: boolean;
    emptyScene?: {
      threshold: number;
      confirmations: number;
      forceProbeMs: number;
    };
  };
  transport: string;
  message?: string;
}

export interface MirrorFrameRequest {
  sessionId: string;
  userId: string;
  cameraLocalActive?: boolean;
  capturedImageDataUrl?: string | null;
  permissions: Partial<TurnPermissions>;
}

export interface MirrorFrameResult {
  ok: true;
  cachedAt?: string;
  status: 'accepted' | 'updated' | 'skipped';
  perception?: PerceptionState;
}

export interface AmbientCaptureCompletedEvent {
  eventId: string;
  type: 'outfit_capture_completed';
  userId: string;
  sessionId: string;
  captureId: string;
  episodeId: string;
  newItemIds: string[];
  recognizedItemIds: string[];
  itemSummaries: Array<{
    closetItemId: string;
    slot: 'top' | 'bottom' | 'dress' | 'outerwear' | 'shoes' | 'bag' | 'accessory';
    label: string;
    status: 'new' | 'recognized';
    imageUrl?: string;
    imageStatus?: 'processing' | 'ready' | 'needs_review' | 'failed';
  }>;
  repeatedOutfit: boolean;
  committedAt: string;
  acknowledgedAt?: string;
}

export interface AmbientCaptureOutcome {
  status:
    | 'disabled'
    | 'observing'
    | 'deferred'
    | 'privacy_paused'
    | 'insufficient_evidence'
    | 'ambiguous'
    | 'committed'
    | 'committed_processing_images'
    | 'ready'
    | 'recognized'
    | 'mixed'
    | 'mixed_ready'
    | 'image_needs_review'
    | 'already_committed'
    | 'episode_ended'
    | 'unavailable';
  reasonCodes: string[];
  episodeId?: string;
  observationId?: string;
  retryAfterMs?: number;
  completedEvent?: AmbientCaptureCompletedEvent;
}

export interface AmbientCaptureState {
  grant?: { grantedAt: string; revokedAt?: string };
  closetItems: Array<{ item: ClosetItem; status: 'active' | 'archived' }>;
  captures: Array<{ captureId: string; repeatedOutfit: boolean; capturedAt: string }>;
  wearEvents: Array<{ wearEventId: string; closetItemId: string; wornAt: string }>;
  pendingCompletionEvent?: AmbientCaptureCompletedEvent;
  imageJobs?: Array<{ jobId: string; closetItemId: string; status: string; failureCode?: string; updatedAt: string }>;
  diagnostics: {
    enabled: boolean;
    providerReady: boolean;
    identityVerifierReady: boolean;
    productImageProviderReady: boolean;
    productImageVerifierReady: boolean;
    grantActive: boolean;
    closetItemCount: number;
    captureCount: number;
    wearEventCount: number;
    processingImageCount: number;
    needsReviewImageCount: number;
    lastOutcome?: AmbientCaptureOutcome;
  };
}

export type AmbientCaptureClosetEntry = AmbientCaptureState['closetItems'][number];

export interface AmbientProductImageBackfillResult {
  attemptedItemIds: string[];
  readyItemIds: string[];
  needsReviewItemIds: string[];
  skippedItemIds: string[];
}

export async function getAgentStatus(): Promise<AgentStatus> {
  const response = await fetch('/api/fashion/status');
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Status check failed with HTTP ${response.status}`);
  }
  return body as AgentStatus;
}

export async function listConversations(userId: string): Promise<Conversation[]> {
  const response = await fetch(`/api/conversations?userId=${encodeURIComponent(userId)}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Conversation list failed with HTTP ${response.status}`);
  return Array.isArray(body.conversations) ? body.conversations : [];
}

export function createConversation(input: { userId: string; title?: string; temporary?: boolean }): Promise<{ conversation: Conversation }> {
  return postJson<{ conversation: Conversation }>('/api/conversations', input);
}

export async function getConversationMessages(userId: string, conversationId: string): Promise<ConversationMessage[]> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/messages?userId=${encodeURIComponent(userId)}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Conversation messages failed with HTTP ${response.status}`);
  return Array.isArray(body.messages) ? body.messages : [];
}

export function deleteConversation(input: { userId: string; conversationId: string; memoryAction: 'keep' | 'delete' }): Promise<{ deleted: boolean; affectedMemoryCount: number }> {
  return fetch(`/api/conversations/${encodeURIComponent(input.conversationId)}?userId=${encodeURIComponent(input.userId)}&memoryAction=${input.memoryAction}`, {
    method: 'DELETE',
  }).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Delete conversation failed with HTTP ${response.status}`);
    return body as { deleted: boolean; affectedMemoryCount: number };
  });
}

export async function listMemories(userId: string): Promise<UserMemory[]> {
  const response = await fetch(`/api/memories?userId=${encodeURIComponent(userId)}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Memory list failed with HTTP ${response.status}`);
  return Array.isArray(body.memories) ? body.memories : [];
}

export function patchMemory(input: { userId: string; memoryId: string; patch: Partial<UserMemory> }): Promise<{ memory: UserMemory }> {
  return fetch(`/api/memories/${encodeURIComponent(input.memoryId)}?userId=${encodeURIComponent(input.userId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input.patch),
  }).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Patch memory failed with HTTP ${response.status}`);
    return body as { memory: UserMemory };
  });
}

export function deleteMemory(input: { userId: string; memoryId: string }): Promise<{ memory: UserMemory }> {
  return fetch(`/api/memories/${encodeURIComponent(input.memoryId)}?userId=${encodeURIComponent(input.userId)}`, {
    method: 'DELETE',
  }).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Delete memory failed with HTTP ${response.status}`);
    return body as { memory: UserMemory };
  });
}

export function setMemoryPaused(input: { userId: string; memoryId: string; paused: boolean }): Promise<{ memory: UserMemory }> {
  const action = input.paused ? 'pause' : 'restore';
  return postJson<{ memory: UserMemory }>(`/api/memories/${encodeURIComponent(input.memoryId)}/${action}?userId=${encodeURIComponent(input.userId)}`, {});
}

export async function listMemoryCandidates(userId: string): Promise<ExplicitPreferenceEvent[]> {
  const response = await fetch(`/api/memory-candidates?userId=${encodeURIComponent(userId)}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Memory candidates failed with HTTP ${response.status}`);
  return Array.isArray(body.candidates) ? body.candidates : [];
}

export function confirmMemoryCandidate(input: { userId: string; candidateId: string }): Promise<{ event: ExplicitPreferenceEvent; memory: UserMemory }> {
  return postJson<{ event: ExplicitPreferenceEvent; memory: UserMemory }>(`/api/memory-candidates/${encodeURIComponent(input.candidateId)}/confirm?userId=${encodeURIComponent(input.userId)}`, {});
}

export function dismissMemoryCandidate(input: { userId: string; candidateId: string }): Promise<{ event: ExplicitPreferenceEvent }> {
  return postJson<{ event: ExplicitPreferenceEvent }>(`/api/memory-candidates/${encodeURIComponent(input.candidateId)}/dismiss?userId=${encodeURIComponent(input.userId)}`, {});
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof body?.error === 'string'
        ? body.error
        : `Request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

function normalizeAgentTurnResult(result: any): AgentTurnResult {
  if (result?.status === 'approval_required') {
    const { serializedRunState, ...rest } = result;
    return { ...rest, resumeToken: serializedRunState } as AgentTurnResult;
  }
  return result as AgentTurnResult;
}

export function runAgentTurn(input: TurnRequest): Promise<AgentTurnResult> {
  return postJson<any>('/api/fashion/turn', input).then(normalizeAgentTurnResult);
}

export function sendMirrorFrame(input: MirrorFrameRequest): Promise<MirrorFrameResult> {
  return postJson<MirrorFrameResult>('/api/fashion/mirror/frame', input);
}

export async function getAmbientCaptureState(_userId?: string): Promise<AmbientCaptureState> {
  const response = await fetch('/api/ambient-capture/state');
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `Ambient capture state failed with HTTP ${response.status}`);
  return body as AmbientCaptureState;
}

export function setAmbientCaptureGrant(input: { userId: string; enabled: boolean }): Promise<{ ok: true; enabled: boolean }> {
  return postJson('/api/ambient-capture/grant', { enabled: input.enabled });
}

export function sendAmbientCaptureFrame(input: {
  userId: string;
  sessionId: string;
  frameId: string;
  capturedAt: string;
  capturedImageDataUrl: string;
  activeTask: boolean;
  stability: {
    score: number;
    stableSamples: number;
    sampleIntervalMs: number;
    sourceWidth: number;
    sourceHeight: number;
  };
}): Promise<{ ok: true; outcome: AmbientCaptureOutcome }> {
  const { userId: _ignored, ...serverBoundInput } = input;
  return postJson('/api/ambient-capture/frame', serverBoundInput);
}

export function endAmbientCaptureEpisode(input: { userId: string; sessionId: string }): Promise<{ ok: true; outcome: AmbientCaptureOutcome }> {
  return postJson('/api/ambient-capture/episode/end', { sessionId: input.sessionId });
}

export function resetAmbientCapture(userId: string): Promise<{ ok: true }> {
  void userId;
  return postJson('/api/ambient-capture/debug/reset', {});
}

export function acknowledgeAmbientCapture(): Promise<{ ok: true; acknowledged: boolean }> {
  return postJson('/api/fashion/outfit-capture/acknowledge', {});
}

export function retryAmbientProductImage(closetItemId: string): Promise<{ ok: true; outcome: AmbientCaptureOutcome }> {
  return postJson('/api/dev/outfit-capture/retry-product-image', { closetItemId });
}

export function backfillAmbientProductImages(): Promise<{ ok: true; result: AmbientProductImageBackfillResult }> {
  return postJson('/api/ambient-capture/product-images/backfill', {});
}

export async function getPerceptionStatus(sessionId: string): Promise<PerceptionState> {
  const response = await fetch(`/api/fashion/perception/status?sessionId=${encodeURIComponent(sessionId)}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Perception status check failed with HTTP ${response.status}`);
  }
  return body.perception as PerceptionState;
}

export async function runAgentTurnStream(
  input: TurnRequest,
  onActivity: (activity: AgentActivity) => void,
  onDelta?: (text: string) => void,
  onArtifact?: (artifact: AgentArtifact) => void,
  onCommentary?: (text: string) => void,
): Promise<AgentTurnResult> {
  const response = await fetch('/api/fashion/turn/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message =
      typeof body?.error === 'string'
        ? body.error
        : `Request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  if (!response.body) {
    return runAgentTurn(input);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult: AgentTurnResult | undefined;

  const processBlock = (block: string) => {
    const lines = block.split(/\r?\n/);
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
    }
    if (!dataLines.length) return;
    const data = JSON.parse(dataLines.join('\n'));
    if (event === 'activity') {
      onActivity(data as AgentActivity);
      return;
    }
    if (event === 'delta') {
      if (typeof data?.text === 'string') onDelta?.(data.text);
      return;
    }
    if (event === 'commentary') {
      if (typeof data?.text === 'string') onCommentary?.(data.text);
      return;
    }
    if (event === 'artifact') {
      onArtifact?.(data as AgentArtifact);
      return;
    }
    if (event === 'result') {
      finalResult = normalizeAgentTurnResult(data);
      return;
    }
    if (event === 'error') {
      throw new Error(typeof data?.error === 'string' ? data.error : 'Streaming request failed.');
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (block) processBlock(block);
      boundary = buffer.indexOf('\n\n');
    }
    if (done) break;
  }
  if (buffer.trim()) processBlock(buffer.trim());
  if (!finalResult) throw new Error('Streaming request ended without a result.');
  return finalResult;
}

export function resumeAgentTurn(input: ResumeRequest): Promise<AgentTurnResult> {
  const { resumeToken, ...rest } = input;
  return postJson<any>('/api/fashion/resume', {
    ...rest,
    serializedRunState: resumeToken,
  }).then((result) => {
    if (result?.status === 'approval_required') {
      const { serializedRunState, ...resultRest } = result;
      return { ...resultRest, resumeToken: serializedRunState } as AgentTurnResult;
    }
    return result as AgentTurnResult;
  });
}

import type { ClosetItem } from '../types.js';

export type AmbientGarmentSlot =
  | 'top'
  | 'bottom'
  | 'dress'
  | 'outerwear'
  | 'shoes'
  | 'bag'
  | 'accessory';

export interface NormalizedBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AmbientCaptureGrant {
  userId: string;
  consentVersion: 'ambient-worn-garments-v1';
  autoRecordWornGarments: true;
  grantedAt: string;
  revokedAt?: string;
}

export interface LocalFrameStability {
  score: number;
  stableSamples: number;
  sampleIntervalMs: number;
  sourceWidth: number;
  sourceHeight: number;
}

export interface AmbientCapturePacket {
  packetId: string;
  userId: string;
  sessionId: string;
  frameId: string;
  capturedAt: string;
  imagePath: string;
  imageMimeType: string;
  stability: LocalFrameStability;
  activeTask: boolean;
}

export interface WornGarmentObservation {
  observationItemId: string;
  slot: AmbientGarmentSlot;
  category: ClosetItem['category'];
  description: string;
  dominantColor: string;
  secondaryColors: string[];
  pattern: string;
  silhouette: string;
  fit: string;
  distinctiveFeatures: string[];
  boundingBox: NormalizedBoundingBox;
  confidence: number;
  uncertainties: string[];
}

export interface WornOutfitObservation {
  observationId: string;
  provider: string;
  model: string;
  analyzedAt: string;
  personCount: number;
  coverage: 'none' | 'head_shoulders' | 'upper_body' | 'three_quarter' | 'full_body';
  quality: 'unusable' | 'limited' | 'good';
  garments: WornGarmentObservation[];
  uncertainties: string[];
}

export type GarmentIdentityStatus =
  | 'matched_existing'
  | 'new_to_closet'
  | 'ambiguous'
  | 'insufficient_evidence';

export interface GarmentAppearanceDescriptor {
  slot: AmbientGarmentSlot;
  category: ClosetItem['category'];
  dominantColor: string;
  secondaryColors: string[];
  pattern: string;
  silhouette: string;
  fit: string;
  distinctiveFeatures: string[];
}

export interface GarmentAppearance {
  appearanceId: string;
  userId: string;
  closetItemId: string;
  observationId: string;
  captureId: string;
  descriptor: GarmentAppearanceDescriptor;
  appearanceFingerprint: string;
  evidenceImageUrl: string;
  boundingBox: NormalizedBoundingBox;
  confidence: number;
  capturedAt: string;
}

export interface AmbientClosetItem {
  item: ClosetItem;
  status: 'provisional' | 'confirmed';
  source: 'ambient_capture';
  appearanceFingerprint: string;
  createdAt: string;
  updatedAt: string;
}

export interface GarmentIdentityHypothesis {
  observationItemId: string;
  status: GarmentIdentityStatus;
  matchedClosetItemId?: string;
  appearanceFingerprint: string;
  confidence: number;
  candidateItemIds: string[];
  reasonCodes: string[];
}

export interface OutfitCapture {
  captureId: string;
  userId: string;
  sessionId: string;
  episodeId: string;
  observationId: string;
  closetItemIds: string[];
  outfitSignature: string;
  repeatedOutfit: boolean;
  evidenceImageUrl: string;
  capturedAt: string;
  committedAt: string;
}

export interface WearEvent {
  wearEventId: string;
  userId: string;
  closetItemId: string;
  captureId: string;
  episodeId: string;
  wornAt: string;
}

export interface AmbientGarmentTrack {
  trackId: string;
  slot: AmbientGarmentSlot;
  category: ClosetItem['category'];
  appearanceFingerprint: string;
  descriptor: GarmentAppearanceDescriptor;
  firstObservationId: string;
  latestObservationId: string;
  consecutiveMatches: number;
}

export interface AmbientOutfitEpisode {
  episodeId: string;
  sessionId: string;
  status: 'observing' | 'stable' | 'captured' | 'ended';
  startedAt: string;
  endedAt?: string;
  consecutiveReliableObservations: number;
  lastFrameId?: string;
  lastObservationId?: string;
  lastObservedAt?: string;
  lastCaptureId?: string;
  garmentTracks?: AmbientGarmentTrack[];
}

export interface OutfitCaptureProposalItem {
  observation: WornGarmentObservation;
  identity: GarmentIdentityHypothesis;
  resolvedClosetItemId: string;
  createItem?: AmbientClosetItem;
}

export interface OutfitCaptureProposal {
  proposalId: string;
  userId: string;
  sessionId: string;
  episodeId: string;
  observation: WornOutfitObservation;
  packet: AmbientCapturePacket;
  evidenceImageUrl: string;
  items: OutfitCaptureProposalItem[];
  outfitSignature: string;
  repeatedOutfit: boolean;
  idempotencyKey: string;
}

export interface CommitOutfitCaptureCommand {
  proposal: OutfitCaptureProposal;
}

export interface OutfitCaptureCommitResult {
  status: 'committed' | 'already_committed';
  capture: OutfitCapture;
  createdClosetItemIds: string[];
  recognizedClosetItemIds: string[];
  appearances: GarmentAppearance[];
  wearEvents: WearEvent[];
}

export interface UserWardrobeState {
  schemaVersion: 1;
  userId: string;
  version: number;
  grant?: AmbientCaptureGrant;
  closetItems: AmbientClosetItem[];
  appearances: GarmentAppearance[];
  captures: OutfitCapture[];
  wearEvents: WearEvent[];
  episodes: AmbientOutfitEpisode[];
  committedIdempotencyKeys: string[];
  updatedAt: string;
}

export type AmbientCaptureOutcomeStatus =
  | 'disabled'
  | 'observing'
  | 'deferred'
  | 'privacy_paused'
  | 'insufficient_evidence'
  | 'ambiguous'
  | 'committed'
  | 'recognized'
  | 'mixed'
  | 'already_committed'
  | 'episode_ended'
  | 'unavailable';

export interface OutfitCaptureCompletedEvent {
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
    slot: AmbientGarmentSlot;
    label: string;
    status: 'new' | 'recognized';
  }>;
  repeatedOutfit: boolean;
  committedAt: string;
}

export interface AmbientCaptureOutcome {
  status: AmbientCaptureOutcomeStatus;
  reasonCodes: string[];
  episodeId?: string;
  observationId?: string;
  retryAfterMs?: number;
  completedEvent?: OutfitCaptureCompletedEvent;
}

export interface AmbientCaptureDiagnostics {
  enabled: boolean;
  providerReady: boolean;
  grantActive: boolean;
  currentEpisode?: AmbientOutfitEpisode;
  closetItemCount: number;
  captureCount: number;
  wearEventCount: number;
  lastOutcome?: AmbientCaptureOutcome;
}

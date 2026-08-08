import type { ClosetItem } from '../types.js';
import type {
  CanonicalGarmentLengthClass,
  CanonicalMaterialClass,
  CanonicalNeckline,
  CanonicalSleeve,
} from '../services/garmentVocabulary.js';

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

export type GarmentImageRole =
  | 'capture_evidence'
  | 'track_identity_evidence'
  | 'garment_appearance'
  | 'canonical_product';

export type GarmentImageVerificationStatus =
  | 'not_required'
  | 'pending'
  | 'passed'
  | 'failed'
  | 'uncertain';

export interface ProductImageVerification {
  result: 'pass' | 'fail' | 'uncertain';
  confidence: number;
  checks: {
    colorMatch: boolean;
    patternMatch: boolean;
    necklineMatch?: boolean;
    sleeveMatch?: boolean;
    closureMatch?: boolean;
    pocketMatch?: boolean;
    silhouetteMatch?: boolean;
    lengthMatch?: boolean;
    logoMatch?: boolean;
  };
  mismatches: string[];
  notes: string[];
}

export interface GarmentImageAsset {
  assetId: string;
  ownerUserId: string;
  role: GarmentImageRole;
  imageUrl: string;
  storagePath?: string;
  sourceAssetId?: string;
  sourceFrameId?: string;
  observationItemId?: string;
  closetItemId?: string;
  width: number;
  height: number;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  verificationStatus: GarmentImageVerificationStatus;
  verification?: ProductImageVerification;
  contentHash: string;
  perceptualHash?: string;
  createdAt: string;
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
  sleeve?: CanonicalSleeve;
  neckline?: CanonicalNeckline;
  lengthClass?: CanonicalGarmentLengthClass;
  materialClass?: CanonicalMaterialClass;
  silhouette: string;
  fit: string;
  visibleFraction?: 'full' | 'partial' | 'barely';
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
  sleeve?: CanonicalSleeve;
  neckline?: CanonicalNeckline;
  lengthClass?: CanonicalGarmentLengthClass;
  materialClass?: CanonicalMaterialClass;
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
  appearanceAssetId: string;
  boundingBox: NormalizedBoundingBox;
  confidence: number;
  capturedAt: string;
}

export interface AmbientClosetItem {
  item: ClosetItem;
  status: 'active' | 'archived';
  source: 'ambient_capture';
  appearanceFingerprint: string;
  mergedIntoItemId?: string;
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
  decisionTrace?: GarmentIdentityDecisionTrace;
}

export type GarmentIdentityFeature =
  | 'color'
  | 'pattern_family'
  | 'category'
  | 'sleeve_length'
  | 'neckline_family'
  | 'texture_family'
  | 'length'
  | 'silhouette'
  | 'fit'
  | 'general_shape'
  | 'pattern_placement'
  | 'print_placement'
  | 'logo_placement'
  | 'pocket_geometry'
  | 'drawstring_construction'
  | 'closure_layout'
  | 'button_layout'
  | 'zipper_details'
  | 'unique_decoration'
  | 'stitching_layout'
  | 'waistband_construction'
  | 'hem_construction'
  | 'cuff_construction'
  | 'unique_texture_detail'
  | 'distinctive_hardware';

export type IdentityEvidenceClass = 'class_level' | 'supporting_identity' | 'instance_specific';
export type ReferenceEvidenceType = 'historical_appearance' | 'catalog_only';
export type TemporalEvidenceConsistency = 'consistent' | 'mixed' | 'insufficient';

export interface GarmentFeatureComparison {
  feature: GarmentIdentityFeature;
  currentVisibility: 'visible' | 'partial' | 'not_visible';
  referenceVisibility: 'visible' | 'partial' | 'not_visible';
  relation: 'same' | 'different' | 'unknown';
  discriminativeStrength: 'weak' | 'medium' | 'strong';
  note: string;
}

export interface GarmentFrameFeatureEvidence {
  frameIndex: number;
  featureComparisons: GarmentFeatureComparison[];
}

export interface PairwiseGarmentVerification {
  verdict: 'same' | 'different' | 'uncertain';
  confidence: number;
  currentColor?: string;
  currentSleeve?: CanonicalSleeve;
  currentNeckline?: CanonicalNeckline;
  featureComparisons: GarmentFeatureComparison[];
  currentFrameEvidence?: GarmentFrameFeatureEvidence[];
  occlusions: string[];
  jointlyVisibleEvidence: string[];
  temporalEvidenceConsistency?: TemporalEvidenceConsistency;
  model: string;
}

export type IdentityCandidateTier = 'strong' | 'plausible' | 'fallback';
export type IdentityCategoryCompatibility = 'exact' | 'compatible' | 'conflicting';

export interface GarmentIdentityDecisionTrace {
  traceId: string;
  episodeId: string;
  observationItemId: string;
  currentAppearanceAssetId: string;
  currentAppearanceAssetIds?: string[];
  pendingResolutionId?: string;
  automaticRecheckCount?: number;
  recall: {
    strategy: string;
    candidates: Array<{
      closetItemId: string;
      source: 'base' | 'user';
      metadataScore: number;
      continuityPrior: number;
      effectivePrior: number;
      tier: IdentityCandidateTier;
      categoryCompatibility: IdentityCategoryCompatibility;
      referenceEvidenceType: ReferenceEvidenceType;
      referenceAssetIds: string[];
      softContradictions: string[];
    }>;
  };
  pairwiseVerifications: Array<{
    candidateClosetItemId: string;
    evaluation?: 'verified' | 'excluded';
    exclusionReason?: string;
    rawResult: PairwiseGarmentVerification;
    normalizedResult: PairwiseGarmentVerification;
    serverDowngradeReasons: string[];
    requiredDifferentConfidence: number;
    autoCreateVeto: boolean;
    referenceEvidenceType: ReferenceEvidenceType;
    evidenceTaxonomyVersion: number;
    classLevelSameFeatures: GarmentIdentityFeature[];
    instanceSpecificSameFeatures: GarmentIdentityFeature[];
    safeSameGateResult: boolean;
    safeSameRejectReasons: string[];
    multiFrameEvidenceCount: number;
    temporalEvidenceConsistency: TemporalEvidenceConsistency;
    model: string;
    latencyMs: number;
  }>;
  thresholds: {
    matchConfidence: number;
    baseNewConfidence: number;
    strongPriorVeto: number;
    vetoMinPrior?: number;
  };
  finalDecision: GarmentIdentityStatus;
  matchedClosetItemId?: string;
  reasonCodes: string[];
  promptVersion: string;
  schemaVersion: number;
  createdAt: string;
}

export type OutfitItemRef =
  | {
      type: 'closet_item';
      closetItemId: string;
      slot: AmbientGarmentSlot;
    }
  | {
      type: 'pending_identity';
      resolutionId: string;
      slot: AmbientGarmentSlot;
    };

export interface OutfitCapture {
  captureId: string;
  userId: string;
  sessionId: string;
  episodeId: string;
  observationId: string;
  closetItemIds: string[];
  items: OutfitItemRef[];
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
  latestObservationItemId?: string;
  slot: AmbientGarmentSlot;
  category: ClosetItem['category'];
  appearanceFingerprint: string;
  descriptor: GarmentAppearanceDescriptor;
  firstObservationId: string;
  latestObservationId: string;
  consecutiveMatches: number;
  identityEvidence: TrackIdentityEvidence[];
  maxEvidenceCount: number;
}

export interface TrackIdentityEvidence {
  observationId: string;
  frameId: string;
  assetId: string;
  capturedAt: string;
  descriptor: GarmentAppearanceDescriptor;
  boundingBox: NormalizedBoundingBox;
  coverage: WornOutfitObservation['coverage'];
  qualityScore?: number;
}

export type PendingIdentityResolutionState =
  | 'awaiting_evidence'
  | 'ready_to_ask'
  | 'deferred'
  | 'expired'
  | 'resolved_existing'
  | 'resolved_new';

export interface PendingIdentityCandidateSummary {
  closetItemId: string;
  label: string;
  imageUrl: string;
  priorRank: number;
  identityReasonCodes: string[];
}

export interface PendingIdentityEvidenceSignature {
  assetId: string;
  perceptualHash?: string;
  boundingBox: NormalizedBoundingBox;
  descriptor: GarmentAppearanceDescriptor;
  coverage: WornOutfitObservation['coverage'];
}

export interface PendingIdentityResolution {
  resolutionId: string;
  userId: string;
  episodeId: string;
  trackId: string;
  observationItemId: string;
  slot?: AmbientGarmentSlot;
  category?: ClosetItem['category'];
  lockedDescriptor: GarmentAppearanceDescriptor;
  currentEvidenceAssetIds: string[];
  evidenceSignatures: PendingIdentityEvidenceSignature[];
  /** Current candidate window used for live reconnect decisions. */
  candidateClosetItemIds: string[];
  /** Bounded audit history; never used directly for reconnect. */
  candidateHistoryClosetItemIds: string[];
  candidateSummaries: PendingIdentityCandidateSummary[];
  ambiguityReasonCodes: string[];
  occludedFeatures: string[];
  automaticRecheckCount: number;
  state: PendingIdentityResolutionState;
  createdAt: string;
  updatedAt: string;
  deadlineAt?: string;
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
  type: 'closet_item';
  observation: WornGarmentObservation;
  appearanceAsset: GarmentImageAsset;
  identity: GarmentIdentityHypothesis;
  resolvedClosetItemId: string;
  createItem?: AmbientClosetItem;
}

export interface PendingOutfitCaptureProposalItem {
  type: 'pending_identity';
  observation: WornGarmentObservation;
  appearanceAsset: GarmentImageAsset;
  identity: GarmentIdentityHypothesis;
  pendingResolutionId: string;
}

export interface OutfitCaptureProposal {
  proposalId: string;
  userId: string;
  sessionId: string;
  episodeId: string;
  observation: WornOutfitObservation;
  packet: AmbientCapturePacket;
  evidenceAsset: GarmentImageAsset;
  evidenceImageUrl: string;
  items: Array<OutfitCaptureProposalItem | PendingOutfitCaptureProposalItem>;
  outfitSignature: string;
  repeatedOutfit: boolean;
  idempotencyKey: string;
}

export interface CommitOutfitCaptureCommand {
  proposal: OutfitCaptureProposal;
  pendingResolutions?: Array<{
    resolutionId: string;
    closetItemId: string;
    state: 'resolved_existing' | 'resolved_new';
  }>;
}

export interface OutfitCaptureCommitResult {
  status: 'committed' | 'already_committed';
  capture: OutfitCapture;
  createdClosetItemIds: string[];
  recognizedClosetItemIds: string[];
  appearances: GarmentAppearance[];
  wearEvents: WearEvent[];
}

export type WardrobeEventType =
  | 'capture_evidence_stored'
  | 'garment_appearance_stored'
  | 'provisional_item_created'
  | 'existing_item_matched'
  | 'wear_recorded'
  | 'outfit_captured'
  | 'product_image_generation_started'
  | 'product_image_generated'
  | 'product_image_verified'
  | 'closet_primary_image_updated'
  | 'closet_items_merged'
  | 'product_image_failed';

export interface WardrobeEvent {
  eventId: string;
  userId: string;
  type: WardrobeEventType;
  closetItemId?: string;
  captureId?: string;
  assetId?: string;
  jobId?: string;
  reasonCode?: string;
  createdAt: string;
}

export interface ProductImageJob {
  jobId: string;
  userId: string;
  closetItemId: string;
  sourceAppearanceAssetId: string;
  status: 'processing' | 'ready' | 'needs_review' | 'failed';
  attemptCount: number;
  productAssetId?: string;
  failureCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserWardrobeState {
  schemaVersion: 1;
  userId: string;
  version: number;
  grant?: AmbientCaptureGrant;
  assets: GarmentImageAsset[];
  closetItems: AmbientClosetItem[];
  appearances: GarmentAppearance[];
  captures: OutfitCapture[];
  wearEvents: WearEvent[];
  episodes: AmbientOutfitEpisode[];
  committedIdempotencyKeys: string[];
  productImageJobs: ProductImageJob[];
  identityDecisionTraces: GarmentIdentityDecisionTrace[];
  pendingIdentityResolutions: PendingIdentityResolution[];
  closetItemAliases: Record<string, string>;
  events: WardrobeEvent[];
  pendingCompletionEvent?: OutfitCaptureCompletedEvent;
  updatedAt: string;
}

export interface ClosetItemMergePreview {
  status: 'ready' | 'already_merged' | 'blocked';
  userId: string;
  canonicalItemId: string;
  duplicateItemId: string;
  blocker?: string;
  migrations: {
    appearances: number;
    assets: number;
    wearEvents: number;
    outfitCaptures: number;
    productImageJobs: number;
    completionSummaries: number;
    wardrobeEvents: number;
    identityDecisionTraces: number;
  };
  primaryImageWillChange: boolean;
}

export interface MergeClosetItemsResult {
  status: 'merged' | 'already_merged';
  preview: ClosetItemMergePreview;
  canonicalItem: AmbientClosetItem;
  duplicateItem: AmbientClosetItem;
}

export type AmbientCaptureOutcomeStatus =
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

export interface OutfitCaptureCompletedEvent {
  eventId: string;
  type: 'outfit_capture_completed';
  userId: string;
  sessionId: string;
  captureId: string;
  episodeId: string;
  newItemIds: string[];
  recognizedItemIds: string[];
  completionStatus: 'fully_resolved' | 'partially_resolved' | 'fully_recognized';
  pendingItems: Array<{
    resolutionId: string;
    slot: AmbientGarmentSlot;
    label: string;
    state: 'awaiting_evidence' | 'ready_to_ask' | 'deferred';
  }>;
  itemSummaries: Array<{
    closetItemId: string;
    slot: AmbientGarmentSlot;
    label: string;
    status: 'new' | 'recognized';
    imageUrl?: string;
    fallbackImageUrl?: string;
    imageStatus?: ClosetItem['imageStatus'];
  }>;
  repeatedOutfit: boolean;
  committedAt: string;
  updatedAt?: string;
  acknowledgedAt?: string;
}

export interface AmbientCaptureOutcome {
  status: AmbientCaptureOutcomeStatus;
  reasonCodes: string[];
  episodeId?: string;
  observationId?: string;
  retryAfterMs?: number;
  completedEvent?: OutfitCaptureCompletedEvent;
}

export interface AmbientProductImageBackfillResult {
  attemptedItemIds: string[];
  readyItemIds: string[];
  needsReviewItemIds: string[];
  skippedItemIds: string[];
}

export interface AmbientCaptureDiagnostics {
  enabled: boolean;
  providerReady: boolean;
  identityVerifierReady: boolean;
  productImageProviderReady: boolean;
  productImageVerifierReady: boolean;
  grantActive: boolean;
  currentEpisode?: AmbientOutfitEpisode;
  closetItemCount: number;
  captureCount: number;
  wearEventCount: number;
  assetCounts: Record<GarmentImageRole, number>;
  processingImageCount: number;
  needsReviewImageCount: number;
  diagnosticCaptureRetentionEnabled: boolean;
  diagnosticCaptureCount: number;
  latestDiagnosticCapture?: {
    bundleId: string;
    relativeDirectory: string;
    frameId: string;
    observationId: string;
    createdAt: string;
  };
  lastOutcome?: AmbientCaptureOutcome;
}

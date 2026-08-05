export type ImageKind =
  | 'user_photo'
  | 'garment_reference'
  | 'closet_item'
  | 'product'
  | 'ai_concept_item'
  | 'ai_outfit_visual'
  | 'ai_try_on';

export interface StoredImage {
  id: string;
  ownerUserId: string;
  sessionId: string;
  kind: ImageKind;
  mimeType: string;
  localPath?: string;
  url?: string;
  createdAt: string;
  aiGenerated: boolean;
  label?: string;
}

export interface AttachmentInput {
  id: string;
  kind: Extract<ImageKind, 'user_photo' | 'garment_reference'>;
  mimeType: string;
  localPath?: string;
  url?: string;
  makeCurrent?: boolean;
  label?: string;
}

export interface ClosetItem {
  id: string;
  name: string;
  category:
    | 'top'
    | 'bottom'
    | 'dress'
    | 'jumpsuit'
    | 'outerwear'
    | 'shoes'
    | 'bag'
    | 'accessory';
  color: string;
  fit: string;
  formality: string;
  styleTags: string[];
  imageUrl: string;
  primaryImageAssetId?: string;
  appearanceAssetIds?: string[];
  imageStatus?: 'processing' | 'ready' | 'needs_review' | 'failed';
  source?: 'demo_fixture' | 'mirror_auto_capture' | 'manual';
  identityStatus?: 'confirmed' | 'provisional' | 'merged';
  ownershipStatus?: 'confirmed' | 'unverified';
  marketedFor?: 'womens' | 'mens' | 'unisex';
  presentationMetadata?: PresentationMetadata;
  cutProfile?: CutProfile;
  garmentMeasurements?: GarmentMeasurements;
  fitCompatibilityTags?: string[];
}

export interface ProductItem {
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
}

export interface VisualReferenceItem {
  id: string;
  name: string;
  category: string;
  color?: string;
  imageUrl?: string;
  source: 'closet' | 'product' | 'concept';
}

export interface OutfitItem {
  category: string;
  name: string;
  color: string;
  fit?: string;
  source?: 'closet' | 'catalog' | 'suggested' | 'suggested_complement';
  itemId?: string;
}

export interface OutfitCandidate {
  id: string;
  name?: string;
  occasion?: string;
  items: OutfitItem[];
  stylingActions?: string[];
  rationale?: string;
  provenance?: ClosetRecommendationProvenance;
}

export type CommittedOutfit =
  | {
      type: 'closet_candidate';
      id: string;
      recommendationId: string;
      candidateId: string;
      outfit: OutfitCandidate;
      itemIds: string[];
      closetVersion: string;
      profileSnapshotId: string;
      policyVersion: string;
      createdAt: string;
    }
  | {
      type: 'freeform_outfit';
      id: string;
      outfitSpecId: string;
      outfit: OutfitCandidate;
      createdAt: string;
      disclaimer: 'ai_concept_not_in_closet';
    };

export type OutfitSnapshot =
  | {
      type: 'closet_candidate';
      snapshotId: string;
      version?: number;
      contentHash?: string;
      recommendationId: string;
      candidateId: string;
      itemIds: string[];
      outfit: OutfitCandidate;
      closetVersion: string;
      profileSnapshotId: string;
      policyVersion: string;
      createdAt: string;
    }
  | {
      type: 'freeform_concept';
      snapshotId: string;
      version?: number;
      contentHash?: string;
      label: 'ai_concept_not_in_closet';
      title?: string;
      items: Array<{
        category: string;
        layerRole?: OutfitLayerRole;
        wearMode?: OutfitWearMode;
        required?: boolean;
        visibleInHero?: boolean;
        color?: string;
        silhouette?: string;
        requiredDetails?: string[];
        forbiddenDetails?: string[];
        description: string;
        conceptSpec?: ConceptItemSpec;
      }>;
      outfit: OutfitCandidate;
      createdAt: string;
    };

export type OutfitLayerRole = 'base' | 'mid' | 'outer' | 'bottom' | 'footwear';
export type OutfitWearMode = 'open' | 'buttoned' | 'tucked' | 'untucked' | 'layered' | 'normal';

export interface ConceptItemSpec {
  conceptItemId: string;
  category: string;
  subCategory?: string;
  color: string;
  silhouette: string;
  length?: string;
  fit?: string;
  layerRole?: OutfitLayerRole;
  wearMode?: OutfitWearMode;
  materialHint?: string;
  requiredDetails: string[];
  forbiddenDetails: string[];
}

export interface ConceptItemAsset {
  conceptItemAssetId: string;
  specHash: string;
  spec?: ConceptItemSpec;
  category: string;
  title: string;
  description: string;
  color: string;
  silhouette?: string;
  materialHint?: string;
  imageId?: string;
  imageUrl?: string;
  promptVersion: string;
  model: string;
  quality: 'low' | 'medium' | 'high';
  status: 'generating' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  failureReason?: string;
  verification?: ConceptItemVerification;
}

export interface ConceptItemVerification {
  passed: boolean;
  categoryMatches: boolean;
  dominantColorMatches: boolean;
  fullItemVisible: boolean;
  isolatedItem: boolean;
  personVisible: boolean;
  mannequinVisible: boolean;
  textVisible: boolean;
  logoVisible: boolean;
  issues: string[];
}

export type VisualRequestStatus =
  | 'awaiting_choice'
  | 'awaiting_approval'
  | 'ready'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface VisualRequestPatch {
  replaceCategory?: string;
  newCategory?: string;
  newColor?: string;
  newDescription?: string;
  title?: string;
  extraInstruction?: string;
}

export interface PendingVisualRequest {
  requestId: string;
  sessionId: string;
  originTurnId: string;
  outfitSnapshotId: string;
  sourcePersonImageId?: string;
  visualType: 'outfit_visual' | 'try_on' | 'concept_board';
  status: VisualRequestStatus;
  approvalId?: string;
  requestedScope?: 'auto' | 'upper_body' | 'full_body';
  aspectRatio?: string;
  extraInstruction?: string;
  faceMode?: 'include' | 'conceal';
  constraints?: VisualConstraintState;
  tryOnGenerationContext?: TryOnGenerationContext;
  expiresAt: string;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
}

export interface VisualConstraintState {
  facePolicy?: 'exclude' | 'preserve';
  framing?: 'upper_body' | 'three_quarter' | 'full_body';
  subject?: 'anonymous_model' | 'user';
  source: 'explicit_user' | 'ui_control' | 'session_default';
  lockedFields: Array<'facePolicy' | 'framing' | 'subject'>;
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

export type MemoryNamespace =
  | 'style_preference'
  | 'fit_preference'
  | 'avoidance'
  | 'communication_preference';

export type MemoryStatus =
  | 'active'
  | 'paused'
  | 'superseded'
  | 'expired'
  | 'deleted';

export type Explicitness = 'user_requested' | 'user_stated' | 'inferred';
export type MemoryAuthorization = 'explicit' | 'implicit_durable_statement';

export interface MemoryApplicability {
  occasion?: Array<'daily' | 'commute' | 'formal' | 'party' | 'travel'>;
  season?: string[];
  locationType?: string[];
  taskType?: string[];
}

export type MemorySource =
  | { type: 'conversation'; conversationId: string; messageId: string }
  | { type: 'settings'; settingsVersion: string }
  | { type: 'migration'; migrationId: string; legacyField: string }
  | { type: 'deleted_conversation'; originalSourceDeletedAt: string };

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

export interface ContextOverride<T = unknown> {
  id: string;
  userId: string;
  conversationId: string;
  taskId?: string;
  scope: OverrideScope;
  namespace: MemoryNamespace;
  key: string;
  value: T;
  sourceMessageId?: string;
  validFrom: string;
  validUntil?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UserMemory {
  id: string;
  userId: string;
  value: MemoryValue;
  status: MemoryStatus;
  applicability?: MemoryApplicability;
  explicitness: Explicitness;
  authorization: MemoryAuthorization;
  confidence: number;
  validFrom?: string;
  validUntil?: string;
  source: MemorySource;
  supersedesMemoryId?: string;
  createdAt: string;
  updatedAt: string;
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

export interface ExtractedPreferenceIntent {
  subject: 'user' | 'other' | 'unknown';
  operation: 'set' | 'remove' | 'correct' | 'do_not_remember';
  durabilityIntent: OverrideScope | 'persistent';
  temporalValidity?: {
    startsAt?: string;
    expiresAt?: string;
  };
  memoryAuthorization:
    | 'explicit'
    | 'implicit_durable_statement'
    | 'none'
    | 'explicitly_denied';
  value: MemoryValue;
  confidence: number;
  applicability?: MemoryApplicability;
}

export interface ExplicitPreferenceEvent {
  id: string;
  userId: string;
  conversationId: string;
  messageId: string;
  intent: ExtractedPreferenceIntent;
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

export interface MusePersonalizationContext {
  persistentMemories: Array<{
    type: MemoryValue['namespace'];
    key: string;
    value: MemoryValue;
    applicability?: MemoryApplicability;
    authority: 'confirmed_persistent_memory';
  }>;
  contextOverrides: Array<{
    scope: OverrideScope;
    value: unknown;
    expiresAt?: string;
    authority: 'current_context_override';
  }>;
  historicalContext: Array<{
    occurredAt: string;
    event: string;
    authority: 'historical_event_not_current_preference';
  }>;
}

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

export interface MemoryAuditEvent {
  id: string;
  userId: string;
  memoryId?: string;
  action: 'created' | 'confirmed' | 'updated' | 'superseded' | 'deleted' | 'expired' | 'paused' | 'restored';
  actor: 'user' | 'system' | 'extractor';
  previousValueHash?: string;
  createdAt: string;
}

export type FitStatus = 'confirmed' | 'likely' | 'unknown' | 'incompatible';

export interface PresentationAffinity {
  masculine: number;
  androgynous: number;
  feminine: number;
}

export interface PresentationMetadata {
  affinity: PresentationAffinity;
  intensity: 'neutral' | 'subtle' | 'moderate' | 'strong';
  reasonCodes: string[];
  metadataVersion: string;
  reviewedAt: string;
}

export interface CutProfile {
  shoulder?: 'narrow' | 'regular' | 'wide';
  waist?: 'shaped' | 'straight' | 'relaxed';
  hip?: 'shaped' | 'straight' | 'relaxed';
  rise?: 'low' | 'mid' | 'high';
  length?: 'cropped' | 'short' | 'regular' | 'long';
}

export interface GarmentMeasurements {
  shoulderCm?: number;
  chestCm?: number;
  waistCm?: number;
  hipCm?: number;
  inseamCm?: number;
}

export interface StylingProfile {
  presentationPreference: PresentationPreference;
  presentationOpenness: PresentationOpenness;
  recommendationScope?: RecommendationScope;
  expressionIntensity?: ExpressionIntensity;
  preferenceMemoryScope?: PreferenceMemoryScope;
  styleTone?: StyleTone;
  fitPreference?: 'fitted' | 'regular' | 'relaxed' | 'oversized';
  sizeProfile?: {
    tops?: string[];
    bottoms?: string[];
    outerwear?: string[];
    shoes?: string[];
  };
  stylingGoals?: string[];
  avoidedCategories?: string[];
  avoidedCuts?: string[];
  source: 'explicit_user' | 'demo_preset' | 'session_override' | 'unknown';
  updatedAt?: string;
}

export interface StylingProfileSnapshot {
  id: string;
  profile: StylingProfile;
  sourcePrecedence: Array<'must_use' | 'turn_override' | 'session_preference' | 'persistent_profile' | 'unknown'>;
  createdAt: string;
}

export interface PresentationCompatibilityResult {
  allowed: boolean;
  score: number;
  reasonCodes: string[];
  fitStatus: FitStatus;
  fitConfidence?: number;
}

export interface ClosetCoverage {
  compatibleItemCount: number;
  availableByCategory: Record<string, number>;
  missingCategories: string[];
  excludedForPresentationCount: number;
  excludedForFitCount: number;
}

export type ClosetRecommendationStatus =
  | 'success'
  | 'needs_presentation_preference'
  | 'insufficient_compatible_items'
  | 'insufficient_complete_look'
  | 'no_valid_items';

export interface ClosetRecommendationProvenance {
  recommendationId: string;
  candidateId: string;
  closetVersion: string;
  profileSnapshotId: string;
  policyVersion: string;
  createdAt: string;
}

export interface ClosetOutfitCandidate {
  id: string;
  title: string;
  itemIds: string[];
  categories: ClosetItem['category'][];
  completeness: 'complete' | 'partial';
  score: number;
  reasonCodes: string[];
  fitStatus: FitStatus;
  provenance: ClosetRecommendationProvenance;
}

export interface SuggestedComplement {
  category: string;
  name: string;
  reason: string;
  source: 'suggested_complement';
}

export interface ClosetRecommendationResult {
  recommendationId: string;
  profileSnapshotId: string;
  policyVersion: string;
  closetVersion: string;
  createdAt: string;
  status: ClosetRecommendationStatus;
  candidates: ClosetOutfitCandidate[];
  coverage: ClosetCoverage;
  clarification?: {
    question: string;
    options: Array<{
      id: PresentationPreference | RecommendationScope;
      label: string;
    }>;
  };
  rangeHint?: {
    message: string;
    options: Array<{
      id: RecommendationScope | ExpressionIntensity;
      label: string;
    }>;
  };
  suggestedComplements?: SuggestedComplement[];
}

export interface OutfitEvaluation {
  overallScore: number;
  occasionScore: number;
  colorScore: number;
  silhouetteScore: number;
  proportionScore: number;
  completenessScore: number;
  pass: boolean;
  strengths: string[];
  issues: string[];
  suggestedFixes: string[];
}

export interface VisualObservation {
  visibleItems: Array<{
    category: string;
    description: string;
    color: string;
    fit: string;
  }>;
  mainColors: string[];
  silhouette: string;
  proportionNotes: string[];
  formality: string;
  strengths: string[];
  issues: string[];
  uncertainties: string[];
}

export interface TryOnFrameAssessment {
  sourceFrameId: string;
  assessedAt: string;
  visibleRegion:
    | 'face_only'
    | 'head_shoulders'
    | 'upper_body'
    | 'three_quarter'
    | 'full_body';
  personCount: number;
  faceVisible: boolean;
  torsoVisible: boolean;
  legsVisible: boolean;
  feetVisible: boolean;
  lighting: 'good' | 'too_dark' | 'overexposed' | 'backlit';
  framing: 'usable' | 'too_close' | 'cropped' | 'occluded' | 'blurred';
  recommendedMode: 'upper_body' | 'full_body' | 'reject';
  limitations: string[];
}

export type TryOnScope =
  | 'neckline_preview'
  | 'upper_body_faithful'
  | 'full_body_synthetic'
  | 'full_body';

export interface TryOnGenerationContext {
  sourceImageId: string;
  sourceFrameId?: string;
  sourceImageHash: string;
  sourceCoverage: TryOnFrameAssessment['visibleRegion'];
  outfitSnapshotId: string;
  outfitSnapshotHash: string;
  requestedScope: 'auto' | 'upper_body' | 'full_body';
  resolvedScope: TryOnScope;
  photoGrantId: string;
  createdAt: string;
}

export interface TryOnVerification {
  passed: boolean;
  sourcePreservation: {
    faceAndHairConsistent: boolean;
    poseConsistent: boolean;
    framingConsistent: boolean;
    backgroundReasonablyConsistent: boolean;
  };
  outfitGrounding: {
    requiredItemIds: string[];
    visiblyPresentItemIds: string[];
    missingItemIds: string[];
    majorColorMismatch: boolean;
  };
  scopeCorrect: boolean;
  obviousArtifact: boolean;
  issues: string[];
}

export interface PhotoUseGrant {
  approvalId: string;
  sessionId: string;
  sourceImageId: string;
  grantedAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface SyntheticExtensionConsent {
  requestId: string;
  sourceImageId: string;
  acceptedRegions: Array<'lower_body' | 'legs' | 'feet'>;
  grantedAt: string;
}

export interface PendingTryOnRequest {
  approvalId: string;
  createdAt: string;
  sourceImageId: string;
  visualRequestId?: string;
  outfitSnapshotId?: string;
  requestedScope: 'auto' | 'upper_body' | 'full_body';
  aspectRatio?: string;
  extraInstruction?: string;
  recommendationId?: string;
  candidateId?: string;
  faceMode?: 'include' | 'conceal';
  requiresSyntheticExtension?: boolean;
  syntheticRegions?: Array<'lower_body' | 'legs' | 'feet'>;
}

export interface TryOnSessionVersion {
  version: number;
  artifactId: string;
  imageId: string;
  parentArtifactId?: string;
  outfitSnapshotId: string;
  editInstruction?: string;
  createdAt: string;
}

export interface TryOnSession {
  tryOnSessionId: string;
  sourcePersonImageId: string;
  committedOutfitId: string;
  currentArtifactId: string;
  currentVersion: number;
  versions: TryOnSessionVersion[];
}

export type VisualOperation = 'outfit_visual' | 'try_on' | 'edit';
export type VisualScope =
  | 'upper_body'
  | 'full_body'
  | 'concept'
  | TryOnScope;

export interface VisualSessionState {
  activePersonImageId?: string;
  activeOutfitSnapshotId?: string;
  currentArtifactId?: string;
  currentVersionId?: string;
  tryOnSessionId?: string;
  photoGrantId?: string;
}

export interface VisualVersion {
  versionId: string;
  artifactId: string;
  imageId: string;
  heroArtifactId?: string;
  itemAssetIds?: string[];
  renderPlan?: HeroRenderPlan;
  verificationResult?: HeroVerification;
  layoutVersion?: string;
  lookBoardArtifact?: Extract<UiArtifact, { type: 'look_board' }>;
  parentVersionId?: string;
  sourcePersonImageId?: string;
  outfitSnapshotId: string;
  operation: 'generate' | 'edit';
  scope: VisualScope;
  model: string;
  promptVersion: string;
  verificationStatus: 'passed' | 'failed' | 'limited';
  limitations: string[];
  createdAt: string;
}

export interface HeroRenderPlan {
  subject: 'anonymous_model' | 'user';
  facePolicy: 'exclude' | 'preserve';
  headTreatment: 'preserve' | 'crop_out' | 'back_facing' | 'obscured';
  framing: 'upper_body' | 'three_quarter' | 'full_body';
  backgroundPolicy: 'preserve_source' | 'replace_clean_studio';
  backgroundStyle?: 'off_white_seamless' | 'light_gray_seamless' | 'warm_neutral_studio';
  composition: {
    centerSubject: boolean;
    requireSinglePerson: boolean;
    requireFeetVisible: boolean;
    subjectScale: number;
    minimumHeadroomPercent: number;
    minimumFloorMarginPercent: number;
  };
  framingContract?: FramingContract;
  outfitSnapshotId: string;
}

export interface FramingContract {
  requireHeadVisible: boolean;
  requireTorsoVisible: boolean;
  requireBothLegsVisible: boolean;
  requireFeetVisible: boolean;
  requireFloorMargin: boolean;
  subjectOccupancy: {
    min: number;
    max: number;
  };
}

export interface HeroVerification {
  passed: boolean;
  verificationStatus?: 'passed' | 'failed' | 'limited';
  singlePersonSatisfied: boolean;
  faceVisible: boolean;
  fullBodyVisible: boolean;
  lowerBodyVisible: boolean;
  feetVisible: boolean;
  cleanBackgroundSatisfied: boolean;
  requestedFacePolicySatisfied: boolean;
  requestedFramingSatisfied: boolean;
  outfitMatchesSnapshot: boolean;
  majorColorMismatch: boolean;
  issues: string[];
  hardFailures?: string[];
  limitedIssues?: string[];
}

export type LookBoardItemSource = 'closet' | 'product' | 'concept';

export interface LookBoardItem {
  slot: 'top' | 'bottom' | 'outerwear' | 'shoes' | 'bag' | 'accessory';
  source: LookBoardItemSource;
  closetItemId?: string;
  productId?: string;
  conceptItemAssetId?: string;
  imageUrl: string;
  label: string;
  category: string;
  color?: string;
  layerRole?: OutfitLayerRole;
  wearMode?: OutfitWearMode;
  requiredDetails?: string[];
  forbiddenDetails?: string[];
  badge: '你的衣柜' | '真实商品' | 'AI 概念单品';
  required: boolean;
}

export interface LookBoardArtifact {
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
  items: LookBoardItem[];
  disclaimer: string;
  aiGenerated: true;
  visualVersionId?: string;
  visualSessionId?: string;
  parentVersionId?: string;
  operation?: VisualOperation;
  layoutVersion: string;
}

export type ActiveVisualSelection =
  | {
      kind: 'item';
      itemRef:
        | { source: 'closet'; closetItemId: string }
        | { source: 'product'; productId: string }
        | { source: 'concept'; conceptItemAssetId?: string; conceptSpec?: ConceptItemSpec };
      selectedAtTurnId: string;
    }
  | {
      kind: 'outfit';
      outfitSnapshotId: string;
      selectedAtTurnId: string;
    }
  | {
      kind: 'visual_version';
      versionId: string;
      selectedAtTurnId: string;
    }
  | {
      kind: 'none';
    };

export interface VisualCacheEntry {
  observation: VisualObservation;
  cachedAt: string;
  imageId?: string;
  source: 'quick' | 'deep';
  observationId?: string;
  sourceFrameId?: string;
  analyzedAt?: number;
  expiresAt?: number;
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

export type PreferenceValue = string | number | boolean | string[] | Record<string, unknown>;

export interface ToolLogEntry {
  id: string;
  toolName: string;
  startedAt: string;
  completedAt: string;
  status: 'ok' | 'error';
  summary: string;
}

export interface AgentEvent {
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
}

export interface AgentActivity extends AgentEvent {
  label?: string;
  displayDetail?: string;
  toolName?: string;
  elapsedMs?: number;
}

export type UiArtifact =
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
      products: ProductItem[];
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
      previewScope?: VisualScope;
      tryOnMetadata?: TryOnArtifactMetadata;
      temporary?: boolean;
      partial?: boolean;
      parentVersionId?: string;
      operation?: VisualOperation;
      referenceItems?: VisualReferenceItem[];
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
  | LookBoardArtifact
  | {
      type: 'notice';
      id: string;
      level: 'info' | 'warning' | 'error';
      text: string;
    };

export interface TryOnArtifactMetadata {
  previewScope: TryOnScope;
  sourceImageId: string;
  sourceCoverage: TryOnFrameAssessment['visibleRegion'];
  outfitSnapshotId: string;
  visibleItemRefs: string[];
  notVisualizedItemRefs: string[];
  syntheticRegions: string[];
  verificationStatus: 'passed' | 'limited' | 'failed';
  limitations: string[];
  promptVersion: string;
  model: string;
}

export interface FashionSessionState {
  images: Record<string, StoredImage>;
  currentUserImageId?: string;
  visualCache?: VisualCacheEntry;
  perception?: PerceptionState;
  stylingProfile?: StylingProfile;
  activeClosetRecommendation?: ClosetRecommendationResult;
  activeTurnId?: string;
  activeOutfit?: OutfitCandidate;
  committedOutfit?: CommittedOutfit;
  outfitSnapshots?: Record<string, OutfitSnapshot>;
  pendingVisualRequests?: Record<string, PendingVisualRequest>;
  activeOutfitSnapshotId?: string;
  activePendingVisualRequestId?: string;
  lastGeneratedImageId?: string;
  photoUseGrants: Record<string, PhotoUseGrant>;
  syntheticExtensionConsents?: Record<string, SyntheticExtensionConsent>;
  pendingTryOnRequest?: PendingTryOnRequest;
  tryOnSessions: Record<string, TryOnSession>;
  activeTryOnSessionId?: string;
  visualSession?: VisualSessionState;
  visualVersions: Record<string, VisualVersion>;
  visualConstraints?: VisualConstraintState;
  conceptItemAssets?: Record<string, ConceptItemAsset>;
  activeVisualSelection?: ActiveVisualSelection;
  sessionPreferences: Record<string, PreferenceValue>;
  persistentPreferences: Record<string, PreferenceValue>;
  pendingArtifacts: UiArtifact[];
  toolLog: ToolLogEntry[];
}

export interface TurnPermissions {
  allowVisualAnalysis: boolean;
  allowAiImageGeneration: boolean;
  allowPhotoUseForTryOn: boolean;
  allowPersistentMemory: boolean;
}

export type InteractionMode = 'text' | 'voice';

export type MuseLatencyMilestone =
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
  | 'playback_completed';

export interface TurnLatencyTelemetry {
  traceId: string;
  turnId: string;
  interactionMode: InteractionMode;
  timings: Partial<Record<MuseLatencyMilestone, number>>;
  modelRounds: number;
  usedVision: boolean;
  textChars: number;
  spokenChars: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

export interface FashionAgentContext {
  sessionId: string;
  userId: string;
  conversationId?: string;
  turnId: string;
  locale: string;
  nowIso: string;
  permissions: TurnPermissions;
  state: FashionSessionState;
  personalization?: MusePersonalizationContext;
  interactionMode?: InteractionMode;
  traceId?: string;
}

export interface FashionTurnInput {
  sessionId: string;
  userId: string;
  inputSource?: 'text' | 'voice';
  traceId?: string;
  conversationId?: string;
  temporary?: boolean;
  message: string;
  locale?: string;
  cameraLocalActive?: boolean;
  memoryPolicy?: Partial<MemoryPolicy>;
  personalizationContext?: MusePersonalizationContext;
  memoryUsage?: MemoryUsageDisclosure[];
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
  attachments?: AttachmentInput[];
  permissions?: Partial<TurnPermissions>;
  onActivity?: (activity: AgentActivity) => void;
  onDelta?: (text: string) => void;
  onCommentary?: (text: string) => void;
  onArtifact?: (artifact: UiArtifact) => void;
}

export interface MirrorFrameInput {
  sessionId: string;
  userId: string;
  locale?: string;
  cameraLocalActive?: boolean;
  attachments?: AttachmentInput[];
  permissions?: Partial<TurnPermissions>;
}

export interface MirrorFrameResult {
  ok: true;
  cachedAt?: string;
  status: 'accepted' | 'updated' | 'skipped';
  perception?: PerceptionState;
}

export interface ApprovalRequest {
  index: number;
  toolName: string;
  arguments: string;
  reason: string;
  faceMode?: 'include' | 'conceal';
}

export interface CompletedTurnResult {
  status: 'completed';
  text: string;
  spokenText?: string;
  telemetry?: TurnLatencyTelemetry;
  artifacts: UiArtifact[];
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
    visualSession?: VisualSessionState;
    memoryUsage?: MemoryUsageDisclosure[];
    pendingMemoryCandidates?: ExplicitPreferenceEvent[];
  };
}

export interface ApprovalRequiredTurnResult {
  status: 'approval_required';
  approvals: ApprovalRequest[];
  serializedRunState: string;
  artifacts: UiArtifact[];
  activity: AgentActivity[];
}

export type FashionTurnResult = CompletedTurnResult | ApprovalRequiredTurnResult;

export interface ApprovalDecision {
  index: number;
  approved: boolean;
  always?: boolean;
  rejectionMessage?: string;
  faceMode?: 'include' | 'conceal';
}

export interface ResumeFashionTurnInput {
  sessionId: string;
  userId: string;
  serializedRunState: string;
  decisions: ApprovalDecision[];
  permissions?: Partial<TurnPermissions>;
  locale?: string;
}

export interface WeatherResult {
  location: string;
  temperatureC: number;
  feelsLikeC: number;
  condition: string;
  precipitationChance: number;
  windKph: number;
  observedAt: string;
  source: string;
}

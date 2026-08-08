import { createHash } from 'node:crypto';
import type {
  AmbientCaptureDiagnostics,
  AmbientCaptureOutcome,
  AmbientCapturePacket,
  AmbientProductImageBackfillResult,
  AmbientClosetItem,
  AmbientGarmentTrack,
  AmbientOutfitEpisode,
  OutfitCaptureCompletedEvent,
  OutfitCaptureProposal,
  WornOutfitObservation,
  GarmentImageAsset,
  PendingIdentityResolution,
} from '../domain/ambientCapture.js';
import type { OutfitEpisode } from '../domain/outfitEpisode.js';
import type { MirrorSituationObservation } from '../domain/mirrorSituation.js';
import { decideMirrorSituation } from '../policy/mirrorSituationPolicy.js';
import type { ClosetItem } from '../types.js';
import { makeId } from '../utils/ids.js';
import type { GarmentIdentityProvider } from '../services/garmentIdentityProvider.js';
import { appearanceFingerprint, descriptorFromObservation } from '../services/garmentIdentityProvider.js';
import { canonicalizePattern, colorSimilarity } from '../services/garmentVocabulary.js';
import { hardAttributeExclusion } from '../services/garmentIdentityEvidence.js';
import type { OutfitObservationProvider } from '../services/outfitObservationProvider.js';
import type { JsonUserWardrobeRepository } from '../services/userWardrobeRepository.js';
import type { GarmentImageAssetService } from '../services/garmentImageAssetService.js';
import type { ProductImageProvider } from '../services/productImageProvider.js';
import type { ProductImageVerifier } from '../services/garmentVisualVerifier.js';

export class AmbientCaptureCoordinator {
  private readonly lastOutcomes = new Map<string, AmbientCaptureOutcome>();
  private readonly operations = new Map<string, Promise<void>>();

  constructor(
    private readonly options: {
      observationProvider: OutfitObservationProvider;
      identityProvider: GarmentIdentityProvider;
      repository: JsonUserWardrobeRepository;
      baseClosetItems: () => ClosetItem[];
      assetService: GarmentImageAssetService;
      productImageProvider: ProductImageProvider;
      productImageVerifier: ProductImageVerifier;
      productImageVerifyConfidence?: number;
      identityTraceLimit?: number;
      baseCatalogAssets?: () => Promise<Map<string, GarmentImageAsset>>;
      retainDiagnosticCaptures?: boolean;
      diagnosticCaptureLimit?: number;
    },
  ) {}

  async process(packet: AmbientCapturePacket): Promise<AmbientCaptureOutcome> {
    return this.exclusive(packet.userId, () => this.processLocked(packet));
  }

  private async processLocked(packet: AmbientCapturePacket): Promise<AmbientCaptureOutcome> {
    const state = await this.options.repository.getState(packet.userId);
    if (!activeGrant(state.grant)) return this.remember(packet.userId, { status: 'disabled', reasonCodes: ['AUTO_CAPTURE_GRANT_MISSING'] });
    if (!this.options.observationProvider.ready) return this.remember(packet.userId, { status: 'unavailable', reasonCodes: ['REAL_VISION_PROVIDER_UNAVAILABLE'], retryAfterMs: 15_000 });
    if (!validStability(packet)) return this.remember(packet.userId, { status: 'observing', reasonCodes: ['LOCAL_FRAME_NOT_STABLE'], retryAfterMs: 1_500 });
    const capturedAt = Date.parse(packet.capturedAt);
    if (!Number.isFinite(capturedAt) || Date.now() - capturedAt > 20_000 || capturedAt - Date.now() > 5_000) {
      return this.remember(packet.userId, { status: 'insufficient_evidence', reasonCodes: ['CAPTURE_PACKET_STALE'] });
    }

    let episode = currentEpisode(state.episodes, packet.sessionId) ?? newEpisode(packet);
    if (episode.lastFrameId === packet.frameId) {
      return this.remember(packet.userId, {
        status: 'observing',
        reasonCodes: ['DUPLICATE_CAPTURE_FRAME'],
        episodeId: episode.episodeId,
        retryAfterMs: 1_500,
      });
    }
    const preflight = decideMirrorSituation({
      observation: situationObservation(packet, episode, undefined, 'not_checked'),
      episode: policyEpisode(episode),
    });
    if (preflight.privacyPaused) {
      await this.cleanupEpisodeEvidence(packet.userId, episode, packet.capturedAt, true);
      return this.remember(packet.userId, { status: 'privacy_paused', reasonCodes: preflight.reasonCodes, episodeId: episode.episodeId });
    }
    if (preflight.action === 'defer') {
      return this.remember(packet.userId, { status: 'deferred', reasonCodes: preflight.reasonCodes, episodeId: episode.episodeId, retryAfterMs: 5_000 });
    }

    let observation: WornOutfitObservation;
    try {
      observation = await this.options.observationProvider.analyze({ packet });
    } catch (error) {
      return this.remember(packet.userId, {
        status: 'unavailable',
        reasonCodes: ['OUTFIT_OBSERVATION_FAILED', safeErrorCode(error)],
        episodeId: episode.episodeId,
        retryAfterMs: 10_000,
      });
    }
    const gatedObservation = gateWornGarmentObservation(observation);
    observation = gatedObservation.observation;
    const observationGateReasonCodes = gatedObservation.reasonCodes;

    if (observation.personCount === 0) {
      episode = { ...episode, status: 'ended', endedAt: observation.analyzedAt, lastObservationId: observation.observationId, lastObservedAt: observation.analyzedAt };
      await this.options.repository.upsertEpisode(packet.userId, episode);
      await this.cleanupEpisodeEvidence(packet.userId, episode, observation.analyzedAt, true);
      return this.remember(packet.userId, {
        status: 'episode_ended',
        reasonCodes: ['NO_PERSON_PRESENT'],
        episodeId: episode.episodeId,
        observationId: observation.observationId,
        retryAfterMs: 10_000,
      });
    }

    const observedEnvelope = decideMirrorSituation({
      observation: situationObservation(packet, episode, observation, 'not_checked'),
      episode: policyEpisode(episode),
    });
    if (observedEnvelope.privacyPaused) {
      episode = {
        ...episode,
        status: 'ended',
        endedAt: observation.analyzedAt,
        lastObservationId: observation.observationId,
        lastObservedAt: observation.analyzedAt,
      };
      await this.options.repository.upsertEpisode(packet.userId, episode);
      await this.cleanupEpisodeEvidence(packet.userId, episode, observation.analyzedAt, true);
      return this.remember(packet.userId, {
        status: 'privacy_paused',
        reasonCodes: observedEnvelope.reasonCodes,
        episodeId: episode.episodeId,
        observationId: observation.observationId,
      });
    }

    const reliable = reliableObservation(observation);
    let garmentTracks = reliable
      ? updateGarmentTracks(episode.garmentTracks ?? [], observation)
      : [];
    const tracksStable = reliable && observation.garments.every((garment) =>
      garmentTracks.some((track) =>
        track.slot === garment.slot &&
        track.category === garment.category &&
        track.consecutiveMatches >= 2
      )
    );
    episode = {
      ...episode,
      status: reliable && tracksStable && episode.consecutiveReliableObservations + 1 >= 2 ? 'stable' : 'observing',
      consecutiveReliableObservations: reliable ? episode.consecutiveReliableObservations + 1 : 0,
      lastObservationId: observation.observationId,
      lastObservedAt: observation.analyzedAt,
      lastFrameId: packet.frameId,
      garmentTracks,
    };

    if (!reliable) {
      await this.options.repository.upsertEpisode(packet.userId, episode);
      return this.remember(packet.userId, {
        status: 'insufficient_evidence',
        reasonCodes: [...observationGateReasonCodes, ...observationReasonCodes(observation)],
        episodeId: episode.episodeId,
        observationId: observation.observationId,
        retryAfterMs: 4_000,
      });
    }

    const confirmationBlocker = state.pendingIdentityResolutions.find((resolution) =>
      (resolution.episodeId === episode.episodeId && resolution.state === 'pending_confirmation') ||
      (resolution.state === 'deferred_until_next_episode' && resolution.automaticRecheckCount >= 1 &&
        observation.garments.some((garment) =>
          resolution.slot === garment.slot && resolution.category === garment.category)));
    if (confirmationBlocker) {
      await this.options.repository.upsertEpisode(packet.userId, episode);
      return this.remember(packet.userId, {
        status: 'ambiguous',
        reasonCodes: ['PENDING_IDENTITY_CONFIRMATION_REQUIRED', ...confirmationBlocker.ambiguityReasonCodes],
        episodeId: episode.episodeId,
        observationId: observation.observationId,
        retryAfterMs: 30_000,
      });
    }

    let capturedTrackAssets: GarmentImageAsset[] = [];
    let evictedTrackAssets: GarmentImageAsset[] = [];
    try {
      const capture = await this.captureTrackIdentityEvidence(packet, observation, garmentTracks, state.assets);
      garmentTracks = capture.tracks;
      capturedTrackAssets = capture.capturedAssets;
      evictedTrackAssets = capture.evictedAssets;
      episode = { ...episode, garmentTracks };
      await this.options.repository.persistTrackEvidence(
        packet.userId,
        episode,
        capturedTrackAssets,
        evictedTrackAssets.map((asset) => asset.assetId),
      );
      await this.options.assetService.deleteAssets(evictedTrackAssets);
      if (episode.status !== 'stable') {
        await this.retainDiagnosticCapture(packet, episode, observation, undefined, capturedTrackAssets);
      }
    } catch (error) {
      await this.options.assetService.deleteAssets(capturedTrackAssets);
      await this.options.repository.upsertEpisode(packet.userId, episode);
      return this.remember(packet.userId, {
        status: 'insufficient_evidence',
        reasonCodes: [...observationGateReasonCodes, 'GARMENT_TRACK_EVIDENCE_CROP_FAILED', safeErrorCode(error)],
        episodeId: episode.episodeId,
        observationId: observation.observationId,
        retryAfterMs: 5_000,
      });
    }

    if (episode.status !== 'stable') {
      return this.remember(packet.userId, {
        status: 'observing',
        reasonCodes: [...observationGateReasonCodes, 'EPISODE_REQUIRES_SECOND_RELIABLE_OBSERVATION'],
        episodeId: episode.episodeId,
        observationId: observation.observationId,
        retryAfterMs: 2_500,
      });
    }

    let evidenceAsset: GarmentImageAsset | undefined;
    let appearanceAssets: GarmentImageAsset[] = [];
    try {
      evidenceAsset = await this.options.assetService.storeEvidence({
        userId: packet.userId,
        sourceFramePath: packet.imagePath,
        sourceFrameId: packet.frameId,
        capturedAt: packet.capturedAt,
      });
      const trackState = await this.options.repository.getState(packet.userId);
      appearanceAssets = observation.garments.map((garment) => {
        const track = findTrackForGarment(garmentTracks, garment);
        const latestEvidence = track?.identityEvidence.at(-1);
        const asset = latestEvidence
          ? trackState.assets.find((entry) => entry.assetId === latestEvidence.assetId)
          : undefined;
        if (!asset) throw new Error('TRACK_IDENTITY_EVIDENCE_MISSING');
        return { ...asset, role: 'garment_appearance' as const };
      });
    } catch (error) {
      await this.retainDiagnosticCapture(packet, episode, observation, evidenceAsset, appearanceAssets);
      await this.options.assetService.deleteAssets([...(evidenceAsset ? [evidenceAsset] : [])]);
      return this.remember(packet.userId, {
        status: 'insufficient_evidence',
        reasonCodes: [...observationGateReasonCodes, 'GARMENT_CROP_FAILED', safeErrorCode(error)],
        episodeId: episode.episodeId,
        observationId: observation.observationId,
        retryAfterMs: 5_000,
      });
    }

    await this.retainDiagnosticCapture(packet, episode, observation, evidenceAsset, appearanceAssets);

    const freshState = await this.options.repository.getState(packet.userId);
    const baseCatalogAssets = await this.options.baseCatalogAssets?.() ?? new Map<string, GarmentImageAsset>();
    const currentAppearanceGroups = observation.garments.map((garment) => {
      const track = findTrackForGarment(garmentTracks, garment);
      return (track?.identityEvidence ?? []).flatMap((evidence) => {
        const asset = freshState.assets.find((entry) => entry.assetId === evidence.assetId);
        return asset ? [asset] : [];
      }).slice(-2);
    });
    if (currentAppearanceGroups.some((group) => group.length === 0)) {
      await this.options.assetService.deleteAssets([evidenceAsset]);
      return this.remember(packet.userId, {
        status: 'insufficient_evidence',
        reasonCodes: ['TRACK_IDENTITY_EVIDENCE_MISSING'],
        episodeId: episode.episodeId,
        observationId: observation.observationId,
        retryAfterMs: 5_000,
      });
    }
    const awaiting = freshState.pendingIdentityResolutions.filter((resolution) =>
      resolution.episodeId === episode.episodeId && resolution.state === 'awaiting_evidence');
    if (awaiting.length && awaiting.every((resolution) => !hasNewEvidenceContent(
      resolution,
      state.assets,
      freshState.assets,
      garmentTracks.find((track) => track.trackId === resolution.trackId),
    ))) {
      for (const resolution of awaiting) {
        await this.options.repository.upsertPendingIdentityResolution(packet.userId, {
          ...resolution,
          state: 'pending_confirmation',
          updatedAt: packet.capturedAt,
          ambiguityReasonCodes: [...new Set([...resolution.ambiguityReasonCodes, 'AUTOMATIC_RECHECK_REQUIRES_NEW_EVIDENCE'])],
        });
      }
      await this.options.assetService.deleteAssets([evidenceAsset]);
      return this.remember(packet.userId, {
        status: 'ambiguous',
        reasonCodes: ['AUTOMATIC_RECHECK_REQUIRES_NEW_EVIDENCE', 'PENDING_IDENTITY_CONFIRMATION_REQUIRED'],
        episodeId: episode.episodeId,
        observationId: observation.observationId,
        retryAfterMs: 30_000,
      });
    }
    const identities = await Promise.all(observation.garments.map((garment, index) => this.options.identityProvider.resolve({
      userId: packet.userId,
      episodeId: episode.episodeId,
      capturedAt: packet.capturedAt,
      garment,
      currentAppearances: currentAppearanceGroups[index]!,
      baseClosetItems: this.options.baseClosetItems(),
      userClosetItems: freshState.closetItems,
      appearances: freshState.appearances,
      assets: freshState.assets,
      captures: freshState.captures,
      wearEvents: freshState.wearEvents,
      baseCatalogAssets,
    })));
    const resolvedPendingIds: string[] = [];
    for (const [index, identity] of identities.entries()) {
      const garment = observation.garments[index];
      if (!garment) continue;
      const track = findTrackForGarment(garmentTracks, garment);
      const pending = track
        ? findPendingResolutionForTrack(freshState.pendingIdentityResolutions, episode.episodeId, track)
        : undefined;
      if (!pending) continue;
      const hasNewEvidence = hasNewEvidenceContent(pending, state.assets, freshState.assets, track);
      if (identity.decisionTrace) {
        identity.decisionTrace.pendingResolutionId = pending.resolutionId;
        identity.decisionTrace.automaticRecheckCount = pending.state !== 'pending_confirmation' && hasNewEvidence
          ? Math.min(1, pending.automaticRecheckCount + 1)
          : pending.automaticRecheckCount;
      }
      if (identity.status !== 'ambiguous' && identity.status !== 'insufficient_evidence') {
        resolvedPendingIds.push(pending.resolutionId);
      }
    }
    await this.options.repository.removePendingIdentityResolutions(packet.userId, resolvedPendingIds);
    const unresolved = identities.filter((identity) => identity.status === 'ambiguous' || identity.status === 'insufficient_evidence');
    if (unresolved.length) {
      const pendingStates = await this.persistPendingIdentityResolutions({
        packet,
        episode,
        observation,
        tracks: garmentTracks,
        identities,
        existing: freshState.pendingIdentityResolutions,
        previousAssets: state.assets,
        currentAssets: freshState.assets,
      });
      await this.options.repository.appendIdentityDecisionTraces(
        packet.userId,
        identities.flatMap((identity) => identity.decisionTrace ? [identity.decisionTrace] : []),
        this.options.identityTraceLimit ?? 200,
      );
      await this.options.assetService.deleteAssets([evidenceAsset]);
      return this.remember(packet.userId, {
        status: unresolved.some((item) => item.status === 'ambiguous') ? 'ambiguous' : 'insufficient_evidence',
        reasonCodes: [
          ...observationGateReasonCodes,
          ...unresolved.flatMap((item) => item.reasonCodes),
          ...pendingStates.map((pending) => pending.state === 'awaiting_evidence'
            ? 'PENDING_IDENTITY_AWAITING_NEW_EVIDENCE'
            : 'PENDING_IDENTITY_CONFIRMATION_REQUIRED'),
        ],
        episodeId: episode.episodeId,
        observationId: observation.observationId,
        retryAfterMs: pendingStates.some((pending) => pending.state === 'awaiting_evidence') ? 2_500 : 30_000,
      });
    }

    await this.options.repository.appendIdentityDecisionTraces(
      packet.userId,
      identities.flatMap((identity) => identity.decisionTrace ? [identity.decisionTrace] : []),
      this.options.identityTraceLimit ?? 200,
    );

    const hasNew = identities.some((identity) => identity.status === 'new_to_closet');
    const postflight = decideMirrorSituation({
      observation: situationObservation(packet, episode, observation, hasNew ? 'unmatched' : 'matched'),
      episode: policyEpisode(episode),
    });
    const eligible = hasNew
      ? postflight.eligibility.garmentCandidate === 'eligible' && postflight.eligibility.closetPersistence === 'eligible'
      : postflight.eligibility.wearRecord === 'eligible';
    if (!eligible) {
      await this.options.assetService.deleteAssets([evidenceAsset]);
      await this.cleanupEpisodeEvidence(packet.userId, episode, observation.analyzedAt, true);
      return this.remember(packet.userId, {
        status: postflight.privacyPaused ? 'privacy_paused' : postflight.action === 'defer' ? 'deferred' : 'insufficient_evidence',
        reasonCodes: postflight.reasonCodes,
        episodeId: episode.episodeId,
        observationId: observation.observationId,
      });
    }

    const proposal = buildProposal({ packet, episode, observation, identities, state: freshState, evidenceAsset, appearanceAssets });
    let committed: Awaited<ReturnType<JsonUserWardrobeRepository['commitCapture']>>;
    try {
      committed = await this.options.repository.commitCapture({ proposal });
    } catch (error) {
      await this.options.assetService.deleteAssets([evidenceAsset]);
      await this.cleanupEpisodeEvidence(packet.userId, episode, observation.analyzedAt, true);
      throw error;
    }
    if (committed.status === 'already_committed') {
      await this.options.assetService.deleteAssets([evidenceAsset]);
    }
    await this.cleanupEpisodeEvidence(packet.userId, episode, observation.analyzedAt, false);
    if (committed.status === 'committed' && committed.createdClosetItemIds.length) {
      const processing: AmbientCaptureOutcome = {
        status: 'committed_processing_images',
        reasonCodes: [...observationGateReasonCodes, 'CAPTURE_COMMITTED', 'CATALOG_IMAGES_PROCESSING'],
        episodeId: episode.episodeId,
        observationId: observation.observationId,
        retryAfterMs: 4_000,
      };
      this.remember(packet.userId, processing);
      void this.processCatalogImages(proposal, committed, observation).catch((error) => {
        this.remember(packet.userId, {
          status: 'image_needs_review',
          reasonCodes: ['CATALOG_IMAGE_STAGE_FAILED', safeErrorCode(error)],
          episodeId: episode.episodeId,
          observationId: observation.observationId,
          retryAfterMs: 15_000,
        });
      });
      return processing;
    }
    const completedEvent = committed.status === 'committed'
      ? completedEventFromCommit(proposal, committed, observation, await this.options.repository.getState(packet.userId), this.options.baseClosetItems())
      : undefined;
    if (completedEvent) await this.options.repository.setPendingCompletionEvent(packet.userId, completedEvent);
    const status: AmbientCaptureOutcome['status'] = committed.status === 'already_committed' ? 'already_committed' : 'recognized';
    return this.remember(packet.userId, {
      status,
      reasonCodes: [
        ...observationGateReasonCodes,
        committed.createdClosetItemIds.length ? 'NEW_GARMENTS_COMMITTED' : 'KNOWN_GARMENTS_RECOGNIZED',
        proposal.repeatedOutfit ? 'REPEATED_OUTFIT_SIGNATURE' : 'NEW_OUTFIT_SIGNATURE',
      ],
      episodeId: episode.episodeId,
      observationId: observation.observationId,
      completedEvent,
      retryAfterMs: 12_000,
    });
  }

  async endEpisode(userId: string, sessionId: string, occurredAt?: string): Promise<AmbientCaptureOutcome> {
    return this.exclusive(userId, async () => {
      const ended = await this.options.repository.endActiveEpisode(userId, sessionId, occurredAt);
      if (ended) await this.cleanupEpisodeEvidence(userId, ended, occurredAt ?? new Date().toISOString(), true);
      return this.remember(userId, {
        status: 'episode_ended',
        reasonCodes: [ended ? 'EPISODE_ENDED' : 'NO_ACTIVE_EPISODE'],
        episodeId: ended?.episodeId,
      });
    });
  }

  async acknowledge(userId: string): Promise<boolean> {
    return this.options.repository.acknowledgeCompletion(userId);
  }

  async retryProductImage(userId: string, closetItemId: string): Promise<AmbientCaptureOutcome> {
    return this.exclusive(userId, () => this.retryProductImageLocked(userId, closetItemId));
  }

  async backfillProductImages(userId: string): Promise<AmbientProductImageBackfillResult> {
    return this.exclusive(userId, async () => {
      const state = await this.options.repository.getState(userId);
      const eligibleItemIds = state.closetItems
        .filter((entry) => entry.status === 'active' &&
          entry.item.identityStatus !== 'merged' &&
          entry.item.source === 'mirror_auto_capture' &&
          entry.item.imageStatus !== 'ready' &&
          entry.item.imageStatus !== 'processing')
        .map((entry) => entry.item.id);
      const attemptedItemIds = eligibleItemIds.slice(0, 8);
      const skippedItemIds = eligibleItemIds.slice(8);
      const readyItemIds: string[] = [];
      const needsReviewItemIds: string[] = [];

      for (const closetItemId of attemptedItemIds) {
        const outcome = await this.retryProductImageLocked(userId, closetItemId);
        if (outcome.status === 'ready') readyItemIds.push(closetItemId);
        else needsReviewItemIds.push(closetItemId);
      }

      this.remember(userId, {
        status: needsReviewItemIds.length ? 'image_needs_review' : readyItemIds.length ? 'ready' : 'unavailable',
        reasonCodes: needsReviewItemIds.length
          ? ['PRODUCT_IMAGE_BACKFILL_PARTIAL', 'CATALOG_IMAGE_NEEDS_REVIEW']
          : readyItemIds.length
            ? ['PRODUCT_IMAGE_BACKFILL_COMPLETED', 'CATALOG_IMAGES_VERIFIED']
            : ['PRODUCT_IMAGE_BACKFILL_EMPTY'],
      });
      return { attemptedItemIds, readyItemIds, needsReviewItemIds, skippedItemIds };
    });
  }

  async resetUser(userId: string): Promise<void> {
    await this.exclusive(userId, async () => {
      const state = await this.options.repository.getState(userId);
      await this.options.repository.resetUser(userId);
      await this.options.assetService.deleteAssets(state.assets);
      this.lastOutcomes.delete(userId);
    });
  }

  async diagnostics(userId: string): Promise<AmbientCaptureDiagnostics> {
    const state = await this.options.repository.getState(userId);
    const diagnosticCaptures = this.options.retainDiagnosticCaptures
      ? await this.options.assetService.listDiagnosticCaptures(userId, this.options.diagnosticCaptureLimit ?? 100)
      : [];
    const latestDiagnosticCapture = diagnosticCaptures[0];
    return {
      enabled: true,
      providerReady: this.options.observationProvider.ready,
      identityVerifierReady: this.options.identityProvider.ready ?? true,
      productImageProviderReady: this.options.productImageProvider.ready,
      productImageVerifierReady: this.options.productImageVerifier.ready,
      grantActive: activeGrant(state.grant),
      currentEpisode: [...state.episodes].reverse().find((episode) => episode.status !== 'ended'),
      closetItemCount: state.closetItems.filter((entry) => entry.status === 'active' && entry.item.identityStatus !== 'merged').length,
      captureCount: state.captures.length,
      wearEventCount: state.wearEvents.length,
      assetCounts: {
        capture_evidence: state.assets.filter((asset) => asset.role === 'capture_evidence').length,
        track_identity_evidence: state.assets.filter((asset) => asset.role === 'track_identity_evidence').length,
        garment_appearance: state.assets.filter((asset) => asset.role === 'garment_appearance').length,
        canonical_product: state.assets.filter((asset) => asset.role === 'canonical_product').length,
      },
      processingImageCount: state.closetItems.filter((entry) => entry.status === 'active' && entry.item.imageStatus === 'processing').length,
      needsReviewImageCount: state.closetItems.filter((entry) => entry.status === 'active' &&
        (entry.item.imageStatus === 'needs_review' || entry.item.imageStatus === 'failed')).length,
      diagnosticCaptureRetentionEnabled: Boolean(this.options.retainDiagnosticCaptures),
      diagnosticCaptureCount: diagnosticCaptures.length,
      latestDiagnosticCapture: latestDiagnosticCapture ? {
        bundleId: latestDiagnosticCapture.bundleId,
        relativeDirectory: latestDiagnosticCapture.relativeDirectory,
        frameId: latestDiagnosticCapture.frameId,
        observationId: latestDiagnosticCapture.observationId,
        createdAt: latestDiagnosticCapture.createdAt,
      } : undefined,
      lastOutcome: this.lastOutcomes.get(userId),
    };
  }

  private async retainDiagnosticCapture(
    packet: AmbientCapturePacket,
    episode: AmbientOutfitEpisode,
    observation: WornOutfitObservation,
    evidenceAsset: GarmentImageAsset | undefined,
    appearanceAssets: GarmentImageAsset[],
  ): Promise<void> {
    if (!this.options.retainDiagnosticCaptures) return;
    try {
      const bundle = await this.options.assetService.storeDiagnosticCapture({
        userId: packet.userId,
        episodeId: episode.episodeId,
        observationId: observation.observationId,
        frameId: packet.frameId,
        capturedAt: packet.capturedAt,
        evidenceAsset,
        appearanceAssets,
        garments: observation.garments,
        retentionLimit: this.options.diagnosticCaptureLimit ?? 100,
      });
      if (bundle) {
        console.info('[AmbientCaptureDiagnostic]', {
          bundleId: bundle.bundleId,
          relativeDirectory: bundle.relativeDirectory,
          frameId: bundle.frameId,
          observationId: bundle.observationId,
          assetIds: bundle.assetIds,
        });
      }
    } catch (error) {
      console.warn('[AmbientCaptureDiagnostic]', {
        status: 'failed',
        frameId: packet.frameId,
        observationId: observation.observationId,
        code: safeErrorCode(error),
      });
    }
  }

  private async captureTrackIdentityEvidence(
    packet: AmbientCapturePacket,
    observation: WornOutfitObservation,
    tracks: AmbientGarmentTrack[],
    existingAssets: GarmentImageAsset[],
  ): Promise<{
    tracks: AmbientGarmentTrack[];
    capturedAssets: GarmentImageAsset[];
    evictedAssets: GarmentImageAsset[];
  }> {
    const settled = await Promise.allSettled(observation.garments.map(async (garment) => ({
      garment,
      asset: (await this.options.assetService.cropGarment({
        userId: packet.userId,
        sourceFramePath: packet.imagePath,
        sourceFrameId: packet.frameId,
        observationItemId: garment.observationItemId,
        boundingBox: garment.boundingBox,
        slot: garment.slot,
        role: 'track_identity_evidence',
        capturedAt: packet.capturedAt,
      })).asset,
    })));
    const capturedAssets = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value.asset] : []);
    const failure = settled.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') {
      await this.options.assetService.deleteAssets(capturedAssets);
      throw failure.reason;
    }
    const byObservationItem = new Map(settled.flatMap((result) =>
      result.status === 'fulfilled' ? [[result.value.garment.observationItemId, result.value.asset] as const] : []));
    const evictedIds = new Set<string>();
    const updatedTracks = tracks.map((track) => {
      const garment = observation.garments.find((entry) =>
        entry.slot === track.slot && entry.category === track.category);
      const asset = garment ? byObservationItem.get(garment.observationItemId) : undefined;
      if (!garment || !asset) return track;
      const evidence = [
        ...(track.identityEvidence ?? []),
        {
          observationId: observation.observationId,
          frameId: packet.frameId,
          assetId: asset.assetId,
          capturedAt: packet.capturedAt,
          descriptor: descriptorFromObservation(garment),
          qualityScore: garment.confidence,
        },
      ].filter((entry, index, all) => all.findIndex((candidate) => candidate.assetId === entry.assetId) === index);
      const maxEvidenceCount = track.maxEvidenceCount || 2;
      for (const evicted of evidence.slice(0, Math.max(0, evidence.length - maxEvidenceCount))) evictedIds.add(evicted.assetId);
      return { ...track, identityEvidence: evidence.slice(-maxEvidenceCount), maxEvidenceCount };
    });
    return {
      tracks: updatedTracks,
      capturedAssets,
      evictedAssets: existingAssets.filter((asset) => evictedIds.has(asset.assetId)),
    };
  }

  private async persistPendingIdentityResolutions(input: {
    packet: AmbientCapturePacket;
    episode: AmbientOutfitEpisode;
    observation: WornOutfitObservation;
    tracks: AmbientGarmentTrack[];
    identities: Awaited<ReturnType<GarmentIdentityProvider['resolve']>>[];
    existing: PendingIdentityResolution[];
    previousAssets: GarmentImageAsset[];
    currentAssets: GarmentImageAsset[];
  }): Promise<PendingIdentityResolution[]> {
    const pending: PendingIdentityResolution[] = [];
    for (const [index, identity] of input.identities.entries()) {
      if (identity.status !== 'ambiguous' && identity.status !== 'insufficient_evidence') continue;
      const garment = input.observation.garments[index]!;
      const track = findTrackForGarment(input.tracks, garment);
      if (!track) continue;
      const existing = findPendingResolutionForTrack(input.existing, input.episode.episodeId, track);
      const currentEvidenceAssetIds = track.identityEvidence.map((entry) => entry.assetId);
      const hasNewEvidence = existing
        ? hasNewEvidenceContent(existing, input.previousAssets, input.currentAssets, track)
        : false;
      const automaticRecheckCount = existing && existing.state !== 'pending_confirmation' && hasNewEvidence
        ? Math.min(1, existing.automaticRecheckCount + 1)
        : existing?.automaticRecheckCount ?? 0;
      const trace = identity.decisionTrace;
      const occludedFeatures = [...new Set(trace?.pairwiseVerifications.flatMap((verification) => [
        ...verification.normalizedResult.occlusions,
        ...verification.normalizedResult.featureComparisons
          .filter((comparison) => comparison.currentVisibility !== 'visible' || comparison.referenceVisibility !== 'visible')
          .map((comparison) => comparison.feature),
      ]) ?? [])];
      const resolutionId = existing?.resolutionId ?? makeId('pending_identity');
      const state: PendingIdentityResolution['state'] = existing
        ? 'pending_confirmation'
        : occludedFeatures.length > 0 ? 'awaiting_evidence' : 'pending_confirmation';
      const now = input.packet.capturedAt;
      const resolution: PendingIdentityResolution = {
        resolutionId,
        userId: input.packet.userId,
        episodeId: input.episode.episodeId,
        trackId: track.trackId,
        observationItemId: garment.observationItemId,
        slot: garment.slot,
        category: garment.category,
        currentEvidenceAssetIds,
        candidateClosetItemIds: identity.candidateItemIds,
        ambiguityReasonCodes: identity.reasonCodes,
        occludedFeatures,
        automaticRecheckCount,
        state,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        deadlineAt: new Date(Date.parse(now) + 5 * 60_000).toISOString(),
      };
      if (trace) {
        trace.pendingResolutionId = resolutionId;
        trace.automaticRecheckCount = automaticRecheckCount;
      }
      await this.options.repository.upsertPendingIdentityResolution(input.packet.userId, resolution);
      pending.push(resolution);
    }
    return pending;
  }

  private async cleanupEpisodeEvidence(
    userId: string,
    episode: AmbientOutfitEpisode,
    occurredAt: string,
    deferPending: boolean,
  ): Promise<void> {
    const assets = await this.options.repository.cleanupEpisodeIdentityEvidence(
      userId,
      episode.episodeId,
      occurredAt,
      deferPending,
    );
    await this.options.assetService.deleteAssets(assets);
  }

  private async processCatalogImages(
    proposal: OutfitCaptureProposal,
    committed: Awaited<ReturnType<JsonUserWardrobeRepository['commitCapture']>>,
    observation: WornOutfitObservation,
  ): Promise<void> {
    let failed = false;
    for (const closetItemId of committed.createdClosetItemIds) {
      const proposalItem = proposal.items.find((item) => item.resolvedClosetItemId === closetItemId);
      if (!proposalItem) continue;
      const job = await this.options.repository.beginProductImageJob(proposal.userId, closetItemId, proposalItem.appearanceAsset.assetId);
      if (job.status === 'ready') continue;
      if (!this.options.productImageProvider.ready || !this.options.productImageVerifier.ready) {
        failed = true;
        await this.options.repository.failProductImageJob(proposal.userId, job.jobId, 'PRODUCT_IMAGE_PIPELINE_UNAVAILABLE');
        continue;
      }
      let generatedAsset: GarmentImageAsset | undefined;
      try {
        const generated = await this.options.productImageProvider.createCanonicalProductImage({
          userId: proposal.userId,
          closetItemId,
          sourceAppearance: proposalItem.appearanceAsset,
          item: {
            category: proposalItem.observation.category,
            color: proposalItem.observation.dominantColor,
            slot: proposalItem.observation.slot,
            description: proposalItem.observation.description,
          },
        });
        generatedAsset = generated.asset;
        const verification = await this.options.productImageVerifier.verify({
          sourceAppearance: proposalItem.appearanceAsset,
          generatedProductImage: generated.asset,
          category: proposalItem.observation.category,
        });
        const completed = await this.options.repository.completeProductImageJob({
          userId: proposal.userId,
          jobId: job.jobId,
          productAsset: generated.asset,
          verification,
          threshold: this.options.productImageVerifyConfidence ?? 0.84,
        });
        failed ||= !completed.ready;
      } catch (error) {
        if (generatedAsset) await this.options.assetService.deleteAssets([generatedAsset]);
        failed = true;
        await this.options.repository.failProductImageJob(proposal.userId, job.jobId, safeErrorCode(error));
      }
    }
    const state = await this.options.repository.getState(proposal.userId);
    if (failed) {
      this.remember(proposal.userId, {
        status: 'image_needs_review',
        reasonCodes: ['CAPTURE_RECORDED', 'CATALOG_IMAGE_NEEDS_REVIEW'],
        episodeId: proposal.episodeId,
        observationId: proposal.observation.observationId,
        retryAfterMs: 15_000,
      });
      return;
    }
    const completedEvent = completedEventFromCommit(proposal, committed, observation, state, this.options.baseClosetItems());
    await this.options.repository.setPendingCompletionEvent(proposal.userId, completedEvent);
    this.remember(proposal.userId, {
      status: committed.recognizedClosetItemIds.length ? 'mixed_ready' : 'ready',
      reasonCodes: ['CATALOG_IMAGES_VERIFIED', committed.recognizedClosetItemIds.length ? 'MIXED_OUTFIT_READY' : 'ALL_NEW_OUTFIT_READY'],
      episodeId: proposal.episodeId,
      observationId: proposal.observation.observationId,
      completedEvent,
      retryAfterMs: 12_000,
    });
  }

  private async retryProductImageLocked(userId: string, requestedClosetItemId: string): Promise<AmbientCaptureOutcome> {
    const closetItemId = await this.options.repository.resolveClosetItemId(userId, requestedClosetItemId);
    const state = await this.options.repository.getState(userId);
    const entry = state.closetItems.find((item) => item.item.id === closetItemId && item.status === 'active');
    const appearance = [...state.appearances].reverse().find((item) => item.closetItemId === closetItemId);
    const sourceAsset = appearance ? state.assets.find((asset) => asset.assetId === appearance.appearanceAssetId) : undefined;
    if (!entry || entry.item.source !== 'mirror_auto_capture' || !sourceAsset) {
      return this.remember(userId, { status: 'unavailable', reasonCodes: ['RETRY_ITEM_OR_APPEARANCE_NOT_FOUND'] });
    }
    if (entry.item.imageStatus === 'ready') {
      return this.remember(userId, { status: 'ready', reasonCodes: ['CATALOG_IMAGE_ALREADY_READY'] });
    }
    if (!this.options.productImageProvider.ready || !this.options.productImageVerifier.ready) {
      return this.remember(userId, { status: 'unavailable', reasonCodes: ['PRODUCT_IMAGE_PIPELINE_UNAVAILABLE'] });
    }
    const job = await this.options.repository.beginProductImageJob(userId, closetItemId, sourceAsset.assetId);
    let generatedAsset: GarmentImageAsset | undefined;
    try {
      const generated = await this.options.productImageProvider.createCanonicalProductImage({
        userId,
        closetItemId,
        sourceAppearance: sourceAsset,
        item: {
          category: entry.item.category,
          color: entry.item.color,
          slot: entry.item.category === 'jumpsuit' ? 'dress' : entry.item.category,
          description: entry.item.name,
        },
      });
      generatedAsset = generated.asset;
      const verification = await this.options.productImageVerifier.verify({
        sourceAppearance: sourceAsset,
        generatedProductImage: generated.asset,
        category: entry.item.category,
      });
      const completed = await this.options.repository.completeProductImageJob({
        userId, jobId: job.jobId, productAsset: generated.asset, verification,
        threshold: this.options.productImageVerifyConfidence ?? 0.84,
      });
      return this.remember(userId, {
        status: completed.ready ? 'ready' : 'image_needs_review',
        reasonCodes: [completed.ready ? 'CATALOG_IMAGE_VERIFIED' : 'CATALOG_IMAGE_NEEDS_REVIEW'],
      });
    } catch (error) {
      if (generatedAsset) await this.options.assetService.deleteAssets([generatedAsset]);
      await this.options.repository.failProductImageJob(userId, job.jobId, safeErrorCode(error));
      return this.remember(userId, { status: 'image_needs_review', reasonCodes: ['PRODUCT_IMAGE_RETRY_FAILED', safeErrorCode(error)] });
    }
  }

  private remember(userId: string, outcome: AmbientCaptureOutcome): AmbientCaptureOutcome {
    this.lastOutcomes.set(userId, outcome);
    return outcome;
  }

  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.then(() => gate);
    this.operations.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.operations.get(key) === current) this.operations.delete(key);
    }
  }
}

function activeGrant(grant: { revokedAt?: string } | undefined): boolean {
  return Boolean(grant && !grant.revokedAt);
}

function validStability(packet: AmbientCapturePacket): boolean {
  return packet.stability.stableSamples >= 3 && packet.stability.score >= 0.9 && packet.stability.sourceWidth >= 640 && packet.stability.sourceHeight >= 480;
}

function newEpisode(packet: AmbientCapturePacket): AmbientOutfitEpisode {
  return {
    episodeId: makeId('ambient_episode'),
    sessionId: packet.sessionId,
    status: 'observing',
    startedAt: packet.capturedAt,
    consecutiveReliableObservations: 0,
    garmentTracks: [],
  };
}

function currentEpisode(episodes: AmbientOutfitEpisode[], sessionId: string): AmbientOutfitEpisode | undefined {
  return [...episodes].reverse().find((episode) => episode.sessionId === sessionId && episode.status !== 'ended');
}

function reliableObservation(observation: WornOutfitObservation): boolean {
  return observation.personCount === 1 &&
    observation.quality === 'good' &&
    (observation.coverage === 'three_quarter' || observation.coverage === 'full_body') &&
    observation.garments.length > 0 &&
    observation.garments.every((garment) => garment.confidence >= 0.72);
}

export function gateWornGarmentObservation(observation: WornOutfitObservation): {
  observation: WornOutfitObservation;
  reasonCodes: string[];
} {
  const reasonCodes: string[] = [];
  const garments = observation.garments.filter((garment) => {
    if (garment.visibleFraction === 'barely') {
      reasonCodes.push('SLOT_DROPPED_BARELY_VISIBLE');
      return false;
    }
    const box = garment.boundingBox;
    const boxIsSubstantial = box.width >= 0.05 && box.height >= 0.05 && box.width * box.height >= 0.008;
    if (!boxIsSubstantial) {
      reasonCodes.push('SLOT_DROPPED_INVALID_VISIBLE_REGION');
      return false;
    }
    if ((observation.coverage === 'none' || observation.coverage === 'head_shoulders') &&
        garment.slot !== 'top' && garment.slot !== 'outerwear' && garment.slot !== 'accessory') {
      reasonCodes.push('SLOT_DROPPED_OUTSIDE_COVERAGE');
      return false;
    }
    if (observation.coverage === 'upper_body' && (garment.slot === 'bottom' || garment.slot === 'shoes')) {
      reasonCodes.push('SLOT_DROPPED_OUTSIDE_COVERAGE');
      return false;
    }
    return true;
  });
  return {
    observation: garments.length === observation.garments.length ? observation : { ...observation, garments },
    reasonCodes: [...new Set(reasonCodes)],
  };
}

function updateGarmentTracks(
  previousTracks: AmbientGarmentTrack[],
  observation: WornOutfitObservation,
): AmbientGarmentTrack[] {
  return observation.garments.map((garment) => {
    const descriptor = descriptorFromObservation(garment);
    const fingerprint = appearanceFingerprint(descriptor);
    const previous = previousTracks.find((track) =>
      track.slot === garment.slot &&
      track.category === garment.category &&
      trackDescriptorSimilarity(track.descriptor, descriptor) >= TRACK_CONTINUITY_THRESHOLD
    );
    return {
      trackId: previous?.trackId ?? makeId('garment_track'),
      slot: garment.slot,
      category: garment.category,
      appearanceFingerprint: fingerprint,
      descriptor,
      firstObservationId: previous?.firstObservationId ?? observation.observationId,
      latestObservationId: observation.observationId,
      consecutiveMatches: previous ? previous.consecutiveMatches + 1 : 1,
      identityEvidence: previous?.identityEvidence ?? [],
      maxEvidenceCount: previous?.maxEvidenceCount ?? 2,
    };
  });
}

function findTrackForGarment(
  tracks: AmbientGarmentTrack[],
  garment: WornOutfitObservation['garments'][number],
): AmbientGarmentTrack | undefined {
  return tracks.find((track) => track.slot === garment.slot && track.category === garment.category);
}

function hasNewEvidenceContent(
  resolution: PendingIdentityResolution,
  previousAssets: GarmentImageAsset[],
  currentAssets: GarmentImageAsset[],
  track: AmbientGarmentTrack | undefined,
): boolean {
  if (!track) return false;
  const previousHashes = new Set(
    resolution.currentEvidenceAssetIds.flatMap((assetId) => {
      const asset = previousAssets.find((entry) => entry.assetId === assetId);
      return asset?.contentHash ? [asset.contentHash] : [];
    }),
  );
  return track.identityEvidence.some((evidence) => {
    const asset = currentAssets.find((entry) => entry.assetId === evidence.assetId);
    return Boolean(asset?.contentHash && !previousHashes.has(asset.contentHash));
  });
}

function findPendingResolutionForTrack(
  resolutions: PendingIdentityResolution[],
  episodeId: string,
  track: AmbientGarmentTrack,
): PendingIdentityResolution | undefined {
  return resolutions.find((entry) => entry.episodeId === episodeId && entry.trackId === track.trackId) ??
    resolutions.find((entry) =>
      entry.state === 'deferred_until_next_episode' &&
      entry.slot === track.slot &&
      entry.category === track.category);
}

export const TRACK_CONTINUITY_THRESHOLD = 0.7;
const NEIGHBOR_COLOR_WITHOUT_STRONG_EVIDENCE_CAP = TRACK_CONTINUITY_THRESHOLD - 0.01;

export function trackDescriptorSimilarity(
  left: AmbientGarmentTrack['descriptor'],
  right: AmbientGarmentTrack['descriptor'],
): number {
  if (left.slot !== right.slot || left.category !== right.category) return 0;
  if (hardAttributeExclusion(left, right)) return 0;
  let score = 0.35;
  const colorScore = colorSimilarity(left.dominantColor, right.dominantColor);
  score += 0.35 * colorScore;
  const pattern = canonicalizePattern(left.pattern);
  const samePattern = pattern === canonicalizePattern(right.pattern);
  if (samePattern) score += 0.1;
  if (left.fit !== 'unknown' && right.fit !== 'unknown' && left.fit === right.fit) score += 0.08;
  const silhouettesAreObservable = normalizeDescriptorToken(left.silhouette) !== 'unknown'
    && normalizeDescriptorToken(right.silhouette) !== 'unknown';
  const silhouetteOverlap = silhouettesAreObservable
    ? tokenOverlap(left.silhouette, right.silhouette)
    : 0;
  const distinctiveOverlap = arrayOverlap(left.distinctiveFeatures, right.distinctiveFeatures);
  if (silhouetteOverlap >= 0.5) score += 0.07;
  if (distinctiveOverlap >= 0.5) score += 0.05;

  const hasStrongEvidence = silhouetteOverlap >= 0.5 || distinctiveOverlap >= 0.5 || (
    samePattern && pattern !== 'solid' && pattern !== 'other'
  );
  if (colorScore > 0 && colorScore < 1 && !hasStrongEvidence) {
    return Math.min(score, NEIGHBOR_COLOR_WITHOUT_STRONG_EVIDENCE_CAP);
  }
  return Math.min(1, score);
}

function normalizeDescriptorToken(value: string): string {
  return value.trim().toLowerCase();
}

function tokenOverlap(left: string, right: string): number {
  return arrayOverlap(left.split(/\s+/).filter(Boolean), right.split(/\s+/).filter(Boolean));
}

function arrayOverlap(left: string[], right: string[]): number {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value)).length / Math.max(left.length, right.length);
}

function observationReasonCodes(observation: WornOutfitObservation): string[] {
  const reasons: string[] = [];
  if (observation.personCount !== 1) reasons.push(observation.personCount > 1 ? 'MULTIPLE_PEOPLE_PRESENT' : 'NO_PERSON_PRESENT');
  if (observation.quality !== 'good') reasons.push('OBSERVATION_QUALITY_INSUFFICIENT');
  if (observation.coverage !== 'three_quarter' && observation.coverage !== 'full_body') reasons.push('OUTFIT_COVERAGE_INSUFFICIENT');
  if (!observation.garments.length) reasons.push('NO_WORN_GARMENTS_FOUND');
  if (observation.garments.some((garment) => garment.confidence < 0.72)) reasons.push('GARMENT_CONFIDENCE_LOW');
  return reasons.length ? reasons : ['OBSERVATION_NOT_RELIABLE'];
}

function policyEpisode(episode: AmbientOutfitEpisode): OutfitEpisode {
  return {
    episodeId: episode.episodeId,
    status: episode.status === 'stable' || episode.status === 'captured' ? 'stable' : episode.status === 'ended' ? 'ended' : 'observing',
    startedAt: episode.startedAt,
    endedAt: episode.endedAt,
    observationIds: episode.lastObservationId ? [episode.lastObservationId] : [],
    latestObservationId: episode.lastObservationId,
    consecutiveReliableObservations: episode.consecutiveReliableObservations,
    latestGarmentPresentation: 'worn',
    ownership: 'confirmed_user_owned',
    ownershipQuestion: 'answered',
  };
}

function situationObservation(
  packet: AmbientCapturePacket,
  episode: AmbientOutfitEpisode,
  observation: WornOutfitObservation | undefined,
  closetMatch: MirrorSituationObservation['closetMatch'],
): MirrorSituationObservation {
  const coverage = observation?.coverage ?? 'three_quarter';
  return {
    observationId: observation?.observationId ?? `${packet.frameId}_preflight`,
    observedAt: observation?.analyzedAt ?? packet.capturedAt,
    personCount: observation?.personCount ?? 1,
    // Browser-scoped identity plus an explicit auto-record grant establishes
    // this narrow single-user demo context; no biometric identity is inferred.
    identity: 'known_user',
    activity: 'stationary',
    motion: 'still',
    garmentPresentation: 'worn',
    closetMatch,
    // The grant explicitly covers garments the browser user is wearing. It
    // never applies to held garments, guests, or multi-person frames.
    ownership: 'confirmed_user_owned',
    coverage,
    quality: observation?.quality ?? 'good',
    freshness: 'fresh',
    activeTask: packet.activeTask ? 'other' : 'none',
    privacyRisk: observation && observation.personCount > 1 ? 'multiple_people' : 'none',
    userAvailableForInterruption: true,
    permissions: { wearRecording: 'granted', closetPersistence: 'granted' },
    confidence: {
      situation: packet.stability.score,
      garment: observation ? Math.min(...observation.garments.map((item) => item.confidence)) : 0.8,
      identity: 1,
    },
  };
}

function buildProposal(args: {
  packet: AmbientCapturePacket;
  episode: AmbientOutfitEpisode;
  observation: WornOutfitObservation;
  identities: Awaited<ReturnType<GarmentIdentityProvider['resolve']>>[];
  state: Awaited<ReturnType<JsonUserWardrobeRepository['getState']>>;
  evidenceAsset: GarmentImageAsset;
  appearanceAssets: GarmentImageAsset[];
}): OutfitCaptureProposal {
  const items = args.observation.garments.map((observation, index) => {
    const identity = args.identities[index]!;
    const itemId = identity.matchedClosetItemId ?? `ambient_${createHash('sha256').update(`${args.packet.userId}:${identity.appearanceFingerprint}`).digest('hex').slice(0, 18)}`;
    const now = args.packet.capturedAt;
    const createItem: AmbientClosetItem | undefined = identity.status === 'new_to_closet'
      ? {
          item: {
            id: itemId,
            name: ambientItemName(observation),
            category: observation.category,
            color: observation.dominantColor,
            fit: observation.fit,
            formality: 'unknown',
            styleTags: unique([
              observation.pattern,
              observation.sleeve ?? 'unknown',
              observation.neckline ?? 'unknown',
              observation.lengthClass ?? 'unknown',
              observation.materialClass ?? 'unknown',
              observation.silhouette,
              ...observation.distinctiveFeatures,
            ]).filter((value) => value !== 'unknown'),
            imageUrl: '/agent-assets/wardrobe-processing.svg',
            appearanceAssetIds: [args.appearanceAssets[index]!.assetId],
            imageStatus: 'processing',
            source: 'mirror_auto_capture',
            identityStatus: 'provisional',
            ownershipStatus: 'unverified',
            marketedFor: 'unisex',
          },
          status: 'active',
          source: 'ambient_capture',
          appearanceFingerprint: identity.appearanceFingerprint,
          createdAt: now,
          updatedAt: now,
        }
      : undefined;
    return { observation, appearanceAsset: args.appearanceAssets[index]!, identity, resolvedClosetItemId: itemId, createItem };
  });
  const outfitSignature = createHash('sha256')
    .update(items.map((item) => item.resolvedClosetItemId).sort().join('|'))
    .digest('hex')
    .slice(0, 24);
  return {
    proposalId: makeId('capture_proposal'),
    userId: args.packet.userId,
    sessionId: args.packet.sessionId,
    episodeId: args.episode.episodeId,
    observation: args.observation,
    packet: args.packet,
    evidenceAsset: args.evidenceAsset,
    evidenceImageUrl: args.evidenceAsset.imageUrl,
    items,
    outfitSignature,
    repeatedOutfit: args.state.captures.some((capture) => capture.outfitSignature === outfitSignature),
    idempotencyKey: createHash('sha256').update(`${args.packet.userId}:${args.episode.episodeId}:${outfitSignature}`).digest('hex'),
  };
}

function completedEventFromCommit(
  proposal: OutfitCaptureProposal,
  commit: Awaited<ReturnType<JsonUserWardrobeRepository['commitCapture']>>,
  observation: WornOutfitObservation,
  state: Awaited<ReturnType<JsonUserWardrobeRepository['getState']>>,
  baseClosetItems: ClosetItem[],
): OutfitCaptureCompletedEvent {
  const newIds = new Set(commit.createdClosetItemIds);
  return {
    eventId: makeId('outfit_capture_event'),
    type: 'outfit_capture_completed',
    userId: proposal.userId,
    sessionId: proposal.sessionId,
    captureId: commit.capture.captureId,
    episodeId: proposal.episodeId,
    newItemIds: commit.createdClosetItemIds,
    recognizedItemIds: commit.recognizedClosetItemIds,
    itemSummaries: proposal.items.map((item, index) => {
      const ambient = state.closetItems.find((entry) => entry.item.id === item.resolvedClosetItemId)?.item;
      const base = baseClosetItems.find((entry) => entry.id === item.resolvedClosetItemId);
      return {
        closetItemId: item.resolvedClosetItemId,
        slot: item.observation.slot,
        label: observation.garments[index]?.description ?? item.observation.description,
        status: newIds.has(item.resolvedClosetItemId) ? 'new' : 'recognized',
        imageUrl: ambient?.imageStatus === 'ready' ? ambient.imageUrl : base?.imageUrl,
        imageStatus: ambient?.imageStatus ?? (newIds.has(item.resolvedClosetItemId) ? 'processing' : 'ready'),
      };
    }),
    repeatedOutfit: proposal.repeatedOutfit,
    committedAt: commit.capture.committedAt,
  };
}

function ambientItemName(observation: WornOutfitObservation['garments'][number]): string {
  return observation.description.trim() || `${observation.dominantColor} ${observation.category}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function safeErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : 'UNKNOWN';
  return name.replace(/[^A-Z0-9_]/gi, '_').toUpperCase().slice(0, 40);
}

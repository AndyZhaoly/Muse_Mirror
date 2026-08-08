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
  GarmentIdentityHypothesis,
  PendingIdentityResolution,
} from '../domain/ambientCapture.js';
import type { OutfitEpisode } from '../domain/outfitEpisode.js';
import type { MirrorSituationObservation } from '../domain/mirrorSituation.js';
import { decideMirrorSituation } from '../policy/mirrorSituationPolicy.js';
import type { ClosetItem } from '../types.js';
import { makeId } from '../utils/ids.js';
import type { GarmentIdentityProvider } from '../services/garmentIdentityProvider.js';
import {
  appearanceFingerprint,
  descriptorFromObservation,
  recallGarmentIdentityCandidates,
  type GarmentIdentityInput,
} from '../services/garmentIdentityProvider.js';
import { canonicalizePattern, colorSimilarity } from '../services/garmentVocabulary.js';
import { hardAttributeExclusion } from '../services/garmentIdentityEvidence.js';
import type { OutfitObservationProvider } from '../services/outfitObservationProvider.js';
import type { JsonUserWardrobeRepository } from '../services/userWardrobeRepository.js';
import type { GarmentImageAssetService } from '../services/garmentImageAssetService.js';
import { perceptualHashDistance } from '../services/garmentImageAssetService.js';
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
    let state = await this.options.repository.getState(packet.userId);
    if (!activeGrant(state.grant)) return this.remember(packet.userId, { status: 'disabled', reasonCodes: ['AUTO_CAPTURE_GRANT_MISSING'] });
    if (!this.options.observationProvider.ready) return this.remember(packet.userId, { status: 'unavailable', reasonCodes: ['REAL_VISION_PROVIDER_UNAVAILABLE'], retryAfterMs: 15_000 });
    if (!validStability(packet)) return this.remember(packet.userId, { status: 'observing', reasonCodes: ['LOCAL_FRAME_NOT_STABLE'], retryAfterMs: 1_500 });
    const capturedAt = Date.parse(packet.capturedAt);
    if (!Number.isFinite(capturedAt) || Date.now() - capturedAt > 20_000 || capturedAt - Date.now() > 5_000) {
      return this.remember(packet.userId, { status: 'insufficient_evidence', reasonCodes: ['CAPTURE_PACKET_STALE'] });
    }
    await this.options.repository.expirePendingIdentityResolutions(packet.userId, packet.capturedAt);
    state = await this.options.repository.getState(packet.userId);

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
      await this.cleanupEpisodeEvidence(packet.userId, episode, packet.capturedAt, 'discard_all');
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
      await this.cleanupEpisodeEvidence(packet.userId, episode, observation.analyzedAt, 'defer_pending');
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
      await this.cleanupEpisodeEvidence(packet.userId, episode, observation.analyzedAt, 'discard_all');
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
      (findTrackForGarment(garmentTracks, garment)?.consecutiveMatches ?? 0) >= 2
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
      const current = (track?.identityEvidence ?? []).flatMap((evidence) => {
        const asset = freshState.assets.find((entry) => entry.assetId === evidence.assetId);
        return asset ? [asset] : [];
      });
      const pending = track
        ? findPendingResolutionForTrack(freshState.pendingIdentityResolutions, episode.episodeId, track, [], packet.capturedAt)
        : undefined;
      const retained = pending?.currentEvidenceAssetIds.flatMap((assetId) => {
        const asset = freshState.assets.find((entry) => entry.assetId === assetId);
        return asset ? [asset] : [];
      }) ?? [];
      return [...retained, ...current]
        .filter((asset, index, all) => all.findIndex((candidate) => candidate.assetId === asset.assetId) === index)
        .slice(-2);
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
    const identityInputs: GarmentIdentityInput[] = observation.garments.map((garment, index) => ({
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
    }));
    const recalls = identityInputs.map((input) =>
      this.options.identityProvider.recall?.(input) ?? recallGarmentIdentityCandidates(input));
    const automaticRechecks = new Set<string>();
    const identities = await Promise.all(observation.garments.map(async (garment, index) => {
      const track = findTrackForGarment(garmentTracks, garment);
      const recallCandidateIds = recalls[index]!.candidates.map((candidate) => candidate.closetItemId);
      const pending = track
        ? findPendingResolutionForTrack(
            freshState.pendingIdentityResolutions,
            episode.episodeId,
            track,
            recallCandidateIds,
            packet.capturedAt,
          )
        : undefined;
      const meaningfulEvidence = pending
        ? hasMeaningfullyNewEvidence(pending, freshState.assets, track)
        : false;
      if (pending && (
        pending.state === 'ready_to_ask' ||
        pending.automaticRecheckCount >= 1 ||
        !meaningfulEvidence
      )) {
        return pendingIdentityHypothesis(garment, pending, meaningfulEvidence
          ? 'AUTOMATIC_RECHECK_LIMIT_REACHED'
          : 'AUTOMATIC_RECHECK_REQUIRES_MEANINGFUL_EVIDENCE');
      }
      if (pending && meaningfulEvidence) {
        automaticRechecks.add(pending.resolutionId);
      }
      return this.options.identityProvider.resolve(identityInputs[index]!);
    }));
    const resolvedPending = new Map<string, Awaited<ReturnType<GarmentIdentityProvider['resolve']>>>();
    for (const [index, identity] of identities.entries()) {
      const garment = observation.garments[index];
      if (!garment) continue;
      const track = findTrackForGarment(garmentTracks, garment);
      const pending = track
        ? findPendingResolutionForTrack(
            freshState.pendingIdentityResolutions,
            episode.episodeId,
            track,
            identity.candidateItemIds,
            packet.capturedAt,
          )
        : undefined;
      if (!pending) continue;
      if (identity.decisionTrace) {
        identity.decisionTrace.pendingResolutionId = pending.resolutionId;
        identity.decisionTrace.automaticRecheckCount = automaticRechecks.has(pending.resolutionId)
          ? Math.min(1, pending.automaticRecheckCount + 1)
          : pending.automaticRecheckCount;
      }
      if (identity.status !== 'ambiguous' && identity.status !== 'insufficient_evidence') {
        resolvedPending.set(pending.resolutionId, identity);
      }
    }
    const unresolved = identities.filter((identity) => identity.status === 'ambiguous' || identity.status === 'insufficient_evidence');
    const pendingStates = unresolved.length
      ? await this.persistPendingIdentityResolutions({
        packet,
        episode,
        observation,
        tracks: garmentTracks,
        identities,
        existing: freshState.pendingIdentityResolutions,
        currentAssets: freshState.assets,
      })
      : [];

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
      await this.cleanupEpisodeEvidence(packet.userId, episode, observation.analyzedAt, 'defer_pending');
      return this.remember(packet.userId, {
        status: postflight.privacyPaused ? 'privacy_paused' : postflight.action === 'defer' ? 'deferred' : 'insufficient_evidence',
        reasonCodes: postflight.reasonCodes,
        episodeId: episode.episodeId,
        observationId: observation.observationId,
      });
    }

    const pendingByObservationItemId = new Map(pendingStates.map((pending) => [pending.observationItemId, pending]));
    const proposal = buildProposal({
      packet,
      episode,
      observation,
      identities,
      state: freshState,
      evidenceAsset,
      appearanceAssets,
      pendingByObservationItemId,
    });
    let committed: Awaited<ReturnType<JsonUserWardrobeRepository['commitCapture']>>;
    try {
      committed = await this.options.repository.commitCapture({
        proposal,
        pendingResolutions: [...resolvedPending.entries()].flatMap(([resolutionId, identity]) => {
          const proposalItem = proposal.items.find((item) => item.identity === identity);
          return proposalItem?.type === 'closet_item' ? [{
            resolutionId,
            closetItemId: proposalItem.resolvedClosetItemId,
            state: identity.status === 'matched_existing' ? 'resolved_existing' as const : 'resolved_new' as const,
          }] : [];
        }),
      });
    } catch (error) {
      await this.options.assetService.deleteAssets([evidenceAsset]);
      await this.cleanupEpisodeEvidence(packet.userId, episode, observation.analyzedAt, 'defer_pending');
      throw error;
    }
    if (committed.status === 'already_committed') {
      await this.options.assetService.deleteAssets([evidenceAsset]);
    }
    await this.cleanupEpisodeEvidence(packet.userId, episode, observation.analyzedAt, 'preserve_pending');
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
    const status: AmbientCaptureOutcome['status'] = committed.status === 'already_committed'
      ? 'already_committed'
      : pendingStates.length ? 'mixed' : 'recognized';
    return this.remember(packet.userId, {
      status,
      reasonCodes: [
        ...observationGateReasonCodes,
        committed.createdClosetItemIds.length ? 'NEW_GARMENTS_COMMITTED' : 'KNOWN_GARMENTS_RECOGNIZED',
        ...(pendingStates.length ? ['PENDING_IDENTITY_RECORDED'] : []),
        proposal.repeatedOutfit ? 'REPEATED_OUTFIT_SIGNATURE' : 'NEW_OUTFIT_SIGNATURE',
      ],
      episodeId: episode.episodeId,
      observationId: observation.observationId,
      completedEvent,
      retryAfterMs: pendingStates.some((pending) => pending.state === 'awaiting_evidence') ? 2_500 : 12_000,
    });
  }

  async endEpisode(userId: string, sessionId: string, occurredAt?: string): Promise<AmbientCaptureOutcome> {
    return this.exclusive(userId, async () => {
      const ended = await this.options.repository.endActiveEpisode(userId, sessionId, occurredAt);
      if (ended) await this.cleanupEpisodeEvidence(userId, ended, occurredAt ?? new Date().toISOString(), 'defer_pending');
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
          boundingBox: garment.boundingBox,
          coverage: observation.coverage,
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
    currentAssets: GarmentImageAsset[];
  }): Promise<PendingIdentityResolution[]> {
    const pending: PendingIdentityResolution[] = [];
    for (const [index, identity] of input.identities.entries()) {
      if (identity.status !== 'ambiguous' && identity.status !== 'insufficient_evidence') continue;
      const garment = input.observation.garments[index]!;
      const track = findTrackForGarment(input.tracks, garment);
      if (!track) continue;
      const existing = findPendingResolutionForTrack(
        input.existing,
        input.episode.episodeId,
        track,
        identity.candidateItemIds,
        input.packet.capturedAt,
      );
      const currentEvidenceAssetIds = [...new Set([
        ...(existing?.currentEvidenceAssetIds ?? []),
        ...track.identityEvidence.map((entry) => entry.assetId),
      ])].slice(-2);
      const trace = identity.decisionTrace;
      const automaticRecheckCount = trace?.automaticRecheckCount ?? existing?.automaticRecheckCount ?? 0;
      const occludedFeatures = [...new Set(trace?.pairwiseVerifications.flatMap((verification) => [
        ...verification.normalizedResult.occlusions,
        ...verification.normalizedResult.featureComparisons
          .filter((comparison) => comparison.currentVisibility !== 'visible' || comparison.referenceVisibility !== 'visible')
          .map((comparison) => comparison.feature),
      ]) ?? [])];
      const resolutionId = existing?.resolutionId ?? makeId('pending_identity');
      const state: PendingIdentityResolution['state'] = existing
        ? automaticRecheckCount >= 1 || existing.state === 'ready_to_ask' ? 'ready_to_ask' : 'awaiting_evidence'
        : occludedFeatures.length > 0 ? 'awaiting_evidence' : 'ready_to_ask';
      const now = input.packet.capturedAt;
      const allClosetItems = this.options.baseClosetItems();
      const userItems = (await this.options.repository.getState(input.packet.userId)).closetItems.map((entry) => entry.item);
      const currentCandidateClosetItemIds = [...new Set(identity.candidateItemIds)].slice(0, 8);
      const currentCandidateSummaries = currentCandidateClosetItemIds.flatMap((closetItemId, index) => {
        const item = [...allClosetItems, ...userItems].find((entry) => entry.id === closetItemId);
        return item ? [{
          closetItemId,
          label: item.name,
          imageUrl: item.imageUrl,
          priorRank: index + 1,
          identityReasonCodes: identity.reasonCodes,
        }] : [];
      });
      const resolution: PendingIdentityResolution = {
        resolutionId,
        userId: input.packet.userId,
        episodeId: input.episode.episodeId,
        trackId: track.trackId,
        observationItemId: garment.observationItemId,
        slot: garment.slot,
        category: garment.category,
        lockedDescriptor: existing?.lockedDescriptor ?? track.descriptor,
        currentEvidenceAssetIds,
        evidenceSignatures: [
          ...(existing?.evidenceSignatures ?? []),
          ...track.identityEvidence.flatMap((evidence) => {
            const asset = input.currentAssets.find((entry) => entry.assetId === evidence.assetId);
            return asset ? [{
              assetId: asset.assetId,
              perceptualHash: asset.perceptualHash,
              boundingBox: evidence.boundingBox,
              descriptor: evidence.descriptor,
              coverage: evidence.coverage,
            }] : [];
          }),
        ].filter((entry, index, all) => all.findIndex((candidate) => candidate.assetId === entry.assetId) === index).slice(-2),
        candidateClosetItemIds: currentCandidateClosetItemIds,
        candidateHistoryClosetItemIds: [...new Set([
          ...(existing?.candidateHistoryClosetItemIds ?? existing?.candidateClosetItemIds ?? []),
          ...currentCandidateClosetItemIds,
        ])].slice(-24),
        candidateSummaries: currentCandidateSummaries,
        ambiguityReasonCodes: [...new Set([
          ...identity.reasonCodes,
          ...(existing && existing.episodeId !== input.episode.episodeId ? ['CROSS_EPISODE_EVIDENCE_ATTACHED'] : []),
        ])],
        occludedFeatures,
        automaticRecheckCount,
        state,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        deadlineAt: existing?.deadlineAt ?? new Date(Date.parse(now) + 5 * 60_000).toISOString(),
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
    mode: 'defer_pending' | 'preserve_pending' | 'discard_all',
  ): Promise<void> {
    const assets = await this.options.repository.cleanupEpisodeIdentityEvidence(
      userId,
      episode.episodeId,
      occurredAt,
      mode,
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
      const proposalItem = proposal.items.find((item) => item.type === 'closet_item' && item.resolvedClosetItemId === closetItemId);
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
    const completedEvent = completedEventFromCommit(proposal, committed, observation, state, this.options.baseClosetItems());
    if (failed) {
      await this.options.repository.setPendingCompletionEvent(proposal.userId, completedEvent);
      this.remember(proposal.userId, {
        status: 'image_needs_review',
        reasonCodes: ['CAPTURE_RECORDED', 'CATALOG_IMAGE_NEEDS_REVIEW'],
        episodeId: proposal.episodeId,
        observationId: proposal.observation.observationId,
        completedEvent,
        retryAfterMs: 15_000,
      });
      return;
    }
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

export function updateGarmentTracks(
  previousTracks: AmbientGarmentTrack[],
  observation: WornOutfitObservation,
): AmbientGarmentTrack[] {
  const assignedTrackIds = new Set<string>();
  return observation.garments.map((garment) => {
    const descriptor = descriptorFromObservation(garment);
    const fingerprint = appearanceFingerprint(descriptor);
    const previous = previousTracks
      .filter((track) =>
        !assignedTrackIds.has(track.trackId) &&
        track.slot === garment.slot &&
        track.category === garment.category)
      .map((track) => ({ track, similarity: trackDescriptorSimilarity(track.descriptor, descriptor) }))
      .filter((candidate) => candidate.similarity >= TRACK_CONTINUITY_THRESHOLD)
      .sort((left, right) => right.similarity - left.similarity || left.track.trackId.localeCompare(right.track.trackId))[0]?.track;
    if (previous) assignedTrackIds.add(previous.trackId);
    return {
      trackId: previous?.trackId ?? makeId('garment_track'),
      latestObservationItemId: garment.observationItemId,
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
  const exact = tracks.find((track) => track.latestObservationItemId === garment.observationItemId);
  if (exact) return exact;
  const descriptor = descriptorFromObservation(garment);
  return tracks
    .filter((track) => track.slot === garment.slot && track.category === garment.category)
    .map((track) => ({ track, similarity: trackDescriptorSimilarity(track.descriptor, descriptor) }))
    .sort((left, right) => right.similarity - left.similarity || left.track.trackId.localeCompare(right.track.trackId))[0]?.track;
}

const MEANINGFUL_PERCEPTUAL_DISTANCE = 8;

function hasMeaningfullyNewEvidence(
  resolution: PendingIdentityResolution,
  currentAssets: GarmentImageAsset[],
  track: AmbientGarmentTrack | undefined,
): boolean {
  if (!track) return false;
  return track.identityEvidence.some((evidence) => {
    if (resolution.currentEvidenceAssetIds.includes(evidence.assetId)) return false;
    const asset = currentAssets.find((entry) => entry.assetId === evidence.assetId);
    if (!asset) return false;
    return resolution.evidenceSignatures.every((previous) => {
      if (coverageRank(evidence.coverage) > coverageRank(previous.coverage)) return true;
      if (descriptorVisibilityImproved(previous.descriptor, evidence.descriptor, resolution.occludedFeatures)) return true;
      if (boundingBoxMeaningfullyChanged(previous.boundingBox, evidence.boundingBox)) return true;
      const distance = perceptualHashDistance(previous.perceptualHash, asset.perceptualHash);
      return distance !== undefined && distance >= MEANINGFUL_PERCEPTUAL_DISTANCE;
    });
  });
}

export function findPendingResolutionForTrack(
  resolutions: PendingIdentityResolution[],
  episodeId: string,
  track: AmbientGarmentTrack,
  candidateClosetItemIds: string[] = [],
  observedAt = new Date().toISOString(),
): PendingIdentityResolution | undefined {
  const observedAtMs = Date.parse(observedAt);
  const eligible = (entry: PendingIdentityResolution): boolean =>
    entry.state !== 'resolved_existing' &&
    entry.state !== 'resolved_new' &&
    entry.state !== 'expired' &&
    (!entry.deadlineAt || !Number.isFinite(observedAtMs) || Date.parse(entry.deadlineAt) > observedAtMs);
  const exact = resolutions.find((entry) =>
    entry.episodeId === episodeId &&
    entry.trackId === track.trackId &&
    eligible(entry));
  if (exact) return exact;
  const sameEpisodeCompatible = resolutions.filter((entry) =>
    entry.episodeId === episodeId &&
    eligible(entry) &&
    entry.slot === track.slot &&
    entry.category === track.category &&
    trackDescriptorSimilarity(entry.lockedDescriptor, track.descriptor) >= TRACK_CONTINUITY_THRESHOLD &&
    !hardAttributeExclusion(entry.lockedDescriptor, track.descriptor));
  if (sameEpisodeCompatible.length === 1) return sameEpisodeCompatible[0];
  const deferred = resolutions.filter((entry) =>
    entry.state === 'deferred' &&
    eligible(entry) &&
    entry.slot === track.slot &&
    entry.category === track.category &&
    trackDescriptorSimilarity(entry.lockedDescriptor, track.descriptor) >= TRACK_CONTINUITY_THRESHOLD &&
    !hardAttributeExclusion(entry.lockedDescriptor, track.descriptor) &&
    candidateClosetItemIds.some((id) => entry.candidateClosetItemIds.includes(id)));
  return deferred.length === 1 ? deferred[0] : undefined;
}

function coverageRank(coverage: WornOutfitObservation['coverage']): number {
  const ranks: Record<string, number> = { none: 0, face_only: 0, head_shoulders: 1, upper_body: 2, three_quarter: 3, full_body: 4 };
  return ranks[coverage] ?? 0;
}

function pendingIdentityHypothesis(
  garment: WornOutfitObservation['garments'][number],
  pending: PendingIdentityResolution,
  reasonCode: string,
): GarmentIdentityHypothesis {
  return {
    observationItemId: garment.observationItemId,
    status: 'ambiguous',
    appearanceFingerprint: appearanceFingerprint(descriptorFromObservation(garment)),
    confidence: 0,
    candidateItemIds: pending.candidateClosetItemIds,
    reasonCodes: [...new Set([...pending.ambiguityReasonCodes, reasonCode])],
  };
}

function descriptorVisibilityImproved(
  previous: AmbientGarmentTrack['descriptor'],
  current: AmbientGarmentTrack['descriptor'],
  occludedFeatures: string[],
): boolean {
  const currentFeatures = new Set(current.distinctiveFeatures.map(normalizeDescriptorToken));
  const previousFeatures = new Set(previous.distinctiveFeatures.map(normalizeDescriptorToken));
  return occludedFeatures.some((feature) => {
    const normalized = normalizeDescriptorToken(feature);
    return currentFeatures.has(normalized) && !previousFeatures.has(normalized);
  });
}

function boundingBoxMeaningfullyChanged(left: { x: number; y: number; width: number; height: number }, right: { x: number; y: number; width: number; height: number }): boolean {
  const areaLeft = left.width * left.height;
  const areaRight = right.width * right.height;
  const overlapWidth = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const overlapHeight = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const union = areaLeft + areaRight - overlapWidth * overlapHeight;
  const iou = union > 0 ? (overlapWidth * overlapHeight) / union : 0;
  return iou < 0.82 || Math.abs(areaLeft - areaRight) > 0.12;
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
  pendingByObservationItemId: Map<string, PendingIdentityResolution>;
}): OutfitCaptureProposal {
  const items = args.observation.garments.map((observation, index) => {
    const identity = args.identities[index]!;
    const pending = args.pendingByObservationItemId.get(observation.observationItemId);
    if (identity.status === 'ambiguous' || identity.status === 'insufficient_evidence') {
      if (!pending) throw new Error('PENDING_IDENTITY_RESOLUTION_MISSING');
      return {
        type: 'pending_identity' as const,
        observation,
        appearanceAsset: args.appearanceAssets[index]!,
        identity,
        pendingResolutionId: pending.resolutionId,
      };
    }
    const itemId = identity.matchedClosetItemId ?? makeId('ambient_item');
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
    return { type: 'closet_item' as const, observation, appearanceAsset: args.appearanceAssets[index]!, identity, resolvedClosetItemId: itemId, createItem };
  });
  const outfitSignature = createHash('sha256')
    .update(items.map((item) => item.type === 'closet_item'
      ? item.resolvedClosetItemId
      : `pending:${item.pendingResolutionId}`).sort().join('|'))
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
  const pendingItems = proposal.items.flatMap((item) => {
    if (item.type !== 'pending_identity') return [];
    const pending = state.pendingIdentityResolutions.find((entry) => entry.resolutionId === item.pendingResolutionId);
    if (!pending || pending.state === 'resolved_existing' || pending.state === 'resolved_new' || pending.state === 'expired') return [];
    return [{
      resolutionId: item.pendingResolutionId,
      slot: item.observation.slot,
      label: item.observation.description,
      state: pending.state,
    }];
  });
  return {
    eventId: makeId('outfit_capture_event'),
    type: 'outfit_capture_completed',
    userId: proposal.userId,
    sessionId: proposal.sessionId,
    captureId: commit.capture.captureId,
    episodeId: proposal.episodeId,
    newItemIds: commit.createdClosetItemIds,
    recognizedItemIds: commit.recognizedClosetItemIds,
    completionStatus: pendingItems.length > 0
      ? 'partially_resolved'
      : commit.createdClosetItemIds.length === 0 ? 'fully_recognized' : 'fully_resolved',
    pendingItems,
    itemSummaries: proposal.items.filter((item) => item.type === 'closet_item').map((item) => {
      const ambient = state.closetItems.find((entry) => entry.item.id === item.resolvedClosetItemId)?.item;
      const base = baseClosetItems.find((entry) => entry.id === item.resolvedClosetItemId);
      return {
        closetItemId: item.resolvedClosetItemId,
        slot: item.observation.slot,
        label: item.observation.description,
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

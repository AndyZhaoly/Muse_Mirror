import { createHash } from 'node:crypto';
import type {
  AmbientCaptureDiagnostics,
  AmbientCaptureOutcome,
  AmbientCapturePacket,
  AmbientClosetItem,
  AmbientGarmentTrack,
  AmbientOutfitEpisode,
  OutfitCaptureCompletedEvent,
  OutfitCaptureProposal,
  WornOutfitObservation,
  GarmentImageAsset,
} from '../domain/ambientCapture.js';
import type { OutfitEpisode } from '../domain/outfitEpisode.js';
import type { MirrorSituationObservation } from '../domain/mirrorSituation.js';
import { decideMirrorSituation } from '../policy/mirrorSituationPolicy.js';
import type { ClosetItem } from '../types.js';
import { makeId } from '../utils/ids.js';
import type { GarmentIdentityProvider } from '../services/garmentIdentityProvider.js';
import { appearanceFingerprint, descriptorFromObservation } from '../services/garmentIdentityProvider.js';
import { canonicalizePattern, colorSimilarity } from '../services/garmentVocabulary.js';
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

    if (observation.personCount === 0) {
      episode = { ...episode, status: 'ended', endedAt: observation.analyzedAt, lastObservationId: observation.observationId, lastObservedAt: observation.analyzedAt };
      await this.options.repository.upsertEpisode(packet.userId, episode);
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
      return this.remember(packet.userId, {
        status: 'privacy_paused',
        reasonCodes: observedEnvelope.reasonCodes,
        episodeId: episode.episodeId,
        observationId: observation.observationId,
      });
    }

    const reliable = reliableObservation(observation);
    const garmentTracks = reliable
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
    await this.options.repository.upsertEpisode(packet.userId, episode);

    if (!reliable) {
      return this.remember(packet.userId, {
        status: 'insufficient_evidence',
        reasonCodes: observationReasonCodes(observation),
        episodeId: episode.episodeId,
        observationId: observation.observationId,
        retryAfterMs: 4_000,
      });
    }
    if (episode.status !== 'stable') {
      return this.remember(packet.userId, {
        status: 'observing',
        reasonCodes: ['EPISODE_REQUIRES_SECOND_RELIABLE_OBSERVATION'],
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
      appearanceAssets = await Promise.all(observation.garments.map(async (garment) => (
        await this.options.assetService.cropGarment({
          userId: packet.userId,
          sourceFramePath: packet.imagePath,
          sourceFrameId: packet.frameId,
          observationItemId: garment.observationItemId,
          boundingBox: garment.boundingBox,
          slot: garment.slot,
          capturedAt: packet.capturedAt,
        })
      ).asset));
    } catch (error) {
      await this.options.assetService.deleteAssets([...(evidenceAsset ? [evidenceAsset] : []), ...appearanceAssets]);
      return this.remember(packet.userId, {
        status: 'insufficient_evidence',
        reasonCodes: ['GARMENT_CROP_FAILED', safeErrorCode(error)],
        episodeId: episode.episodeId,
        observationId: observation.observationId,
        retryAfterMs: 5_000,
      });
    }

    const freshState = await this.options.repository.getState(packet.userId);
    const baseCatalogAssets = await this.options.baseCatalogAssets?.() ?? new Map<string, GarmentImageAsset>();
    const identities = await Promise.all(observation.garments.map((garment, index) => this.options.identityProvider.resolve({
      userId: packet.userId,
      episodeId: episode.episodeId,
      capturedAt: packet.capturedAt,
      garment,
      currentAppearance: appearanceAssets[index]!,
      baseClosetItems: this.options.baseClosetItems(),
      userClosetItems: freshState.closetItems,
      appearances: freshState.appearances,
      assets: freshState.assets,
      captures: freshState.captures,
      wearEvents: freshState.wearEvents,
      baseCatalogAssets,
    })));
    await this.options.repository.appendIdentityDecisionTraces(
      packet.userId,
      identities.flatMap((identity) => identity.decisionTrace ? [identity.decisionTrace] : []),
      this.options.identityTraceLimit ?? 200,
    );
    const unresolved = identities.filter((identity) => identity.status === 'ambiguous' || identity.status === 'insufficient_evidence');
    if (unresolved.length) {
      await this.options.assetService.deleteAssets([evidenceAsset, ...appearanceAssets]);
      return this.remember(packet.userId, {
        status: unresolved.some((item) => item.status === 'ambiguous') ? 'ambiguous' : 'insufficient_evidence',
        reasonCodes: unresolved.flatMap((item) => item.reasonCodes),
        episodeId: episode.episodeId,
        observationId: observation.observationId,
        retryAfterMs: 5_000,
      });
    }

    const hasNew = identities.some((identity) => identity.status === 'new_to_closet');
    const postflight = decideMirrorSituation({
      observation: situationObservation(packet, episode, observation, hasNew ? 'unmatched' : 'matched'),
      episode: policyEpisode(episode),
    });
    const eligible = hasNew
      ? postflight.eligibility.garmentCandidate === 'eligible' && postflight.eligibility.closetPersistence === 'eligible'
      : postflight.eligibility.wearRecord === 'eligible';
    if (!eligible) {
      await this.options.assetService.deleteAssets([evidenceAsset, ...appearanceAssets]);
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
      await this.options.assetService.deleteAssets([evidenceAsset, ...appearanceAssets]);
      throw error;
    }
    if (committed.status === 'already_committed') {
      await this.options.assetService.deleteAssets([evidenceAsset, ...appearanceAssets]);
    }
    if (committed.status === 'committed' && committed.createdClosetItemIds.length) {
      const processing: AmbientCaptureOutcome = {
        status: 'committed_processing_images',
        reasonCodes: ['CAPTURE_COMMITTED', 'CATALOG_IMAGES_PROCESSING'],
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
    return this.exclusive(userId, async () => {
      const state = await this.options.repository.getState(userId);
      const entry = state.closetItems.find((item) => item.item.id === closetItemId);
      const appearance = [...state.appearances].reverse().find((item) => item.closetItemId === closetItemId);
      const sourceAsset = appearance ? state.assets.find((asset) => asset.assetId === appearance.appearanceAssetId) : undefined;
      if (!entry || !sourceAsset) return this.remember(userId, { status: 'unavailable', reasonCodes: ['RETRY_ITEM_OR_APPEARANCE_NOT_FOUND'] });
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
    return {
      enabled: true,
      providerReady: this.options.observationProvider.ready,
      identityVerifierReady: this.options.identityProvider.ready ?? true,
      productImageProviderReady: this.options.productImageProvider.ready,
      productImageVerifierReady: this.options.productImageVerifier.ready,
      grantActive: activeGrant(state.grant),
      currentEpisode: [...state.episodes].reverse().find((episode) => episode.status !== 'ended'),
      closetItemCount: state.closetItems.length,
      captureCount: state.captures.length,
      wearEventCount: state.wearEvents.length,
      assetCounts: {
        capture_evidence: state.assets.filter((asset) => asset.role === 'capture_evidence').length,
        garment_appearance: state.assets.filter((asset) => asset.role === 'garment_appearance').length,
        canonical_product: state.assets.filter((asset) => asset.role === 'canonical_product').length,
      },
      processingImageCount: state.closetItems.filter((entry) => entry.item.imageStatus === 'processing').length,
      needsReviewImageCount: state.closetItems.filter((entry) => entry.item.imageStatus === 'needs_review' || entry.item.imageStatus === 'failed').length,
      lastOutcome: this.lastOutcomes.get(userId),
    };
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
  const slots = new Set(observation.garments.map((garment) => garment.slot));
  const outfitCoverage = (slots.has('top') && slots.has('bottom')) || slots.has('dress');
  return observation.personCount === 1 &&
    observation.quality === 'good' &&
    (observation.coverage === 'three_quarter' || observation.coverage === 'full_body') &&
    outfitCoverage &&
    observation.garments.every((garment) => garment.confidence >= 0.72);
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
    };
  });
}

export const TRACK_CONTINUITY_THRESHOLD = 0.7;
const NEIGHBOR_COLOR_WITHOUT_STRONG_EVIDENCE_CAP = TRACK_CONTINUITY_THRESHOLD - 0.01;

export function trackDescriptorSimilarity(
  left: AmbientGarmentTrack['descriptor'],
  right: AmbientGarmentTrack['descriptor'],
): number {
  if (left.slot !== right.slot || left.category !== right.category) return 0;
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
            styleTags: unique([observation.pattern, observation.silhouette, ...observation.distinctiveFeatures]),
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

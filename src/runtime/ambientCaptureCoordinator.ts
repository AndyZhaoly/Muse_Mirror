import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
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
} from '../domain/ambientCapture.js';
import type { OutfitEpisode } from '../domain/outfitEpisode.js';
import type { MirrorSituationObservation } from '../domain/mirrorSituation.js';
import { decideMirrorSituation } from '../policy/mirrorSituationPolicy.js';
import type { ClosetItem } from '../types.js';
import { makeId } from '../utils/ids.js';
import type { GarmentIdentityProvider } from '../services/garmentIdentityProvider.js';
import { appearanceFingerprint, descriptorFromObservation } from '../services/garmentIdentityProvider.js';
import type { OutfitObservationProvider } from '../services/outfitObservationProvider.js';
import type { JsonUserWardrobeRepository } from '../services/userWardrobeRepository.js';

export class AmbientCaptureCoordinator {
  private readonly lastOutcomes = new Map<string, AmbientCaptureOutcome>();
  private readonly operations = new Map<string, Promise<void>>();

  constructor(
    private readonly options: {
      observationProvider: OutfitObservationProvider;
      identityProvider: GarmentIdentityProvider;
      repository: JsonUserWardrobeRepository;
      baseClosetItems: () => ClosetItem[];
      evidenceDirectory: string;
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
      return this.remember(packet.userId, { status: 'episode_ended', reasonCodes: ['NO_PERSON_PRESENT'], episodeId: episode.episodeId, observationId: observation.observationId });
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

    const freshState = await this.options.repository.getState(packet.userId);
    const identities = await Promise.all(observation.garments.map((garment) => this.options.identityProvider.resolve({
      userId: packet.userId,
      garment,
      baseClosetItems: this.options.baseClosetItems(),
      userClosetItems: freshState.closetItems,
      appearances: freshState.appearances,
    })));
    const unresolved = identities.filter((identity) => identity.status === 'ambiguous' || identity.status === 'insufficient_evidence');
    if (unresolved.length) {
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
      return this.remember(packet.userId, {
        status: postflight.privacyPaused ? 'privacy_paused' : postflight.action === 'defer' ? 'deferred' : 'insufficient_evidence',
        reasonCodes: postflight.reasonCodes,
        episodeId: episode.episodeId,
        observationId: observation.observationId,
      });
    }

    const evidenceImageUrl = await this.persistEvidence(packet);
    const proposal = buildProposal({ packet, episode, observation, identities, state: freshState, evidenceImageUrl });
    let committed: Awaited<ReturnType<JsonUserWardrobeRepository['commitCapture']>>;
    try {
      committed = await this.options.repository.commitCapture({ proposal });
    } catch (error) {
      await this.removeEvidenceUrl(evidenceImageUrl);
      throw error;
    }
    if (committed.status === 'already_committed') {
      await this.removeEvidenceUrl(evidenceImageUrl);
    }
    const completedEvent = committed.status === 'already_committed'
      ? undefined
      : completedEventFromCommit(proposal, committed, observation);
    const status: AmbientCaptureOutcome['status'] = committed.status === 'already_committed'
      ? 'already_committed'
      : committed.createdClosetItemIds.length && committed.recognizedClosetItemIds.length
        ? 'mixed'
        : committed.createdClosetItemIds.length
          ? 'committed'
          : 'recognized';
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

  async resetUser(userId: string): Promise<void> {
    await this.exclusive(userId, async () => {
      const state = await this.options.repository.getState(userId);
      const evidenceUrls = new Set([
        ...state.captures.map((capture) => capture.evidenceImageUrl),
        ...state.appearances.map((appearance) => appearance.evidenceImageUrl),
        ...state.closetItems.map((entry) => entry.item.imageUrl),
      ]);
      await this.options.repository.resetUser(userId);
      await Promise.all([...evidenceUrls].map((url) => this.removeEvidenceUrl(url)));
      this.lastOutcomes.delete(userId);
    });
  }

  async diagnostics(userId: string): Promise<AmbientCaptureDiagnostics> {
    const state = await this.options.repository.getState(userId);
    return {
      enabled: true,
      providerReady: this.options.observationProvider.ready,
      grantActive: activeGrant(state.grant),
      currentEpisode: [...state.episodes].reverse().find((episode) => episode.status !== 'ended'),
      closetItemCount: state.closetItems.length,
      captureCount: state.captures.length,
      wearEventCount: state.wearEvents.length,
      lastOutcome: this.lastOutcomes.get(userId),
    };
  }

  private async persistEvidence(packet: AmbientCapturePacket): Promise<string> {
    await fs.mkdir(this.options.evidenceDirectory, { recursive: true });
    const extension = packet.imageMimeType === 'image/png' ? 'png' : packet.imageMimeType === 'image/webp' ? 'webp' : 'jpg';
    const userHash = createHash('sha256').update(packet.userId).digest('hex').slice(0, 10);
    const filename = `ambient_${userHash}_${packet.frameId.replace(/[^a-z0-9_-]/gi, '_')}.${extension}`;
    const outputPath = path.join(this.options.evidenceDirectory, filename);
    await fs.copyFile(packet.imagePath, outputPath);
    return `/generated/${filename}`;
  }

  private async removeEvidenceUrl(evidenceImageUrl: string | undefined): Promise<void> {
    if (!evidenceImageUrl) return;
    const filename = path.basename(evidenceImageUrl);
    if (!/^ambient_[a-f0-9]{10}_[a-z0-9_-]+\.(?:jpg|png|webp)$/i.test(filename)) return;
    await fs.unlink(path.join(this.options.evidenceDirectory, filename)).catch(() => undefined);
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
      trackDescriptorSimilarity(track.descriptor, descriptor) >= 0.7
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

function trackDescriptorSimilarity(
  left: AmbientGarmentTrack['descriptor'],
  right: AmbientGarmentTrack['descriptor'],
): number {
  if (left.slot !== right.slot || left.category !== right.category) return 0;
  let score = 0.35;
  if (left.dominantColor === right.dominantColor) score += 0.35;
  if (left.pattern === right.pattern) score += 0.1;
  if (left.fit === right.fit) score += 0.08;
  if (tokenOverlap(left.silhouette, right.silhouette) >= 0.5) score += 0.07;
  if (arrayOverlap(left.distinctiveFeatures, right.distinctiveFeatures) >= 0.5) score += 0.05;
  return score;
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
  evidenceImageUrl: string;
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
            imageUrl: args.evidenceImageUrl,
            marketedFor: 'unisex',
          },
          status: 'provisional',
          source: 'ambient_capture',
          appearanceFingerprint: identity.appearanceFingerprint,
          createdAt: now,
          updatedAt: now,
        }
      : undefined;
    return { observation, identity, resolvedClosetItemId: itemId, createItem };
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
    evidenceImageUrl: args.evidenceImageUrl,
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
    itemSummaries: proposal.items.map((item, index) => ({
      closetItemId: item.resolvedClosetItemId,
      slot: item.observation.slot,
      label: observation.garments[index]?.description ?? item.observation.description,
      status: newIds.has(item.resolvedClosetItemId) ? 'new' : 'recognized',
    })),
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

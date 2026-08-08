import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type {
  AmbientCaptureGrant,
  AmbientClosetItem,
  AmbientOutfitEpisode,
  CommitOutfitCaptureCommand,
  GarmentAppearance,
  GarmentImageAsset,
  GarmentIdentityDecisionTrace,
  PendingIdentityResolution,
  ClosetItemMergePreview,
  MergeClosetItemsResult,
  OutfitCapture,
  OutfitItemRef,
  OutfitCaptureCommitResult,
  UserWardrobeState,
  WearEvent,
  ProductImageJob,
  ProductImageVerification,
  WardrobeEvent,
  WardrobeEventType,
} from '../domain/ambientCapture.js';
import { descriptorFromObservation } from './garmentIdentityProvider.js';
import { makeId } from '../utils/ids.js';

interface WardrobeRepositoryFile {
  schemaVersion: 1;
  users: Record<string, UserWardrobeState>;
}

export interface WardrobeRepository {
  getState(userId: string): Promise<UserWardrobeState>;
  commitCapture(command: CommitOutfitCaptureCommand): Promise<OutfitCaptureCommitResult>;
  appendIdentityDecisionTraces(
    userId: string,
    traces: GarmentIdentityDecisionTrace[],
    limit?: number,
  ): Promise<void>;
  previewClosetItemMerge(input: {
    userId: string;
    canonicalItemId: string;
    duplicateItemId: string;
  }): Promise<ClosetItemMergePreview>;
  mergeClosetItems(input: {
    userId: string;
    canonicalItemId: string;
    duplicateItemId: string;
  }): Promise<MergeClosetItemsResult>;
  resolveClosetItemId(userId: string, closetItemId: string): Promise<string>;
  resolvePendingIdentity(input: {
    userId: string;
    resolutionId: string;
    closetItemId: string;
    state: 'resolved_existing' | 'resolved_new';
    occurredAt?: string;
  }): Promise<void>;
  expirePendingIdentityResolutions(userId: string, occurredAt?: string): Promise<number>;
  pruneOrphanTrackIdentityEvidence(userId: string, occurredAt?: string): Promise<GarmentImageAsset[]>;
}

export class JsonUserWardrobeRepository implements WardrobeRepository {
  private operation = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async getState(userId: string): Promise<UserWardrobeState> {
    const file = await this.readFile();
    return structuredClone(file.users[userId] ?? emptyUserState(userId));
  }

  async appendIdentityDecisionTraces(
    userId: string,
    traces: GarmentIdentityDecisionTrace[],
    limit = 200,
  ): Promise<void> {
    if (!traces.length) return;
    await this.exclusive(async () => {
      const file = await this.readFile();
      const state = ensureUser(file, userId);
      const sanitized = traces.map(sanitizeIdentityTrace);
      state.identityDecisionTraces = [
        ...state.identityDecisionTraces.filter((existing) =>
          !sanitized.some((trace) => trace.traceId === existing.traceId)),
        ...sanitized,
      ].slice(-Math.max(1, Math.round(limit)));
      bump(state, sanitized.at(-1)?.createdAt ?? new Date().toISOString());
      await this.writeFile(file);
    });
  }

  async previewClosetItemMerge(input: {
    userId: string;
    canonicalItemId: string;
    duplicateItemId: string;
  }): Promise<ClosetItemMergePreview> {
    const state = await this.getState(input.userId);
    return previewMerge(state, input.canonicalItemId, input.duplicateItemId);
  }

  async resolveClosetItemId(userId: string, closetItemId: string): Promise<string> {
    const state = await this.getState(userId);
    return resolveAlias(state.closetItemAliases, closetItemId);
  }

  async mergeClosetItems(input: {
    userId: string;
    canonicalItemId: string;
    duplicateItemId: string;
  }): Promise<MergeClosetItemsResult> {
    return this.exclusive(async () => {
      const file = await this.readFile();
      const state = ensureUser(file, input.userId);
      const preview = previewMerge(state, input.canonicalItemId, input.duplicateItemId);
      const canonical = state.closetItems.find((entry) => entry.item.id === input.canonicalItemId);
      const duplicate = state.closetItems.find((entry) => entry.item.id === input.duplicateItemId);
      if (preview.status === 'already_merged' && canonical && duplicate) {
        return {
          status: 'already_merged',
          preview,
          canonicalItem: structuredClone(canonical),
          duplicateItem: structuredClone(duplicate),
        };
      }
      if (preview.status === 'blocked' || !canonical || !duplicate) {
        throw new Error(preview.blocker ?? 'CLOSET_ITEM_MERGE_BLOCKED');
      }

      const now = new Date().toISOString();
      const canonicalReady = hasReadyPrimary(state, canonical);
      const duplicateReady = hasReadyPrimary(state, duplicate);
      const duplicateAppearanceIds = new Set(state.appearances
        .filter((appearance) => appearance.closetItemId === duplicate.item.id)
        .map((appearance) => appearance.appearanceAssetId));

      for (const appearance of state.appearances) {
        if (appearance.closetItemId === duplicate.item.id) appearance.closetItemId = canonical.item.id;
      }
      for (const asset of state.assets) {
        if (asset.closetItemId === duplicate.item.id) asset.closetItemId = canonical.item.id;
      }
      for (const event of state.wearEvents) {
        if (event.closetItemId === duplicate.item.id) event.closetItemId = canonical.item.id;
      }
      for (const capture of state.captures) {
        if (!capture.closetItemIds.includes(duplicate.item.id)) continue;
        capture.closetItemIds = unique(capture.closetItemIds.map((itemId) =>
          itemId === duplicate.item.id ? canonical.item.id : itemId));
        capture.items = capture.items.map((item) => item.type === 'closet_item' && item.closetItemId === duplicate.item.id
          ? { ...item, closetItemId: canonical.item.id }
          : item);
        capture.outfitSignature = outfitSignature(capture.closetItemIds);
      }
      for (const job of state.productImageJobs) {
        if (job.closetItemId === duplicate.item.id) job.closetItemId = canonical.item.id;
      }
      for (const wardrobeEvent of state.events) {
        if (wardrobeEvent.closetItemId === duplicate.item.id) wardrobeEvent.closetItemId = canonical.item.id;
      }
      for (const trace of state.identityDecisionTraces) migrateTraceItemId(trace, duplicate.item.id, canonical.item.id);

      if (state.pendingCompletionEvent) {
        state.pendingCompletionEvent.newItemIds = unique(state.pendingCompletionEvent.newItemIds.map((itemId) =>
          itemId === duplicate.item.id ? canonical.item.id : itemId));
        state.pendingCompletionEvent.recognizedItemIds = unique(state.pendingCompletionEvent.recognizedItemIds.map((itemId) =>
          itemId === duplicate.item.id ? canonical.item.id : itemId));
        state.pendingCompletionEvent.itemSummaries = dedupeCompletionSummaries(
          state.pendingCompletionEvent.itemSummaries.map((summary) => summary.closetItemId === duplicate.item.id
            ? { ...summary, closetItemId: canonical.item.id }
            : summary),
        );
      }

      canonical.item.appearanceAssetIds = unique([
        ...(canonical.item.appearanceAssetIds ?? []),
        ...(duplicate.item.appearanceAssetIds ?? []),
        ...duplicateAppearanceIds,
      ]);
      if (!canonicalReady && duplicateReady) {
        canonical.item.primaryImageAssetId = duplicate.item.primaryImageAssetId;
        canonical.item.imageUrl = duplicate.item.imageUrl;
        canonical.item.imageStatus = duplicate.item.imageStatus;
      }
      canonical.createdAt = earliest(canonical.createdAt, duplicate.createdAt);
      canonical.updatedAt = latest(canonical.updatedAt, duplicate.updatedAt, now);

      duplicate.status = 'archived';
      duplicate.item.identityStatus = 'merged';
      duplicate.mergedIntoItemId = canonical.item.id;
      duplicate.updatedAt = now;
      state.closetItemAliases[duplicate.item.id] = canonical.item.id;
      state.events.push(event(input.userId, 'closet_items_merged', now, {
        closetItemId: canonical.item.id,
        reasonCode: `MERGED_DUPLICATE:${duplicate.item.id}`,
      }));
      bump(state, now);
      await this.writeFile(file);
      return {
        status: 'merged',
        preview,
        canonicalItem: structuredClone(canonical),
        duplicateItem: structuredClone(duplicate),
      };
    });
  }

  async setGrant(userId: string, enabled: boolean, occurredAt = new Date().toISOString()): Promise<AmbientCaptureGrant | undefined> {
    return this.exclusive(async () => {
      const file = await this.readFile();
      const state = ensureUser(file, userId);
      if (enabled) {
        state.grant = {
          userId,
          consentVersion: 'ambient-worn-garments-v1',
          autoRecordWornGarments: true,
          grantedAt: occurredAt,
        };
      } else if (state.grant && !state.grant.revokedAt) {
        state.grant.revokedAt = occurredAt;
      }
      bump(state, occurredAt);
      await this.writeFile(file);
      return state.grant ? structuredClone(state.grant) : undefined;
    });
  }

  async upsertEpisode(userId: string, episode: AmbientOutfitEpisode): Promise<void> {
    await this.exclusive(async () => {
      const file = await this.readFile();
      const state = ensureUser(file, userId);
      const index = state.episodes.findIndex((item) => item.episodeId === episode.episodeId);
      if (index >= 0) state.episodes[index] = structuredClone(episode);
      else state.episodes.push(structuredClone(episode));
      state.episodes = state.episodes.slice(-50);
      bump(state, episode.lastObservedAt ?? episode.endedAt ?? episode.startedAt);
      await this.writeFile(file);
    });
  }

  async persistTrackEvidence(
    userId: string,
    episode: AmbientOutfitEpisode,
    assets: GarmentImageAsset[],
    evictedAssetIds: string[] = [],
  ): Promise<void> {
    await this.exclusive(async () => {
      const file = await this.readFile();
      const state = ensureUser(file, userId);
      const episodeIndex = state.episodes.findIndex((item) => item.episodeId === episode.episodeId);
      if (episodeIndex >= 0) state.episodes[episodeIndex] = structuredClone(episode);
      else state.episodes.push(structuredClone(episode));
      state.episodes = state.episodes.slice(-50);
      const evicted = new Set(evictedAssetIds);
      state.assets = state.assets.filter((asset) => !evicted.has(asset.assetId));
      for (const asset of assets) {
        const index = state.assets.findIndex((entry) => entry.assetId === asset.assetId);
        if (index >= 0) state.assets[index] = structuredClone(asset);
        else state.assets.push(structuredClone(asset));
      }
      bump(state, episode.lastObservedAt ?? episode.startedAt);
      await this.writeFile(file);
    });
  }

  async upsertPendingIdentityResolution(
    userId: string,
    resolution: PendingIdentityResolution,
  ): Promise<void> {
    await this.exclusive(async () => {
      const file = await this.readFile();
      const state = ensureUser(file, userId);
      const index = state.pendingIdentityResolutions.findIndex((entry) => entry.resolutionId === resolution.resolutionId);
      if (index >= 0) state.pendingIdentityResolutions[index] = structuredClone(resolution);
      else state.pendingIdentityResolutions.push(structuredClone(resolution));
      state.pendingIdentityResolutions = state.pendingIdentityResolutions.slice(-50);
      bump(state, resolution.updatedAt);
      await this.writeFile(file);
    });
  }

  async expirePendingIdentityResolutions(
    userId: string,
    occurredAt = new Date().toISOString(),
  ): Promise<number> {
    return this.exclusive(async () => {
      const file = await this.readFile();
      const state = ensureUser(file, userId);
      const deadline = Date.parse(occurredAt);
      let expired = 0;
      for (const resolution of state.pendingIdentityResolutions) {
        if (!isLivePendingResolution(resolution) || !resolution.deadlineAt) continue;
        const expiresAt = Date.parse(resolution.deadlineAt);
        if (!Number.isFinite(expiresAt) || !Number.isFinite(deadline) || expiresAt > deadline) continue;
        resolution.state = 'expired';
        resolution.updatedAt = occurredAt;
        expired += 1;
      }
      if (expired > 0) {
        bump(state, occurredAt);
        await this.writeFile(file);
      }
      return expired;
    });
  }

  async resolvePendingIdentity(input: {
    userId: string;
    resolutionId: string;
    closetItemId: string;
    state: 'resolved_existing' | 'resolved_new';
    occurredAt?: string;
  }): Promise<void> {
    await this.exclusive(async () => {
      const file = await this.readFile();
      const state = ensureUser(file, input.userId);
      const occurredAt = input.occurredAt ?? new Date().toISOString();
      const affectedEpisodes = applyPendingIdentityResolution(state, input);
      for (const episodeId of affectedEpisodes) reconcileEpisodeCaptures(state, episodeId);
      bump(state, occurredAt);
      await this.writeFile(file);
    });
  }

  async pruneOrphanTrackIdentityEvidence(
    userId: string,
    occurredAt = new Date().toISOString(),
  ): Promise<GarmentImageAsset[]> {
    return this.exclusive(async () => {
      const file = await this.readFile();
      const state = ensureUser(file, userId);
      const removed = pruneOrphanTrackIdentityEvidenceFromState(state);
      if (removed.length > 0) {
        bump(state, occurredAt);
        await this.writeFile(file);
      }
      return structuredClone(removed);
    });
  }

  async removePendingIdentityResolutions(userId: string, resolutionIds: string[]): Promise<void> {
    if (!resolutionIds.length) return;
    await this.exclusive(async () => {
      const file = await this.readFile();
      const state = ensureUser(file, userId);
      const ids = new Set(resolutionIds);
      state.pendingIdentityResolutions = state.pendingIdentityResolutions.filter((entry) => !ids.has(entry.resolutionId));
      bump(state, new Date().toISOString());
      await this.writeFile(file);
    });
  }

  async cleanupEpisodeIdentityEvidence(
    userId: string,
    episodeId: string,
    occurredAt = new Date().toISOString(),
    mode: 'defer_pending' | 'preserve_pending' | 'discard_all' = 'defer_pending',
  ): Promise<GarmentImageAsset[]> {
    return this.exclusive(async () => {
      const file = await this.readFile();
      const state = ensureUser(file, userId);
      const episode = state.episodes.find((entry) => entry.episodeId === episodeId);
      const ids = new Set(episode?.garmentTracks?.flatMap((track) => track.identityEvidence.map((evidence) => evidence.assetId)) ?? []);
      const episodePending = state.pendingIdentityResolutions.filter((resolution) =>
        resolution.episodeId === episodeId &&
        isLivePendingResolution(resolution));
      const retainedIds = mode === 'discard_all'
        ? new Set<string>()
        : new Set(episodePending.flatMap((resolution) => resolution.currentEvidenceAssetIds));
      const removed = state.assets.filter((asset) =>
        ids.has(asset.assetId) &&
        !retainedIds.has(asset.assetId) &&
        asset.role === 'track_identity_evidence');
      state.assets = state.assets.filter((asset) =>
        !ids.has(asset.assetId) || retainedIds.has(asset.assetId) || asset.role !== 'track_identity_evidence');
      if (episode?.garmentTracks) {
        episode.garmentTracks = episode.garmentTracks.map((track) => ({
          ...track,
          identityEvidence: track.identityEvidence.filter((evidence) => retainedIds.has(evidence.assetId)),
        }));
      }
      state.pendingIdentityResolutions = mode === 'discard_all'
        ? state.pendingIdentityResolutions.filter((resolution) => resolution.episodeId !== episodeId)
        : mode === 'defer_pending'
          ? state.pendingIdentityResolutions.map((resolution) =>
              resolution.episodeId === episodeId &&
              isLivePendingResolution(resolution)
                ? { ...resolution, state: 'deferred' as const, updatedAt: occurredAt }
                : resolution)
          : state.pendingIdentityResolutions;
      bump(state, occurredAt);
      await this.writeFile(file);
      return structuredClone(removed);
    });
  }

  async endActiveEpisode(userId: string, sessionId: string, occurredAt = new Date().toISOString()): Promise<AmbientOutfitEpisode | undefined> {
    return this.exclusive(async () => {
      const file = await this.readFile();
      const state = ensureUser(file, userId);
      const episode = [...state.episodes]
        .reverse()
        .find((item) => item.sessionId === sessionId && item.status !== 'ended');
      if (!episode) return undefined;
      episode.status = 'ended';
      episode.endedAt = occurredAt;
      bump(state, occurredAt);
      await this.writeFile(file);
      return structuredClone(episode);
    });
  }

  async commitCapture(command: CommitOutfitCaptureCommand): Promise<OutfitCaptureCommitResult> {
    return this.exclusive(async () => {
      const { proposal } = command;
      const file = await this.readFile();
      const state = ensureUser(file, proposal.userId);
      const now = new Date().toISOString();
      const affectedEpisodes = new Set<string>();
      for (const resolution of command.pendingResolutions ?? []) {
        for (const episodeId of applyPendingIdentityResolution(state, {
          userId: proposal.userId,
          ...resolution,
          occurredAt: proposal.packet.capturedAt,
        })) affectedEpisodes.add(episodeId);
      }
      for (const episodeId of affectedEpisodes) reconcileEpisodeCaptures(state, episodeId);

      const existing = state.captures.find((capture) =>
        state.committedIdempotencyKeys.includes(proposal.idempotencyKey) &&
        capture.episodeId === proposal.episodeId &&
        capture.outfitSignature === proposal.outfitSignature);
      if (existing) {
        return {
          status: 'already_committed',
          capture: structuredClone(existing),
          createdClosetItemIds: [],
          recognizedClosetItemIds: [...existing.closetItemIds],
          appearances: state.appearances.filter((item) => item.captureId === existing.captureId),
          wearEvents: state.wearEvents.filter((item) => item.captureId === existing.captureId),
        };
      }

      const createdClosetItemIds: string[] = [];
      const recognizedClosetItemIds: string[] = [];
      const resolvedItems = proposal.items.filter((item) => item.type === 'closet_item');
      for (const item of resolvedItems) {
        const appearanceAsset = structuredClone(item.appearanceAsset);
        appearanceAsset.closetItemId = item.resolvedClosetItemId;
        const existingAssetIndex = state.assets.findIndex((asset) => asset.assetId === appearanceAsset.assetId);
        if (existingAssetIndex >= 0) state.assets[existingAssetIndex] = appearanceAsset;
        else state.assets.push(appearanceAsset);
        if (item.createItem) {
          if (state.closetItems.some((existingItem) => existingItem.item.id === item.createItem?.item.id)) {
            throw new Error(`Duplicate ambient closet item ID: ${item.createItem.item.id}`);
          }
          const created = structuredClone(item.createItem);
          created.item.appearanceAssetIds = [appearanceAsset.assetId];
          created.item.imageStatus = 'processing';
          created.item.source = 'mirror_auto_capture';
          created.item.identityStatus = 'provisional';
          created.item.ownershipStatus = 'unverified';
          created.status = 'active';
          state.closetItems.push(created);
          createdClosetItemIds.push(item.resolvedClosetItemId);
          state.events.push(event(proposal.userId, 'provisional_item_created', now, {
            closetItemId: item.resolvedClosetItemId,
            assetId: appearanceAsset.assetId,
          }));
        } else {
          recognizedClosetItemIds.push(item.resolvedClosetItemId);
          const existingItem = state.closetItems.find((entry) => entry.item.id === item.resolvedClosetItemId);
          if (existingItem) {
            existingItem.item.appearanceAssetIds = appendLimited(existingItem.item.appearanceAssetIds ?? [], appearanceAsset.assetId, 8);
            existingItem.updatedAt = now;
          }
          state.events.push(event(proposal.userId, 'existing_item_matched', now, {
            closetItemId: item.resolvedClosetItemId,
            assetId: appearanceAsset.assetId,
          }));
        }
        state.events.push(event(proposal.userId, 'garment_appearance_stored', now, {
          closetItemId: item.resolvedClosetItemId,
          assetId: appearanceAsset.assetId,
        }));
      }

      const evidenceAsset = structuredClone(proposal.evidenceAsset);
      const evidenceAssetIndex = state.assets.findIndex((asset) => asset.assetId === evidenceAsset.assetId);
      if (evidenceAssetIndex >= 0) state.assets[evidenceAssetIndex] = evidenceAsset;
      else state.assets.push(evidenceAsset);
      state.events.push(event(proposal.userId, 'capture_evidence_stored', now, {
        assetId: proposal.evidenceAsset.assetId,
      }));

      const captureItems: OutfitItemRef[] = proposal.items.map((item) => item.type === 'closet_item'
          ? { type: 'closet_item', closetItemId: item.resolvedClosetItemId, slot: item.observation.slot }
          : { type: 'pending_identity', resolutionId: item.pendingResolutionId, slot: item.observation.slot });
      let capture = state.captures.find((entry) =>
        entry.episodeId === proposal.episodeId &&
        entry.outfitSignature === proposal.outfitSignature);
      const createdCapture = !capture;
      if (!capture) {
        capture = {
          captureId: makeId('outfit_capture'),
          userId: proposal.userId,
          sessionId: proposal.sessionId,
          episodeId: proposal.episodeId,
          observationId: proposal.observation.observationId,
          closetItemIds: resolvedItems.map((item) => item.resolvedClosetItemId),
          items: captureItems,
          outfitSignature: proposal.outfitSignature,
          repeatedOutfit: proposal.repeatedOutfit,
          evidenceImageUrl: proposal.evidenceAsset.imageUrl,
          capturedAt: proposal.packet.capturedAt,
          committedAt: now,
        };
        state.captures.push(capture);
      } else {
        capture.items = captureItems;
        capture.closetItemIds = unique(resolvedItems.map((item) => item.resolvedClosetItemId));
        capture.outfitSignature = outfitReferenceSignature(captureItems);
        capture.repeatedOutfit ||= proposal.repeatedOutfit;
      }
      const committedCapture = capture;

      const appearances: GarmentAppearance[] = resolvedItems.map((item) => {
        const duplicate = state.appearances.find((appearance) =>
          appearance.closetItemId === item.resolvedClosetItemId &&
          appearance.appearanceAssetId === item.appearanceAsset.assetId);
        if (duplicate) {
          duplicate.captureId = committedCapture.captureId;
          return duplicate;
        }
        const appearance: GarmentAppearance = {
          appearanceId: makeId('garment_appearance'),
          userId: proposal.userId,
          closetItemId: item.resolvedClosetItemId,
          observationId: proposal.observation.observationId,
          captureId: committedCapture.captureId,
          descriptor: descriptorFromObservation(item.observation),
          appearanceFingerprint: item.identity.appearanceFingerprint,
          appearanceAssetId: item.appearanceAsset.assetId,
          boundingBox: item.observation.boundingBox,
          confidence: item.observation.confidence,
          capturedAt: proposal.packet.capturedAt,
        };
        state.appearances.push(appearance);
        return appearance;
      });
      const wearEvents: WearEvent[] = resolvedItems.map((item) => {
        const existingWear = state.wearEvents.find((wear) =>
          wear.episodeId === proposal.episodeId &&
          wear.closetItemId === item.resolvedClosetItemId);
        if (existingWear) {
          existingWear.captureId = committedCapture.captureId;
          return existingWear;
        }
        const wear: WearEvent = {
          wearEventId: makeId('wear_event'),
          userId: proposal.userId,
          closetItemId: item.resolvedClosetItemId,
          captureId: committedCapture.captureId,
          episodeId: proposal.episodeId,
          wornAt: proposal.packet.capturedAt,
        };
        state.wearEvents.push(wear);
        return wear;
      });

      state.committedIdempotencyKeys = unique([...state.committedIdempotencyKeys, proposal.idempotencyKey]);
      if (createdCapture) state.events.push(event(proposal.userId, 'outfit_captured', now, { captureId: committedCapture.captureId }));
      for (const wearEvent of wearEvents) {
        if (!state.events.some((entry) =>
          entry.type === 'wear_recorded' &&
          entry.captureId === committedCapture.captureId &&
          entry.closetItemId === wearEvent.closetItemId)) {
          state.events.push(event(proposal.userId, 'wear_recorded', now, {
            captureId: committedCapture.captureId,
            closetItemId: wearEvent.closetItemId,
          }));
        }
      }
      reconcileEpisodeCaptures(state, proposal.episodeId);
      capture = state.captures.find((entry) =>
        entry.episodeId === proposal.episodeId &&
        entry.outfitSignature === proposal.outfitSignature) ?? capture;
      const episode = state.episodes.find((item) => item.episodeId === proposal.episodeId);
      if (episode) {
        episode.status = 'captured';
        episode.lastCaptureId = capture.captureId;
      }
      bump(state, now);
      await this.writeFile(file);
      return {
        status: 'committed',
        capture: structuredClone(capture),
        createdClosetItemIds,
        recognizedClosetItemIds,
        appearances: structuredClone(appearances),
        wearEvents: structuredClone(wearEvents),
      };
    });
  }

  async getAsset(userId: string, assetId: string): Promise<GarmentImageAsset | undefined> {
    const state = await this.getState(userId);
    return structuredClone(state.assets.find((asset) => asset.assetId === assetId));
  }

  async beginProductImageJob(
    userId: string,
    closetItemId: string,
    sourceAppearanceAssetId: string,
    occurredAt = new Date().toISOString(),
  ): Promise<ProductImageJob> {
    return this.exclusive(async () => {
      const file = await this.readFile();
      const state = ensureUser(file, userId);
      const existing = state.productImageJobs.find((job) =>
        job.closetItemId === closetItemId && job.sourceAppearanceAssetId === sourceAppearanceAssetId && job.status !== 'failed'
      );
      if (existing) return structuredClone(existing);
      const job: ProductImageJob = {
        jobId: makeId('product_image_job'), userId, closetItemId, sourceAppearanceAssetId,
        status: 'processing', attemptCount: 1, createdAt: occurredAt, updatedAt: occurredAt,
      };
      state.productImageJobs.push(job);
      const entry = state.closetItems.find((item) => item.item.id === closetItemId);
      if (entry) entry.item.imageStatus = 'processing';
      state.events.push(event(userId, 'product_image_generation_started', occurredAt, { closetItemId, jobId: job.jobId }));
      bump(state, occurredAt);
      await this.writeFile(file);
      return structuredClone(job);
    });
  }

  async completeProductImageJob(input: {
    userId: string;
    jobId: string;
    productAsset: GarmentImageAsset;
    verification: ProductImageVerification;
    threshold: number;
    occurredAt?: string;
  }): Promise<{ ready: boolean; item?: AmbientClosetItem }> {
    return this.exclusive(async () => {
      const occurredAt = input.occurredAt ?? new Date().toISOString();
      const file = await this.readFile();
      const state = ensureUser(file, input.userId);
      const job = state.productImageJobs.find((item) => item.jobId === input.jobId);
      if (!job) throw new Error('PRODUCT_IMAGE_JOB_NOT_FOUND');
      if (job.status === 'ready') {
        return { ready: true, item: structuredClone(state.closetItems.find((entry) => entry.item.id === job.closetItemId)) };
      }
      const productAsset = structuredClone(input.productAsset);
      productAsset.verification = structuredClone(input.verification);
      const criticalMismatch = hasCriticalProductMismatch(input.verification);
      const passed = input.verification.result === 'pass' && input.verification.confidence >= input.threshold && !criticalMismatch;
      productAsset.verificationStatus = passed ? 'passed' : input.verification.result === 'uncertain' ? 'uncertain' : 'failed';
      state.assets.push(productAsset);
      job.productAssetId = productAsset.assetId;
      job.status = passed ? 'ready' : 'needs_review';
      job.failureCode = passed ? undefined : criticalMismatch ? 'CRITICAL_PRODUCT_IDENTITY_MISMATCH' : 'PRODUCT_IMAGE_VERIFICATION_FAILED';
      job.updatedAt = occurredAt;
      const entry = state.closetItems.find((item) => item.item.id === job.closetItemId);
      if (entry) {
        entry.item.imageStatus = passed ? 'ready' : 'needs_review';
        if (passed) {
          entry.item.primaryImageAssetId = productAsset.assetId;
          entry.item.imageUrl = productAsset.imageUrl;
        }
        entry.updatedAt = occurredAt;
      }
      state.events.push(event(input.userId, 'product_image_generated', occurredAt, {
        closetItemId: job.closetItemId, assetId: productAsset.assetId, jobId: job.jobId,
      }));
      state.events.push(event(input.userId, 'product_image_verified', occurredAt, {
        closetItemId: job.closetItemId, assetId: productAsset.assetId, jobId: job.jobId,
        reasonCode: passed ? 'VERIFIED' : job.failureCode,
      }));
      state.events.push(event(input.userId, passed ? 'closet_primary_image_updated' : 'product_image_failed', occurredAt, {
        closetItemId: job.closetItemId, assetId: productAsset.assetId, jobId: job.jobId,
        reasonCode: job.failureCode,
      }));
      bump(state, occurredAt);
      await this.writeFile(file);
      return { ready: passed, item: entry ? structuredClone(entry) : undefined };
    });
  }

  async failProductImageJob(userId: string, jobId: string, failureCode: string, occurredAt = new Date().toISOString()): Promise<void> {
    await this.exclusive(async () => {
      const file = await this.readFile();
      const state = ensureUser(file, userId);
      const job = state.productImageJobs.find((item) => item.jobId === jobId);
      if (!job) throw new Error('PRODUCT_IMAGE_JOB_NOT_FOUND');
      job.status = 'failed';
      job.failureCode = failureCode;
      job.updatedAt = occurredAt;
      const entry = state.closetItems.find((item) => item.item.id === job.closetItemId);
      if (entry) {
        entry.item.imageStatus = 'needs_review';
        entry.updatedAt = occurredAt;
      }
      state.events.push(event(userId, 'product_image_failed', occurredAt, {
        closetItemId: job.closetItemId, jobId, reasonCode: failureCode,
      }));
      bump(state, occurredAt);
      await this.writeFile(file);
    });
  }

  async setPendingCompletionEvent(userId: string, completionEvent: UserWardrobeState['pendingCompletionEvent']): Promise<void> {
    await this.exclusive(async () => {
      const file = await this.readFile();
      const state = ensureUser(file, userId);
      state.pendingCompletionEvent = completionEvent ? structuredClone(completionEvent) : undefined;
      bump(state, new Date().toISOString());
      await this.writeFile(file);
    });
  }

  async refreshPendingCompletionEventImages(
    userId: string,
    captureId: string,
    occurredAt = new Date().toISOString(),
  ): Promise<UserWardrobeState['pendingCompletionEvent']> {
    return this.exclusive(async () => {
      const file = await this.readFile();
      const state = ensureUser(file, userId);
      const completionEvent = state.pendingCompletionEvent;
      if (!completionEvent || completionEvent.captureId !== captureId) return undefined;
      completionEvent.itemSummaries = completionEvent.itemSummaries.map((summary) => {
        const ambient = state.closetItems.find((entry) => entry.item.id === summary.closetItemId)?.item;
        if (!ambient) return summary;
        return {
          ...summary,
          imageUrl: ambient.imageStatus === 'ready' ? ambient.imageUrl : summary.imageUrl,
          imageStatus: ambient.imageStatus,
        };
      });
      bump(state, occurredAt);
      await this.writeFile(file);
      return structuredClone(completionEvent);
    });
  }

  async acknowledgeCompletion(userId: string, occurredAt = new Date().toISOString()): Promise<boolean> {
    return this.exclusive(async () => {
      const file = await this.readFile();
      const state = ensureUser(file, userId);
      if (!state.pendingCompletionEvent) return false;
      state.pendingCompletionEvent.acknowledgedAt = occurredAt;
      state.pendingCompletionEvent = undefined;
      bump(state, occurredAt);
      await this.writeFile(file);
      return true;
    });
  }

  async resetUser(userId: string): Promise<void> {
    await this.exclusive(async () => {
      const file = await this.readFile();
      delete file.users[userId];
      await this.writeFile(file);
    });
  }

  private async readFile(): Promise<WardrobeRepositoryFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as WardrobeRepositoryFile;
      if (parsed.schemaVersion !== 1 || !parsed.users || typeof parsed.users !== 'object') {
        throw new Error('Unsupported ambient wardrobe repository schema.');
      }
      for (const state of Object.values(parsed.users)) normalizeUserState(state);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, users: {} };
      }
      throw error;
    }
  }

  private async writeFile(file: WardrobeRepositoryFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, this.filePath);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release: () => void = () => undefined;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function emptyUserState(userId: string): UserWardrobeState {
  return {
    schemaVersion: 1,
    userId,
    version: 0,
    assets: [],
    closetItems: [],
    appearances: [],
    captures: [],
    wearEvents: [],
    episodes: [],
    committedIdempotencyKeys: [],
    productImageJobs: [],
    identityDecisionTraces: [],
    pendingIdentityResolutions: [],
    closetItemAliases: {},
    events: [],
    updatedAt: new Date(0).toISOString(),
  };
}

function normalizeUserState(state: UserWardrobeState): void {
  state.assets ??= [];
  state.productImageJobs ??= [];
  state.events ??= [];
  state.closetItems ??= [];
  state.appearances ??= [];
  state.captures ??= [];
  state.wearEvents ??= [];
  state.episodes ??= [];
  state.committedIdempotencyKeys ??= [];
  state.identityDecisionTraces ??= [];
  state.pendingIdentityResolutions ??= [];
  state.closetItemAliases ??= {};
  for (const capture of state.captures) {
    capture.items ??= capture.closetItemIds.map((closetItemId) => ({
      type: 'closet_item' as const,
      closetItemId,
      slot: inferLegacySlot(state, closetItemId),
    }));
  }
  state.pendingIdentityResolutions = state.pendingIdentityResolutions.map((resolution) => {
    const legacyState = resolution.state as string;
    const track = state.episodes.flatMap((episode) => episode.garmentTracks ?? [])
      .find((candidate) => candidate.trackId === resolution.trackId);
    const lockedDescriptor = resolution.lockedDescriptor ?? track?.descriptor ?? legacyDescriptor(resolution);
    return {
      ...resolution,
      state: legacyState === 'pending_confirmation'
        ? 'ready_to_ask'
        : legacyState === 'deferred_until_next_episode' ? 'deferred' : resolution.state,
      lockedDescriptor,
      evidenceSignatures: resolution.evidenceSignatures ?? resolution.currentEvidenceAssetIds.flatMap((assetId) => {
        const evidence = track?.identityEvidence.find((entry) => entry.assetId === assetId);
        const asset = state.assets.find((entry) => entry.assetId === assetId);
        return evidence ? [{
          assetId,
          perceptualHash: asset?.perceptualHash,
          boundingBox: evidence.boundingBox ?? { x: 0, y: 0, width: 1, height: 1 },
          descriptor: evidence.descriptor,
          coverage: evidence.coverage ?? 'upper_body',
        }] : [];
      }),
      candidateHistoryClosetItemIds: resolution.candidateHistoryClosetItemIds ?? resolution.candidateClosetItemIds ?? [],
      candidateSummaries: resolution.candidateSummaries ?? [],
    };
  });
  for (const entry of state.closetItems) {
    const legacyStatus = entry.status as string;
    if (legacyStatus === 'provisional' || legacyStatus === 'confirmed') entry.status = 'active';
    if (entry.item.source === 'mirror_auto_capture') {
      entry.item.identityStatus ??= 'provisional';
      entry.item.ownershipStatus ??= 'unverified';
    }
  }
}

function inferLegacySlot(state: UserWardrobeState, closetItemId: string): 'top' | 'bottom' | 'outerwear' | 'shoes' | 'bag' | 'accessory' | 'dress' {
  const category = state.closetItems.find((entry) => entry.item.id === closetItemId)?.item.category;
  if (category === 'top' || category === 'bottom' || category === 'outerwear' || category === 'shoes' || category === 'bag' || category === 'accessory' || category === 'dress') return category;
  return 'accessory';
}

function legacyDescriptor(resolution: PendingIdentityResolution): PendingIdentityResolution['lockedDescriptor'] {
  return {
    slot: resolution.slot ?? 'accessory',
    category: resolution.category ?? 'accessory',
    dominantColor: 'unknown',
    secondaryColors: [],
    pattern: 'other',
    silhouette: 'unknown',
    fit: 'unknown',
    distinctiveFeatures: [],
  };
}

function isLivePendingResolution(resolution: PendingIdentityResolution): boolean {
  return resolution.state === 'awaiting_evidence' ||
    resolution.state === 'ready_to_ask' ||
    resolution.state === 'deferred';
}

function pruneOrphanTrackIdentityEvidenceFromState(state: UserWardrobeState): GarmentImageAsset[] {
  const liveAssetIds = new Set<string>();
  for (const episode of state.episodes) {
    if (episode.status === 'ended') continue;
    for (const track of episode.garmentTracks ?? []) {
      for (const evidence of track.identityEvidence) liveAssetIds.add(evidence.assetId);
    }
  }
  for (const resolution of state.pendingIdentityResolutions) {
    if (!isLivePendingResolution(resolution)) continue;
    for (const assetId of resolution.currentEvidenceAssetIds) liveAssetIds.add(assetId);
  }

  const removed = state.assets.filter((asset) =>
    asset.role === 'track_identity_evidence' && !liveAssetIds.has(asset.assetId));
  if (!removed.length) return [];

  const removedIds = new Set(removed.map((asset) => asset.assetId));
  state.assets = state.assets.filter((asset) => !removedIds.has(asset.assetId));
  for (const episode of state.episodes) {
    if (!episode.garmentTracks) continue;
    episode.garmentTracks = episode.garmentTracks.map((track) => ({
      ...track,
      identityEvidence: track.identityEvidence.filter((evidence) => !removedIds.has(evidence.assetId)),
    }));
  }
  state.pendingIdentityResolutions = state.pendingIdentityResolutions.map((resolution) =>
    isLivePendingResolution(resolution)
      ? resolution
      : {
          ...resolution,
          currentEvidenceAssetIds: resolution.currentEvidenceAssetIds.filter((assetId) => !removedIds.has(assetId)),
        });
  return removed;
}

function applyPendingIdentityResolution(
  state: UserWardrobeState,
  input: {
    userId: string;
    resolutionId: string;
    closetItemId: string;
    state: 'resolved_existing' | 'resolved_new';
    occurredAt?: string;
  },
): Set<string> {
  const resolution = state.pendingIdentityResolutions.find((entry) => entry.resolutionId === input.resolutionId);
  if (!resolution) throw new Error('PENDING_IDENTITY_RESOLUTION_NOT_FOUND');
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  resolution.state = input.state;
  resolution.updatedAt = occurredAt;
  const pendingCompletionEvent = state.pendingCompletionEvent;
  const pendingSummary = pendingCompletionEvent?.pendingItems.find((item) => item.resolutionId === input.resolutionId);
  if (pendingCompletionEvent && pendingSummary) {
    pendingCompletionEvent.pendingItems = pendingCompletionEvent.pendingItems.filter((item) =>
      item.resolutionId !== input.resolutionId);
    if (input.state === 'resolved_new') {
      pendingCompletionEvent.newItemIds = unique([...pendingCompletionEvent.newItemIds, input.closetItemId]);
    } else {
      pendingCompletionEvent.recognizedItemIds = unique([
        ...pendingCompletionEvent.recognizedItemIds,
        input.closetItemId,
      ]);
    }
    if (!pendingCompletionEvent.itemSummaries.some((summary) => summary.closetItemId === input.closetItemId)) {
      const ambient = state.closetItems.find((entry) => entry.item.id === input.closetItemId)?.item;
      pendingCompletionEvent.itemSummaries.push({
        closetItemId: input.closetItemId,
        slot: pendingSummary.slot,
        label: ambient?.name ?? pendingSummary.label,
        status: input.state === 'resolved_new' ? 'new' : 'recognized',
        imageUrl: ambient?.imageStatus === 'ready' ? ambient.imageUrl : undefined,
        imageStatus: ambient?.imageStatus ?? (input.state === 'resolved_new' ? 'processing' : 'ready'),
      });
    }
    pendingCompletionEvent.completionStatus = pendingCompletionEvent.pendingItems.length > 0
      ? 'partially_resolved'
      : pendingCompletionEvent.newItemIds.length > 0 ? 'fully_resolved' : 'fully_recognized';
  }
  const affectedEpisodes = new Set<string>();
  for (const capture of state.captures) {
    if (!capture.items.some((item) => item.type === 'pending_identity' && item.resolutionId === input.resolutionId)) continue;
    capture.items = capture.items.map((item) => item.type === 'pending_identity' && item.resolutionId === input.resolutionId
      ? { type: 'closet_item' as const, closetItemId: input.closetItemId, slot: item.slot }
      : item);
    capture.closetItemIds = unique(capture.items.flatMap((item) => item.type === 'closet_item' ? [item.closetItemId] : []));
    capture.outfitSignature = outfitReferenceSignature(capture.items);
    affectedEpisodes.add(capture.episodeId);
    const existingWear = state.wearEvents.find((wear) =>
      wear.episodeId === capture.episodeId && wear.closetItemId === input.closetItemId);
    if (existingWear) {
      existingWear.captureId = capture.captureId;
    } else {
      state.wearEvents.push({
        wearEventId: makeId('wear_event'),
        userId: input.userId,
        closetItemId: input.closetItemId,
        captureId: capture.captureId,
        episodeId: capture.episodeId,
        wornAt: capture.capturedAt,
      });
    }
  }
  return affectedEpisodes;
}

function reconcileEpisodeCaptures(state: UserWardrobeState, episodeId: string): void {
  const episodeCaptures = state.captures
    .filter((capture) => capture.episodeId === episodeId)
    .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt) || left.captureId.localeCompare(right.captureId));
  for (const capture of episodeCaptures) {
    capture.closetItemIds = unique(capture.items.flatMap((item) => item.type === 'closet_item' ? [item.closetItemId] : []));
    capture.outfitSignature = outfitReferenceSignature(capture.items);
  }

  const canonicalBySignature = new Map<string, OutfitCapture>();
  const duplicateToCanonical = new Map<string, string>();
  for (const capture of episodeCaptures) {
    const canonical = canonicalBySignature.get(capture.outfitSignature);
    if (!canonical) canonicalBySignature.set(capture.outfitSignature, capture);
    else duplicateToCanonical.set(capture.captureId, canonical.captureId);
  }
  if (duplicateToCanonical.size > 0) {
    for (const appearance of state.appearances) {
      appearance.captureId = duplicateToCanonical.get(appearance.captureId) ?? appearance.captureId;
    }
    for (const wear of state.wearEvents) {
      wear.captureId = duplicateToCanonical.get(wear.captureId) ?? wear.captureId;
    }
    for (const wardrobeEvent of state.events) {
      if (wardrobeEvent.captureId) wardrobeEvent.captureId = duplicateToCanonical.get(wardrobeEvent.captureId) ?? wardrobeEvent.captureId;
    }
    if (state.pendingCompletionEvent?.captureId) {
      state.pendingCompletionEvent.captureId = duplicateToCanonical.get(state.pendingCompletionEvent.captureId) ?? state.pendingCompletionEvent.captureId;
    }
    state.captures = state.captures.filter((capture) => !duplicateToCanonical.has(capture.captureId));
  }

  const wearByGarment = new Map<string, WearEvent>();
  state.wearEvents = state.wearEvents.filter((wear) => {
    if (wear.episodeId !== episodeId) return true;
    const key = `${wear.episodeId}:${wear.closetItemId}`;
    const existing = wearByGarment.get(key);
    if (!existing) {
      wearByGarment.set(key, wear);
      return true;
    }
    if (wear.wornAt < existing.wornAt) {
      existing.wornAt = wear.wornAt;
    }
    return false;
  });
  state.events = state.events.filter((entry, index, all) => {
    if (!entry.captureId || (entry.type !== 'outfit_captured' && entry.type !== 'wear_recorded')) return true;
    return all.findIndex((candidate) =>
      candidate.type === entry.type &&
      candidate.captureId === entry.captureId &&
      candidate.closetItemId === entry.closetItemId) === index;
  });
  const episode = state.episodes.find((entry) => entry.episodeId === episodeId);
  if (episode?.lastCaptureId) episode.lastCaptureId = duplicateToCanonical.get(episode.lastCaptureId) ?? episode.lastCaptureId;
}

function sanitizeIdentityTrace(trace: GarmentIdentityDecisionTrace): GarmentIdentityDecisionTrace {
  const cloned = structuredClone(trace);
  const serialized = JSON.stringify(cloned);
  if (/data:image\/|;base64,/i.test(serialized)) {
    throw new Error('Identity traces must not contain image payloads.');
  }
  if (containsAbsolutePath(cloned)) {
    throw new Error('Identity traces must not contain absolute paths.');
  }
  return cloned;
}

function containsAbsolutePath(value: unknown): boolean {
  if (typeof value === 'string') return /^(?:\/|[A-Za-z]:\\)/.test(value);
  if (Array.isArray(value)) return value.some(containsAbsolutePath);
  if (value && typeof value === 'object') return Object.values(value).some(containsAbsolutePath);
  return false;
}

function ensureUser(file: WardrobeRepositoryFile, userId: string): UserWardrobeState {
  file.users[userId] ??= emptyUserState(userId);
  return file.users[userId]!;
}

function bump(state: UserWardrobeState, now: string): void {
  state.version += 1;
  state.updatedAt = now;
}

function appendLimited(values: string[], value: string, limit: number): string[] {
  return [...values.filter((item) => item !== value), value].slice(-limit);
}

function event(
  userId: string,
  type: WardrobeEventType,
  createdAt: string,
  details: Pick<WardrobeEvent, 'closetItemId' | 'captureId' | 'assetId' | 'jobId' | 'reasonCode'> = {},
): WardrobeEvent {
  return { eventId: makeId('wardrobe_event'), userId, type, createdAt, ...details };
}

function hasCriticalProductMismatch(verification: ProductImageVerification): boolean {
  const checks = verification.checks;
  if (!checks.colorMatch || !checks.patternMatch) return true;
  return ['necklineMatch', 'closureMatch', 'pocketMatch', 'silhouetteMatch', 'lengthMatch', 'logoMatch']
    .some((key) => checks[key as keyof typeof checks] === false);
}

function previewMerge(
  state: UserWardrobeState,
  canonicalItemId: string,
  duplicateItemId: string,
): ClosetItemMergePreview {
  const base = {
    userId: state.userId,
    canonicalItemId,
    duplicateItemId,
    migrations: {
      appearances: state.appearances.filter((item) => item.closetItemId === duplicateItemId).length,
      assets: state.assets.filter((item) => item.closetItemId === duplicateItemId).length,
      wearEvents: state.wearEvents.filter((item) => item.closetItemId === duplicateItemId).length,
      outfitCaptures: state.captures.filter((item) => item.closetItemIds.includes(duplicateItemId)).length,
      productImageJobs: state.productImageJobs.filter((item) => item.closetItemId === duplicateItemId).length,
      completionSummaries: state.pendingCompletionEvent?.itemSummaries
        .filter((item) => item.closetItemId === duplicateItemId).length ?? 0,
      wardrobeEvents: state.events.filter((item) => item.closetItemId === duplicateItemId).length,
      identityDecisionTraces: state.identityDecisionTraces.filter((trace) => traceReferences(trace, duplicateItemId)).length,
    },
    primaryImageWillChange: false,
  };
  if (canonicalItemId === duplicateItemId) {
    return { ...base, status: 'blocked', blocker: 'CLOSET_ITEM_MERGE_IDS_MUST_DIFFER' };
  }
  const canonical = state.closetItems.find((entry) => entry.item.id === canonicalItemId);
  const duplicate = state.closetItems.find((entry) => entry.item.id === duplicateItemId);
  if (state.closetItemAliases[duplicateItemId] === canonicalItemId && canonical && duplicate?.mergedIntoItemId === canonicalItemId) {
    return { ...base, status: 'already_merged' };
  }
  if (!canonical || !duplicate) {
    return { ...base, status: 'blocked', blocker: 'CLOSET_ITEM_NOT_FOUND_FOR_USER' };
  }
  if (canonical.source !== 'ambient_capture' || duplicate.source !== 'ambient_capture' ||
      canonical.item.source === 'demo_fixture' || duplicate.item.source === 'demo_fixture') {
    return { ...base, status: 'blocked', blocker: 'BASE_CLOSET_ITEMS_CANNOT_BE_MERGED' };
  }
  if (canonical.status !== 'active' || canonical.item.identityStatus === 'merged') {
    return { ...base, status: 'blocked', blocker: 'CANONICAL_ITEM_IS_NOT_ACTIVE' };
  }
  if (duplicate.status !== 'active' || duplicate.item.identityStatus === 'merged') {
    return { ...base, status: 'blocked', blocker: 'DUPLICATE_ITEM_IS_NOT_ACTIVE' };
  }
  return {
    ...base,
    status: 'ready',
    primaryImageWillChange: !hasReadyPrimary(state, canonical) && hasReadyPrimary(state, duplicate),
  };
}

function hasReadyPrimary(state: UserWardrobeState, entry: AmbientClosetItem): boolean {
  if (entry.item.imageStatus !== 'ready' || !entry.item.primaryImageAssetId) return false;
  return state.assets.some((asset) =>
    asset.assetId === entry.item.primaryImageAssetId && asset.verificationStatus === 'passed');
}

function outfitSignature(closetItemIds: string[]): string {
  return createHash('sha256').update([...closetItemIds].sort().join('|')).digest('hex').slice(0, 24);
}

function outfitReferenceSignature(items: OutfitItemRef[]): string {
  return createHash('sha256')
    .update(items.map((item) => item.type === 'closet_item'
      ? item.closetItemId
      : `pending:${item.resolutionId}`).sort().join('|'))
    .digest('hex')
    .slice(0, 24);
}

function migrateTraceItemId(trace: GarmentIdentityDecisionTrace, duplicateItemId: string, canonicalItemId: string): void {
  for (const candidate of trace.recall.candidates) {
    if (candidate.closetItemId === duplicateItemId) candidate.closetItemId = canonicalItemId;
  }
  trace.recall.candidates = dedupeTraceCandidates(trace.recall.candidates);
  for (const verification of trace.pairwiseVerifications) {
    if (verification.candidateClosetItemId === duplicateItemId) verification.candidateClosetItemId = canonicalItemId;
  }
  trace.pairwiseVerifications = dedupePairwiseTraces(trace.pairwiseVerifications);
  if (trace.matchedClosetItemId === duplicateItemId) trace.matchedClosetItemId = canonicalItemId;
}

function traceReferences(trace: GarmentIdentityDecisionTrace, closetItemId: string): boolean {
  return trace.matchedClosetItemId === closetItemId ||
    trace.recall.candidates.some((candidate) => candidate.closetItemId === closetItemId) ||
    trace.pairwiseVerifications.some((verification) => verification.candidateClosetItemId === closetItemId);
}

function dedupeTraceCandidates(
  candidates: GarmentIdentityDecisionTrace['recall']['candidates'],
): GarmentIdentityDecisionTrace['recall']['candidates'] {
  const byId = new Map<string, GarmentIdentityDecisionTrace['recall']['candidates'][number]>();
  for (const candidate of candidates) {
    const previous = byId.get(candidate.closetItemId);
    if (!previous || candidate.effectivePrior > previous.effectivePrior) byId.set(candidate.closetItemId, candidate);
  }
  return [...byId.values()];
}

function dedupePairwiseTraces(
  verifications: GarmentIdentityDecisionTrace['pairwiseVerifications'],
): GarmentIdentityDecisionTrace['pairwiseVerifications'] {
  const byId = new Map<string, GarmentIdentityDecisionTrace['pairwiseVerifications'][number]>();
  for (const verification of verifications) {
    if (!byId.has(verification.candidateClosetItemId)) byId.set(verification.candidateClosetItemId, verification);
  }
  return [...byId.values()];
}

function dedupeCompletionSummaries(
  summaries: NonNullable<UserWardrobeState['pendingCompletionEvent']>['itemSummaries'],
): NonNullable<UserWardrobeState['pendingCompletionEvent']>['itemSummaries'] {
  const byId = new Map<string, NonNullable<UserWardrobeState['pendingCompletionEvent']>['itemSummaries'][number]>();
  for (const summary of summaries) if (!byId.has(summary.closetItemId)) byId.set(summary.closetItemId, summary);
  return [...byId.values()];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function earliest(...values: string[]): string {
  return [...values].sort()[0]!;
}

function latest(...values: string[]): string {
  return [...values].sort().at(-1)!;
}

function resolveAlias(aliases: Record<string, string>, closetItemId: string): string {
  let current = closetItemId;
  const visited = new Set<string>();
  while (aliases[current] && !visited.has(current)) {
    visited.add(current);
    current = aliases[current]!;
  }
  return current;
}

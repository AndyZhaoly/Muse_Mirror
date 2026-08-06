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
  ClosetItemMergePreview,
  MergeClosetItemsResult,
  OutfitCapture,
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
      const existing = state.captures.find((capture) =>
        state.committedIdempotencyKeys.includes(proposal.idempotencyKey) &&
        capture.episodeId === proposal.episodeId &&
        capture.outfitSignature === proposal.outfitSignature
      );
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

      const now = new Date().toISOString();
      const captureId = makeId('outfit_capture');
      const createdClosetItemIds: string[] = [];
      const recognizedClosetItemIds: string[] = [];
      for (const item of proposal.items) {
        const appearanceAsset = structuredClone(item.appearanceAsset);
        appearanceAsset.closetItemId = item.resolvedClosetItemId;
        state.assets.push(appearanceAsset);
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

      state.assets.push(structuredClone(proposal.evidenceAsset));
      state.events.push(event(proposal.userId, 'capture_evidence_stored', now, {
        assetId: proposal.evidenceAsset.assetId,
      }));

      const capture: OutfitCapture = {
        captureId,
        userId: proposal.userId,
        sessionId: proposal.sessionId,
        episodeId: proposal.episodeId,
        observationId: proposal.observation.observationId,
        closetItemIds: proposal.items.map((item) => item.resolvedClosetItemId),
        outfitSignature: proposal.outfitSignature,
        repeatedOutfit: proposal.repeatedOutfit,
        evidenceImageUrl: proposal.evidenceAsset.imageUrl,
        capturedAt: proposal.packet.capturedAt,
        committedAt: now,
      };
      const appearances: GarmentAppearance[] = proposal.items.map((item) => ({
        appearanceId: makeId('garment_appearance'),
        userId: proposal.userId,
        closetItemId: item.resolvedClosetItemId,
        observationId: proposal.observation.observationId,
        captureId,
        descriptor: descriptorFromObservation(item.observation),
        appearanceFingerprint: item.identity.appearanceFingerprint,
        appearanceAssetId: item.appearanceAsset.assetId,
        boundingBox: item.observation.boundingBox,
        confidence: item.observation.confidence,
        capturedAt: proposal.packet.capturedAt,
      }));
      const wearEvents: WearEvent[] = proposal.items.map((item) => ({
        wearEventId: makeId('wear_event'),
        userId: proposal.userId,
        closetItemId: item.resolvedClosetItemId,
        captureId,
        episodeId: proposal.episodeId,
        wornAt: proposal.packet.capturedAt,
      }));

      state.captures.push(capture);
      state.appearances.push(...appearances);
      state.wearEvents.push(...wearEvents);
      state.committedIdempotencyKeys.push(proposal.idempotencyKey);
      state.events.push(event(proposal.userId, 'outfit_captured', now, { captureId }));
      for (const wearEvent of wearEvents) {
        state.events.push(event(proposal.userId, 'wear_recorded', now, {
          captureId,
          closetItemId: wearEvent.closetItemId,
        }));
      }
      const episode = state.episodes.find((item) => item.episodeId === proposal.episodeId);
      if (episode) {
        episode.status = 'captured';
        episode.lastCaptureId = captureId;
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
  state.closetItemAliases ??= {};
  for (const entry of state.closetItems) {
    const legacyStatus = entry.status as string;
    if (legacyStatus === 'provisional' || legacyStatus === 'confirmed') entry.status = 'active';
    if (entry.item.source === 'mirror_auto_capture') {
      entry.item.identityStatus ??= 'provisional';
      entry.item.ownershipStatus ??= 'unverified';
    }
  }
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

import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AmbientCaptureGrant,
  AmbientOutfitEpisode,
  CommitOutfitCaptureCommand,
  GarmentAppearance,
  OutfitCapture,
  OutfitCaptureCommitResult,
  UserWardrobeState,
  WearEvent,
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
}

export class JsonUserWardrobeRepository implements WardrobeRepository {
  private operation = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async getState(userId: string): Promise<UserWardrobeState> {
    const file = await this.readFile();
    return structuredClone(file.users[userId] ?? emptyUserState(userId));
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
        if (item.createItem) {
          if (state.closetItems.some((existingItem) => existingItem.item.id === item.createItem?.item.id)) {
            throw new Error(`Duplicate ambient closet item ID: ${item.createItem.item.id}`);
          }
          state.closetItems.push(structuredClone(item.createItem));
          createdClosetItemIds.push(item.resolvedClosetItemId);
        } else {
          recognizedClosetItemIds.push(item.resolvedClosetItemId);
        }
      }

      const capture: OutfitCapture = {
        captureId,
        userId: proposal.userId,
        sessionId: proposal.sessionId,
        episodeId: proposal.episodeId,
        observationId: proposal.observation.observationId,
        closetItemIds: proposal.items.map((item) => item.resolvedClosetItemId),
        outfitSignature: proposal.outfitSignature,
        repeatedOutfit: proposal.repeatedOutfit,
        evidenceImageUrl: proposal.evidenceImageUrl,
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
        evidenceImageUrl: proposal.evidenceImageUrl,
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
    closetItems: [],
    appearances: [],
    captures: [],
    wearEvents: [],
    episodes: [],
    committedIdempotencyKeys: [],
    updatedAt: new Date(0).toISOString(),
  };
}

function ensureUser(file: WardrobeRepositoryFile, userId: string): UserWardrobeState {
  file.users[userId] ??= emptyUserState(userId);
  return file.users[userId]!;
}

function bump(state: UserWardrobeState, now: string): void {
  state.version += 1;
  state.updatedAt = now;
}

import type { FashionSessionState } from '../types.js';

export interface SessionStateStore {
  get(sessionId: string): FashionSessionState;
  set(sessionId: string, state: FashionSessionState): void;
  clear(sessionId: string): void;
}

export function createEmptySessionState(): FashionSessionState {
  return {
    images: {},
    photoUseGrants: {},
    syntheticExtensionConsents: {},
    outfitSnapshots: {},
    pendingVisualRequests: {},
    tryOnSessions: {},
    visualVersions: {},
    conceptItemAssets: {},
    sessionPreferences: {},
    persistentPreferences: {},
    pendingArtifacts: [],
    toolLog: [],
  };
}

export class InMemorySessionStateStore implements SessionStateStore {
  private readonly states = new Map<string, FashionSessionState>();

  get(sessionId: string): FashionSessionState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = createEmptySessionState();
      this.states.set(sessionId, state);
    }
    return state;
  }

  set(sessionId: string, state: FashionSessionState): void {
    this.states.set(sessionId, state);
  }

  clear(sessionId: string): void {
    this.states.delete(sessionId);
  }
}

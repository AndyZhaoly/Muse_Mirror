import type { FashionSessionState, UiArtifact } from '../types.js';

export function pushArtifact(
  state: FashionSessionState,
  artifact: UiArtifact,
): void {
  state.pendingArtifacts.push(artifact);
}

export function drainArtifacts(state: FashionSessionState): UiArtifact[] {
  const artifacts = [...state.pendingArtifacts];
  state.pendingArtifacts.length = 0;
  return artifacts;
}

export interface FrameStabilitySample {
  pixels: Uint8ClampedArray;
  sourceWidth: number;
  sourceHeight: number;
}

export interface EmptySceneGuardConfig {
  threshold: number;
  confirmations: number;
  forceProbeMs: number;
}

export type EmptySceneGuardState =
  | { status: 'inactive' }
  | {
      status: 'candidate';
      reference: FrameStabilitySample;
      confirmationCount: number;
      firstConfirmedAt: number;
    }
  | {
      status: 'confirmed';
      reference: FrameStabilitySample;
      confirmedAt: number;
      nextForcedProbeAt: number;
    };

export interface EmptySceneGuardEvaluation {
  state: EmptySceneGuardState;
  shouldUpload: boolean;
  skippedUpload: boolean;
  forcedProbe: boolean;
  sceneChanged: boolean;
  difference?: number;
}

export function sampleVideoFrame(
  video: HTMLVideoElement,
  mirror: boolean,
  width = 48,
  height = 36,
): FrameStabilitySample | null {
  if (video.videoWidth < 1 || video.videoHeight < 1) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  if (mirror) {
    context.translate(width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(video, 0, 0, width, height);
  const rgba = context.getImageData(0, 0, width, height).data;
  const pixels = new Uint8ClampedArray(width * height);
  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 1) {
    pixels[target] = Math.round((rgba[source]! * 0.299) + (rgba[source + 1]! * 0.587) + (rgba[source + 2]! * 0.114));
  }
  return { pixels, sourceWidth: video.videoWidth, sourceHeight: video.videoHeight };
}

export function frameStabilityScore(
  previous: FrameStabilitySample | undefined,
  current: FrameStabilitySample,
): number {
  if (!previous || previous.pixels.length !== current.pixels.length) return 0;
  const normalizedDifference = sceneDifference(previous, current);
  return Math.max(0, Math.min(1, 1 - (normalizedDifference * 5)));
}

export function nextStableSampleCount(previousCount: number, score: number): number {
  return score >= 0.9 ? previousCount + 1 : 0;
}

export function sceneDifference(
  reference: FrameStabilitySample,
  current: FrameStabilitySample,
): number {
  if (
    reference.pixels.length !== current.pixels.length
    || reference.sourceWidth !== current.sourceWidth
    || reference.sourceHeight !== current.sourceHeight
  ) return 1;
  if (!current.pixels.length) return 0;
  let difference = 0;
  for (let index = 0; index < current.pixels.length; index += 1) {
    difference += Math.abs(current.pixels[index]! - reference.pixels[index]!);
  }
  return Math.max(0, Math.min(1, difference / (current.pixels.length * 255)));
}

export function matchesEmptyScene(
  reference: FrameStabilitySample,
  current: FrameStabilitySample,
  threshold: number,
): boolean {
  return sceneDifference(reference, current) < threshold;
}

export function evaluateEmptySceneGuard(
  state: EmptySceneGuardState,
  sample: FrameStabilitySample,
  now: number,
  config: EmptySceneGuardConfig,
): EmptySceneGuardEvaluation {
  if (state.status === 'inactive') {
    return {
      state,
      shouldUpload: true,
      skippedUpload: false,
      forcedProbe: false,
      sceneChanged: false,
    };
  }

  const difference = sceneDifference(state.reference, sample);
  if (difference >= config.threshold) {
    return {
      state: { status: 'inactive' },
      shouldUpload: false,
      skippedUpload: false,
      forcedProbe: false,
      sceneChanged: true,
      difference,
    };
  }

  if (state.status === 'candidate') {
    return {
      state,
      shouldUpload: true,
      skippedUpload: false,
      forcedProbe: false,
      sceneChanged: false,
      difference,
    };
  }

  const forcedProbe = now >= state.nextForcedProbeAt;
  return {
    state,
    shouldUpload: forcedProbe,
    skippedUpload: !forcedProbe,
    forcedProbe,
    sceneChanged: false,
    difference,
  };
}

export function confirmEmptyScene(
  state: EmptySceneGuardState,
  sample: FrameStabilitySample,
  now: number,
  config: EmptySceneGuardConfig,
): EmptySceneGuardState {
  if (state.status === 'inactive') {
    return {
      status: 'candidate',
      reference: sample,
      confirmationCount: 1,
      firstConfirmedAt: now,
    };
  }
  if (!matchesEmptyScene(state.reference, sample, config.threshold)) {
    return { status: 'inactive' };
  }
  if (state.status === 'confirmed') {
    return {
      status: 'confirmed',
      reference: sample,
      confirmedAt: state.confirmedAt,
      nextForcedProbeAt: now + config.forceProbeMs,
    };
  }
  const confirmationCount = state.confirmationCount + 1;
  if (confirmationCount < Math.max(2, config.confirmations)) {
    return { ...state, reference: sample, confirmationCount };
  }
  return {
    status: 'confirmed',
    reference: sample,
    confirmedAt: now,
    nextForcedProbeAt: now + config.forceProbeMs,
  };
}

export function resolveEmptySceneObservation(
  state: EmptySceneGuardState,
  sample: FrameStabilitySample,
  now: number,
  config: EmptySceneGuardConfig,
  noPersonPresent: boolean,
): EmptySceneGuardState {
  return noPersonPresent
    ? confirmEmptyScene(state, sample, now, config)
    : { status: 'inactive' };
}

export interface FrameStabilitySample {
  pixels: Uint8ClampedArray;
  sourceWidth: number;
  sourceHeight: number;
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
  let difference = 0;
  for (let index = 0; index < current.pixels.length; index += 1) {
    difference += Math.abs(current.pixels[index]! - previous.pixels[index]!);
  }
  const normalizedDifference = difference / (current.pixels.length * 255);
  return Math.max(0, Math.min(1, 1 - (normalizedDifference * 5)));
}

export function nextStableSampleCount(previousCount: number, score: number): number {
  return score >= 0.9 ? previousCount + 1 : 0;
}

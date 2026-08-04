import type { TurnLatencyTelemetry } from '../agentClient';

type ClientLatencyMilestone =
  | 'speech_end'
  | 'asr_final'
  | 'turn_submitted'
  | 'first_final_answer_delta'
  | 'final_result_ready'
  | 'tts_requested'
  | 'first_tts_audio_chunk'
  | 'playback_completed';

interface ClientLatencyTrace {
  timings: Partial<Record<ClientLatencyMilestone, number>>;
  server?: TurnLatencyTelemetry;
}

const traces = new Map<string, ClientLatencyTrace>();

export function createMuseLatencyTraceId(): string {
  const id = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `voice_${id.replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 80);
}

export function markMuseLatency(traceId: string, milestone: ClientLatencyMilestone): void {
  const trace = traces.get(traceId) ?? { timings: {} };
  if (trace.timings[milestone] === undefined) trace.timings[milestone] = performance.now();
  traces.set(traceId, trace);
}

export function attachMuseServerTelemetry(
  traceId: string,
  telemetry: TurnLatencyTelemetry | undefined,
): void {
  if (!telemetry) return;
  const trace = traces.get(traceId) ?? { timings: {} };
  trace.server = telemetry;
  traces.set(traceId, trace);
}

function difference(
  timings: ClientLatencyTrace['timings'],
  later: ClientLatencyMilestone,
  earlier: ClientLatencyMilestone,
): number | undefined {
  const end = timings[later];
  const start = timings[earlier];
  return end === undefined || start === undefined ? undefined : Math.round(end - start);
}

export function latencyDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  const queryEnabled = new URLSearchParams(window.location.search).get('latency') === '1';
  let stored = false;
  try {
    stored = window.localStorage.getItem('muse_latency_debug') === '1';
  } catch {
    stored = false;
  }
  return queryEnabled || stored;
}

export function finishMuseLatency(traceId: string): void {
  const trace = traces.get(traceId);
  if (!trace) return;
  if (latencyDebugEnabled()) {
    const summary = {
      traceId,
      interactionMode: 'voice',
      asrFinalizeMs: difference(trace.timings, 'asr_final', 'speech_end'),
      firstFinalDeltaMs: difference(trace.timings, 'first_final_answer_delta', 'asr_final'),
      resultReadyMs: difference(trace.timings, 'final_result_ready', 'asr_final'),
      firstAudioMs: difference(trace.timings, 'first_tts_audio_chunk', 'asr_final'),
      playbackCompleteMs: difference(trace.timings, 'playback_completed', 'asr_final'),
      modelRounds: trace.server?.modelRounds,
      usedVision: trace.server?.usedVision,
      textChars: trace.server?.textChars,
      spokenChars: trace.server?.spokenChars,
      inputTokens: trace.server?.inputTokens,
      outputTokens: trace.server?.outputTokens,
      cachedInputTokens: trace.server?.cachedInputTokens,
      serverTimings: trace.server?.timings,
    };
    console.info('[MuseLatency]', summary);
  }
  traces.delete(traceId);
}

import type { TurnLatencyTelemetry } from '../agentClient.js';

type ClientLatencyMilestone =
  | 'speech_end'
  | 'asr_final'
  | 'turn_submitted'
  | 'first_final_answer_delta'
  | 'final_result_ready'
  | 'tts_requested'
  | 'first_tts_audio_chunk'
  | 'playback_completed';

export type SpeechEndSource = 'provider_utterance_end' | 'unavailable';

export interface ClientLatencyTrace {
  traceId: string;
  timings: Partial<Record<ClientLatencyMilestone, number>>;
  speechEndSource?: Extract<SpeechEndSource, 'provider_utterance_end'>;
  server?: TurnLatencyTelemetry;
}

export interface MuseLatencySummary {
  traceId: string;
  interactionMode: 'voice';
  speechEndSource: SpeechEndSource;
  asrFinalizeMs?: number;
  firstFinalDeltaMs?: number;
  resultReadyMs?: number;
  firstAudioMs?: number;
  playbackCompleteMs?: number;
  modelRounds?: number;
  usedVision?: boolean;
  textChars?: number;
  spokenChars?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  serverTimings?: TurnLatencyTelemetry['timings'];
}

const traces = new Map<string, ClientLatencyTrace>();
const completedTraceIds = new Set<string>();
const MAX_COMPLETED_TRACE_IDS = 200;

function rememberCompletedTrace(traceId: string): void {
  completedTraceIds.add(traceId);
  while (completedTraceIds.size > MAX_COMPLETED_TRACE_IDS) {
    const first = completedTraceIds.values().next().value;
    if (typeof first !== 'string') break;
    completedTraceIds.delete(first);
  }
}

function traceForUpdate(traceId: string): ClientLatencyTrace | undefined {
  if (completedTraceIds.has(traceId)) return undefined;
  const trace = traces.get(traceId) ?? { traceId, timings: {} };
  traces.set(traceId, trace);
  return trace;
}

export function createMuseLatencyTraceId(): string {
  const id = typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `voice_${id.replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 80);
}

export function markMuseLatency(
  traceId: string,
  milestone: Exclude<ClientLatencyMilestone, 'speech_end'>,
  at = performance.now(),
): void {
  const trace = traceForUpdate(traceId);
  if (!trace) return;
  if (trace.timings[milestone] === undefined) trace.timings[milestone] = at;
}

export function markProviderSpeechEnd(
  traceId: string,
  at = performance.now(),
): void {
  const trace = traceForUpdate(traceId);
  if (!trace || trace.timings.speech_end !== undefined) return;
  trace.timings.speech_end = at;
  trace.speechEndSource = 'provider_utterance_end';
}

export function markAsrFinal(
  traceId: string,
  at = performance.now(),
): void {
  markMuseLatency(traceId, 'asr_final', at);
}

export function attachMuseServerTelemetry(
  traceId: string,
  telemetry: TurnLatencyTelemetry | undefined,
): void {
  if (!telemetry) return;
  const trace = traceForUpdate(traceId);
  if (!trace) return;
  trace.server = telemetry;
}

function difference(
  timings: ClientLatencyTrace['timings'],
  later: ClientLatencyMilestone,
  earlier: ClientLatencyMilestone,
): number | undefined {
  const end = timings[later];
  const start = timings[earlier];
  if (end === undefined || start === undefined || end < start) return undefined;
  return Math.round(end - start);
}

export function buildMuseLatencySummary(
  trace: ClientLatencyTrace,
): MuseLatencySummary {
  const asrFinalizeMs = difference(trace.timings, 'asr_final', 'speech_end');
  const hasProviderSpeechEnd =
    trace.speechEndSource === 'provider_utterance_end' &&
    asrFinalizeMs !== undefined;
  return {
    traceId: trace.traceId,
    interactionMode: 'voice',
    speechEndSource: hasProviderSpeechEnd ? 'provider_utterance_end' : 'unavailable',
    ...(hasProviderSpeechEnd ? { asrFinalizeMs } : {}),
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

export function finishMuseLatency(traceId: string): MuseLatencySummary | undefined {
  const trace = traces.get(traceId);
  traces.delete(traceId);
  rememberCompletedTrace(traceId);
  if (!trace) return undefined;
  const summary = buildMuseLatencySummary(trace);
  if (latencyDebugEnabled()) console.info('[MuseLatency]', summary);
  return summary;
}

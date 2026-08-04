import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  attachMuseServerTelemetry,
  buildMuseLatencySummary,
  finishMuseLatency,
  markAsrFinal,
  markMuseLatency,
  markProviderSpeechEnd,
  type ClientLatencyTrace,
} from '../web/src/voice/latencyTelemetry.js';

test('voice session records speech_end only from the provider utterance-end callback', () => {
  const source = readFileSync(
    new URL('../web/src/voice/useVoiceSession.ts', import.meta.url),
    'utf8',
  );
  const finalHandler = source.match(/const handleFinal[\s\S]*?\n\s*}, \[/)?.[0] ?? '';
  const utteranceHandler = source.match(/onUtteranceEnd:\s*\(\) => \{[\s\S]*?\n\s*},/)?.[0] ?? '';

  assert.match(finalHandler, /markAsrFinal\(traceId\)/);
  assert.doesNotMatch(finalHandler, /markProviderSpeechEnd|['"]speech_end['"]/);
  assert.match(utteranceHandler, /markProviderSpeechEnd\(traceId\)/);
});

test('provider utterance end produces a real non-negative ASR finalization duration', () => {
  const traceId = 'telemetry_provider_end';
  markProviderSpeechEnd(traceId, 1_000);
  markAsrFinal(traceId, 1_050);
  const summary = finishMuseLatency(traceId);

  assert.equal(summary?.speechEndSource, 'provider_utterance_end');
  assert.equal(summary?.asrFinalizeMs, 50);
});

test('ASR final without utterance end reports unavailable instead of a fabricated zero', () => {
  const traceId = 'telemetry_no_end';
  markAsrFinal(traceId, 2_000);
  const summary = finishMuseLatency(traceId);

  assert.equal(summary?.speechEndSource, 'unavailable');
  assert.equal(summary?.asrFinalizeMs, undefined);
});

test('a late utterance end never creates a negative duration', () => {
  const trace: ClientLatencyTrace = {
    traceId: 'telemetry_late_end',
    speechEndSource: 'provider_utterance_end',
    timings: {
      asr_final: 3_000,
      speech_end: 3_050,
    },
  };
  const summary = buildMuseLatencySummary(trace);

  assert.equal(summary.speechEndSource, 'unavailable');
  assert.equal(summary.asrFinalizeMs, undefined);
});

test('duplicate utterance-end milestones keep the first provider timestamp', () => {
  const traceId = 'telemetry_duplicate_end';
  markProviderSpeechEnd(traceId, 4_000);
  markProviderSpeechEnd(traceId, 4_025);
  markAsrFinal(traceId, 4_060);
  const summary = finishMuseLatency(traceId);

  assert.equal(summary?.asrFinalizeMs, 60);
});

test('completed traces are deleted and late events cannot create a second summary', () => {
  const traceId = 'telemetry_completed';
  markAsrFinal(traceId, 5_000);
  assert.ok(finishMuseLatency(traceId));

  markProviderSpeechEnd(traceId, 5_050);
  markAsrFinal(traceId, 5_100);
  assert.equal(finishMuseLatency(traceId), undefined);

  const nextTraceId = 'telemetry_next_turn';
  markProviderSpeechEnd(nextTraceId, 6_000);
  markAsrFinal(nextTraceId, 6_040);
  assert.equal(finishMuseLatency(nextTraceId)?.asrFinalizeMs, 40);
});

test('latency summary retains safe metrics without transcript, answer, media, or secrets', () => {
  const traceId = 'telemetry_private';
  markProviderSpeechEnd(traceId, 7_000);
  markAsrFinal(traceId, 7_080);
  markMuseLatency(traceId, 'turn_submitted', 7_090);
  markMuseLatency(traceId, 'first_final_answer_delta', 7_400);
  markMuseLatency(traceId, 'final_result_ready', 7_600);
  attachMuseServerTelemetry(traceId, {
    traceId,
    turnId: 'turn_safe',
    interactionMode: 'voice',
    timings: { turn_started: 0, final_result_ready: 510 },
    modelRounds: 2,
    usedVision: true,
    textChars: 42,
    spokenChars: 28,
    inputTokens: 120,
    outputTokens: 24,
  });
  const summary = finishMuseLatency(traceId);
  const serialized = JSON.stringify(summary);

  assert.equal(summary?.asrFinalizeMs, 80);
  assert.equal(summary?.firstFinalDeltaMs, 320);
  assert.equal(summary?.resultReadyMs, 520);
  assert.equal(summary?.modelRounds, 2);
  assert.equal(summary?.usedVision, true);
  assert.doesNotMatch(serialized, /transcript|answer|secret|audio|image|cookie|reasoning/i);
});

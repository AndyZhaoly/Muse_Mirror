import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeAsrAudioRequest,
  encodeAsrFullRequest,
  encodeTtsRequest,
  parseJsonPayload,
  parseProviderError,
  parseVolcFrame,
  VolcMessageFlags,
  VolcMessageType,
} from '../src/services/volcSpeechProtocol.js';

function uint32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function int32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeInt32BE(value);
  return buffer;
}

test('ASR full request round-trips JSON and sequence through the binary protocol', () => {
  const request = { audio: { rate: 16000 }, request: { show_utterances: true } };
  const frame = parseVolcFrame(encodeAsrFullRequest(request, 7));
  assert.equal(frame.messageType, VolcMessageType.FullClientRequest);
  assert.equal(frame.sequence, 7);
  assert.deepEqual(parseJsonPayload(frame), request);
});

test('ASR final audio request preserves PCM and uses a negative sequence', () => {
  const pcm = Buffer.from([1, 2, 3, 4]);
  const frame = parseVolcFrame(encodeAsrAudioRequest(pcm, 9, true));
  assert.equal(frame.messageType, VolcMessageType.AudioOnlyClientRequest);
  assert.equal(frame.flags, VolcMessageFlags.NegativeSequence);
  assert.equal(frame.sequence, -9);
  assert.equal(frame.isLast, true);
  assert.deepEqual(frame.payload, pcm);
});

test('TTS request round-trips as uncompressed JSON', () => {
  const request = { req_params: { text: '你好', speaker: 'demo' } };
  const frame = parseVolcFrame(encodeTtsRequest(request));
  assert.equal(frame.messageType, VolcMessageType.FullClientRequest);
  assert.deepEqual(parseJsonPayload(frame), request);
});

test('TTS audio event parser returns the provider PCM payload', () => {
  const session = Buffer.from('session_1');
  const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const fixture = Buffer.concat([
    Buffer.from([0x11, 0xb4, 0x00, 0x00]),
    int32(352),
    uint32(session.length),
    session,
    uint32(pcm.length),
    pcm,
  ]);
  const frame = parseVolcFrame(fixture);
  assert.equal(frame.messageType, VolcMessageType.AudioOnlyServerResponse);
  assert.equal(frame.event, 352);
  assert.equal(frame.sessionId, 'session_1');
  assert.deepEqual(frame.payload, pcm);
});

test('provider error parser exposes a safe code and message', () => {
  const payload = Buffer.from(JSON.stringify({ message: 'invalid resource id' }));
  const fixture = Buffer.concat([
    Buffer.from([0x11, 0xf0, 0x10, 0x00]),
    uint32(45000000),
    uint32(payload.length),
    payload,
  ]);
  const error = parseProviderError(parseVolcFrame(fixture));
  assert.equal(error.code, 45000000);
  assert.equal(error.message, 'invalid resource id');
});

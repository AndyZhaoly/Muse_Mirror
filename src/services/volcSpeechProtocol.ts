import { gunzipSync, gzipSync } from 'node:zlib';

export const VOLC_PROTOCOL_VERSION = 1;

export enum VolcMessageType {
  FullClientRequest = 1,
  AudioOnlyClientRequest = 2,
  FullServerResponse = 9,
  AudioOnlyServerResponse = 11,
  Error = 15,
}

export enum VolcMessageFlags {
  None = 0,
  PositiveSequence = 1,
  LastNoSequence = 2,
  NegativeSequence = 3,
  WithEvent = 4,
}

export enum VolcSerialization {
  Raw = 0,
  Json = 1,
}

export enum VolcCompression {
  None = 0,
  Gzip = 1,
}

export interface ParsedVolcFrame {
  version: number;
  messageType: VolcMessageType;
  flags: number;
  serialization: VolcSerialization;
  compression: VolcCompression;
  sequence?: number;
  event?: number;
  sessionId?: string;
  errorCode?: number;
  payload: Buffer;
  isLast: boolean;
}

interface EncodeFrameInput {
  messageType: VolcMessageType;
  flags?: number;
  serialization?: VolcSerialization;
  compression?: VolcCompression;
  sequence?: number;
  payload?: Buffer;
}

function readUInt32(buffer: Buffer, offset: number): { value: number; offset: number } {
  if (offset + 4 > buffer.length) throw new Error('Incomplete Volcengine speech frame.');
  return { value: buffer.readUInt32BE(offset), offset: offset + 4 };
}

function readInt32(buffer: Buffer, offset: number): { value: number; offset: number } {
  if (offset + 4 > buffer.length) throw new Error('Incomplete Volcengine speech frame.');
  return { value: buffer.readInt32BE(offset), offset: offset + 4 };
}

function encodeFrame(input: EncodeFrameInput): Buffer {
  const flags = input.flags ?? VolcMessageFlags.None;
  const serialization = input.serialization ?? VolcSerialization.Raw;
  const compression = input.compression ?? VolcCompression.None;
  const payload = input.payload ?? Buffer.alloc(0);
  const chunks: Buffer[] = [
    Buffer.from([
      (VOLC_PROTOCOL_VERSION << 4) | 1,
      (input.messageType << 4) | flags,
      (serialization << 4) | compression,
      0,
    ]),
  ];

  if (flags === VolcMessageFlags.PositiveSequence || flags === VolcMessageFlags.NegativeSequence) {
    const sequence = Buffer.allocUnsafe(4);
    sequence.writeInt32BE(input.sequence ?? 0);
    chunks.push(sequence);
  }

  const payloadLength = Buffer.allocUnsafe(4);
  payloadLength.writeUInt32BE(payload.byteLength);
  chunks.push(payloadLength, payload);
  return Buffer.concat(chunks);
}

export function encodeAsrFullRequest(payload: unknown, sequence = 1): Buffer {
  return encodeFrame({
    messageType: VolcMessageType.FullClientRequest,
    flags: VolcMessageFlags.PositiveSequence,
    serialization: VolcSerialization.Json,
    compression: VolcCompression.Gzip,
    sequence,
    payload: gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')),
  });
}

export function encodeAsrAudioRequest(
  pcm: Buffer,
  sequence: number,
  last = false,
): Buffer {
  return encodeFrame({
    messageType: VolcMessageType.AudioOnlyClientRequest,
    flags: last ? VolcMessageFlags.NegativeSequence : VolcMessageFlags.PositiveSequence,
    serialization: VolcSerialization.Raw,
    compression: VolcCompression.Gzip,
    sequence: last ? -Math.abs(sequence) : Math.abs(sequence),
    payload: gzipSync(pcm),
  });
}

export function encodeTtsRequest(payload: unknown): Buffer {
  return encodeFrame({
    messageType: VolcMessageType.FullClientRequest,
    serialization: VolcSerialization.Json,
    payload: Buffer.from(JSON.stringify(payload), 'utf8'),
  });
}

export function parseVolcFrame(input: Buffer): ParsedVolcFrame {
  if (input.length < 8) throw new Error('Incomplete Volcengine speech frame.');
  const version = input[0]! >> 4;
  const headerSize = (input[0]! & 0x0f) * 4;
  const messageType = (input[1]! >> 4) as VolcMessageType;
  const flags = input[1]! & 0x0f;
  const serialization = (input[2]! >> 4) as VolcSerialization;
  const compression = (input[2]! & 0x0f) as VolcCompression;
  let offset = headerSize;
  let sequence: number | undefined;
  let event: number | undefined;
  let sessionId: string | undefined;
  let errorCode: number | undefined;

  if (messageType === VolcMessageType.Error) {
    const code = readUInt32(input, offset);
    errorCode = code.value;
    offset = code.offset;
  } else {
    if (flags === VolcMessageFlags.PositiveSequence || flags === VolcMessageFlags.NegativeSequence) {
      const parsed = readInt32(input, offset);
      sequence = parsed.value;
      offset = parsed.offset;
    }
    if ((flags & VolcMessageFlags.WithEvent) !== 0) {
      const parsedEvent = readInt32(input, offset);
      event = parsedEvent.value;
      offset = parsedEvent.offset;
      const sessionLength = readUInt32(input, offset);
      offset = sessionLength.offset;
      if (offset + sessionLength.value > input.length) {
        throw new Error('Invalid Volcengine speech session id length.');
      }
      sessionId = input.subarray(offset, offset + sessionLength.value).toString('utf8');
      offset += sessionLength.value;
    }
  }

  const payloadLength = readUInt32(input, offset);
  offset = payloadLength.offset;
  if (offset + payloadLength.value > input.length) {
    throw new Error('Invalid Volcengine speech payload length.');
  }
  let payload = input.subarray(offset, offset + payloadLength.value);
  if (compression === VolcCompression.Gzip && payload.length > 0) {
    payload = gunzipSync(payload);
  }

  return {
    version,
    messageType,
    flags,
    serialization,
    compression,
    sequence,
    event,
    sessionId,
    errorCode,
    payload,
    isLast:
      flags === VolcMessageFlags.LastNoSequence ||
      flags === VolcMessageFlags.NegativeSequence ||
      (sequence !== undefined && sequence < 0),
  };
}

export function parseJsonPayload<T = unknown>(frame: ParsedVolcFrame): T | undefined {
  if (!frame.payload.length) return undefined;
  try {
    return JSON.parse(frame.payload.toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

export function parseProviderError(frame: ParsedVolcFrame): {
  code: number;
  message: string;
} {
  const parsed = parseJsonPayload<Record<string, unknown>>(frame);
  const message =
    (typeof parsed?.message === 'string' && parsed.message) ||
    (typeof parsed?.error === 'string' && parsed.error) ||
    frame.payload.toString('utf8') ||
    'Volcengine speech provider returned an error.';
  return { code: frame.errorCode ?? -1, message };
}

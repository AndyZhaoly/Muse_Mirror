import type http from 'node:http';

export type MuseSseEvent =
  | 'activity'
  | 'commentary'
  | 'delta'
  | 'artifact'
  | 'result'
  | 'error';

export function writeSse(
  res: http.ServerResponse,
  event: MuseSseEvent,
  payload: unknown,
): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

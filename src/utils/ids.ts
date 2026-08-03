import { randomUUID } from 'node:crypto';

export function makeId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

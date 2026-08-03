import path from 'node:path';

export function resolveWithin(baseDir: string, candidatePath: string): string {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(candidatePath);
  const relative = path.relative(base, resolved);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the allowed directory: ${candidatePath}`);
  }

  return resolved;
}

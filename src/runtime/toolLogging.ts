import type { FashionSessionState } from '../types.js';
import { makeId } from '../utils/ids.js';

export async function withToolLog<T>(
  state: FashionSessionState,
  toolName: string,
  action: () => Promise<T>,
  summarize: (result: T) => string,
): Promise<T> {
  const startedAt = new Date().toISOString();
  try {
    const result = await action();
    state.toolLog.push({
      id: makeId('tool'),
      toolName,
      startedAt,
      completedAt: new Date().toISOString(),
      status: 'ok',
      summary: summarize(result).slice(0, 500),
    });
    return result;
  } catch (error) {
    state.toolLog.push({
      id: makeId('tool'),
      toolName,
      startedAt,
      completedAt: new Date().toISOString(),
      status: 'error',
      summary: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

const STORAGE_KEY = 'muse.team-demo.browser-user-id.v1';
let volatileBrowserUserId: string | undefined;

export interface BrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function newBrowserUserId(randomUUID?: () => string): string {
  const uuid = randomUUID?.() ?? globalThis.crypto?.randomUUID?.();
  if (uuid) return `team_demo_${uuid}`;
  return `team_demo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function getOrCreateBrowserUserId(
  storage?: BrowserStorage,
  randomUUID?: () => string,
): string {
  const targetStorage = storage ?? (() => {
    try {
      return globalThis.localStorage;
    } catch {
      return undefined;
    }
  })();

  try {
    const existing = targetStorage?.getItem(STORAGE_KEY)?.trim();
    if (existing?.startsWith('team_demo_')) return existing;
    const created = newBrowserUserId(randomUUID);
    targetStorage?.setItem(STORAGE_KEY, created);
    if (targetStorage) return created;
  } catch {
    // Privacy modes can disable localStorage. Keep a stable in-tab fallback.
  }

  volatileBrowserUserId ??= newBrowserUserId(randomUUID);
  return volatileBrowserUserId;
}

import crypto from 'node:crypto';
import type http from 'node:http';

export const TEAM_DEMO_COOKIE_NAME = 'muse_team_demo_session';

const SESSION_VERSION = 'v1';
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;

export interface DemoAccessOptions {
  accessCode?: string;
  sessionSecret?: string;
  production?: boolean;
  sessionTtlSeconds?: number;
}

export interface DemoAccessControl {
  readonly enabled: boolean;
  authenticate(accessCode: string): boolean;
  createSessionCookie(now?: Date): string;
  clearSessionCookie(): string;
  isAuthenticated(request: http.IncomingMessage, now?: Date): boolean;
}

function safeEqual(left: string, right: string): boolean {
  const leftHash = crypto.createHash('sha256').update(left).digest();
  const rightHash = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of (header ?? '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createDemoAccessControl(
  options: DemoAccessOptions = {},
): DemoAccessControl {
  const accessCode = options.accessCode?.trim() ?? '';
  const sessionSecret = options.sessionSecret?.trim() ?? '';
  const enabled = accessCode.length > 0;
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const sessionTtlSeconds = Math.max(
    60,
    Math.floor(options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS),
  );

  if (enabled && !sessionSecret) {
    throw new Error(
      'MUSE_TEAM_DEMO_SESSION_SECRET is required when MUSE_TEAM_DEMO_ACCESS_CODE is configured.',
    );
  }

  function createToken(now: Date): string {
    const expiresAt = Math.floor(now.getTime() / 1000) + sessionTtlSeconds;
    const nonce = crypto.randomBytes(18).toString('base64url');
    const payload = `${SESSION_VERSION}.${expiresAt}.${nonce}`;
    return `${payload}.${sign(payload, sessionSecret)}`;
  }

  function verifyToken(token: string | undefined, now: Date): boolean {
    if (!enabled) return true;
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 4) return false;
    const [version, expiresAtRaw, nonce, signature] = parts;
    if (version !== SESSION_VERSION || !nonce || !signature) return false;
    const expiresAt = Number(expiresAtRaw);
    if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(now.getTime() / 1000)) {
      return false;
    }
    const payload = `${version}.${expiresAtRaw}.${nonce}`;
    return safeEqual(signature, sign(payload, sessionSecret));
  }

  const cookieSecurity = production ? '; Secure' : '';

  return {
    enabled,
    authenticate: (candidate) => !enabled || safeEqual(candidate, accessCode),
    createSessionCookie: (now = new Date()) =>
      `${TEAM_DEMO_COOKIE_NAME}=${createToken(now)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionTtlSeconds}${cookieSecurity}`,
    clearSessionCookie: () =>
      `${TEAM_DEMO_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecurity}`,
    isAuthenticated: (request, now = new Date()) => {
      if (!enabled) return true;
      const token = parseCookies(request.headers.cookie).get(TEAM_DEMO_COOKIE_NAME);
      return verifyToken(token, now);
    },
  };
}

export function loadDemoAccessControl(
  env: NodeJS.ProcessEnv = process.env,
): DemoAccessControl {
  return createDemoAccessControl({
    accessCode: env.MUSE_TEAM_DEMO_ACCESS_CODE,
    sessionSecret: env.MUSE_TEAM_DEMO_SESSION_SECRET,
    production: env.NODE_ENV === 'production',
  });
}

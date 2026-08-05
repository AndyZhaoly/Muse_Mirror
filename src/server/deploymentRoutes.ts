import type http from 'node:http';
import type { DemoAccessControl } from './demoAccess.js';

const MAX_AUTH_BODY_BYTES = 16 * 1024;

function jsonResponse(
  res: http.ServerResponse,
  statusCode: number,
  payload: unknown,
  headers: Record<string, string | string[]> = {},
): void {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

async function readAccessCode(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_AUTH_BODY_BYTES) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  if (!chunks.length) return '';
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    accessCode?: unknown;
  };
  return typeof body.accessCode === 'string' ? body.accessCode : '';
}

export function healthPayload(
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): Record<string, unknown> {
  return {
    ok: true,
    service: 'muse-mirror',
    version: env.RENDER_GIT_COMMIT?.slice(0, 12) || env.npm_package_version || '0.6.0',
    timestamp: now.toISOString(),
  };
}

export async function handleDeploymentRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  access: DemoAccessControl,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    jsonResponse(res, 200, healthPayload(env));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/demo-auth/status') {
    jsonResponse(res, 200, {
      enabled: access.enabled,
      authenticated: access.isAuthenticated(req),
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/demo-auth/login') {
    try {
      const candidate = await readAccessCode(req);
      if (!access.authenticate(candidate)) {
        jsonResponse(res, 401, { error: '团队访问码不正确。' });
        return true;
      }
      jsonResponse(
        res,
        200,
        { ok: true },
        access.enabled ? { 'set-cookie': access.createLoginCookies() } : {},
      );
    } catch {
      jsonResponse(res, 400, { error: '登录请求格式不正确。' });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/demo-auth/logout') {
    jsonResponse(
      res,
      200,
      { ok: true },
      access.enabled ? { 'set-cookie': access.clearLoginCookies() } : {},
    );
    return true;
  }

  return false;
}

export function isLoginBootstrapRequest(
  req: http.IncomingMessage,
  pathname: string,
): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  return (
    pathname === '/' ||
    pathname === '/index.html' ||
    pathname === '/favicon.ico' ||
    pathname.startsWith('/assets/')
  );
}

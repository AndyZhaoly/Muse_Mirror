import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createDemoAccessControl } from '../src/server/demoAccess.js';
import { handleDeploymentRoute, healthPayload } from '../src/server/deploymentRoutes.js';

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function testServer(access: ReturnType<typeof createDemoAccessControl>): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      if (await handleDeploymentRoute(req, res, access, {})) return;
      if (!access.isAuthenticated(req)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Authentication required.' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    })();
  });
}

test('health payload is provider-independent and contains no credentials', () => {
  const payload = healthPayload({
    OPENAI_API_KEY: 'must-not-leak',
    VOLC_SPEECH_APP_KEY: 'must-not-leak-either',
    RENDER_GIT_COMMIT: '1234567890abcdef',
  }, new Date('2026-08-03T00:00:00.000Z'));
  assert.deepEqual(payload, {
    ok: true,
    service: 'muse-mirror',
    version: '1234567890ab',
    timestamp: '2026-08-03T00:00:00.000Z',
  });
  assert.doesNotMatch(JSON.stringify(payload), /must-not-leak/);
});

test('disabled access gate preserves local development behavior', () => {
  const access = createDemoAccessControl();
  assert.equal(access.enabled, false);
  assert.equal(access.authenticate('anything'), true);
  assert.equal(access.isAuthenticated({ headers: {} } as http.IncomingMessage), true);
});

test('configured access gate requires a session secret', () => {
  assert.throws(
    () => createDemoAccessControl({ accessCode: 'team-code' }),
    /MUSE_TEAM_DEMO_SESSION_SECRET/,
  );
});

test('login sets a signed cookie and rejects wrong or tampered credentials', async (t) => {
  const access = createDemoAccessControl({
    accessCode: 'correct-team-code',
    sessionSecret: 'a-long-test-only-session-secret',
    production: true,
  });
  const server = testServer(access);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const origin = await listen(server);

  const wrong = await fetch(`${origin}/api/demo-auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessCode: 'wrong-code' }),
  });
  assert.equal(wrong.status, 401);
  assert.doesNotMatch(await wrong.text(), /correct-team-code|wrong-code/);

  const login = await fetch(`${origin}/api/demo-auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessCode: 'correct-team-code' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.ok(cookie);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.doesNotMatch(cookie, /correct-team-code/);

  const cookiePair = cookie.split(';')[0]!;
  const authenticated = await fetch(`${origin}/private-api`, {
    headers: { cookie: cookiePair },
  });
  assert.equal(authenticated.status, 200);

  const tampered = await fetch(`${origin}/private-api`, {
    headers: { cookie: `${cookiePair}x` },
  });
  assert.equal(tampered.status, 401);
});

test('/healthz stays public while ordinary APIs require authentication', async (t) => {
  const access = createDemoAccessControl({
    accessCode: 'team-code',
    sessionSecret: 'test-session-secret',
  });
  const server = testServer(access);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const origin = await listen(server);

  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { ok?: boolean }).ok, true);

  const api = await fetch(`${origin}/api/fashion/turn/stream`, { method: 'POST' });
  assert.equal(api.status, 401);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('ambient routes derive ownership from the signed browser identity and ignore client user IDs', () => {
  const server = fs.readFileSync('src/server/webServer.ts', 'utf8');
  const handlerStart = server.indexOf('async function handleAmbientCapture');
  const handlerEnd = server.indexOf('function requireBrowserIdentity', handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = server.slice(handlerStart, handlerEnd);
  assert.match(handler, /const userId = requireBrowserIdentity\(req, res\)/);
  assert.doesNotMatch(handler, /body\.userId|url\.searchParams\.get\(['"]userId/);
  assert.match(handler, /retryProductImage\(userId, body\.closetItemId\)/);
  assert.match(handler, /resetUser\(userId\)/);
});

test('mirror and Agent runtime use the same signed browser wardrobe owner', () => {
  const server = fs.readFileSync('src/server/webServer.ts', 'utf8');
  assert.match(server, /runtime\.runTurn\(\{[\s\S]*?userId: runtimeUserId\(req, prepared\.input\.userId\)/);
  assert.match(server, /runtime\.cacheMirrorFrame\(\{[\s\S]*?userId: runtimeUserId\(req, input\.userId\)/);
  assert.match(server, /runtime\.resumeTurn\(\{[\s\S]*?userId: runtimeUserId\(req, input\.userId\)/);
  assert.match(server, /return demoAccess\.browserUserId\(req\) \?\? fallbackUserId/);
});

test('private wardrobe asset route enforces owner and path containment', () => {
  const server = fs.readFileSync('src/server/webServer.ts', 'utf8');
  const handlerStart = server.indexOf('async function handleWardrobeAsset');
  const handlerEnd = server.indexOf('function handlePerceptionStatus', handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = server.slice(handlerStart, handlerEnd);
  assert.match(handler, /requireBrowserIdentity\(req, res\)/);
  assert.match(handler, /asset\.ownerUserId !== userId/);
  assert.match(handler, /relative\.startsWith\(['"]\.\.['"]\)/);
  assert.match(handler, /capture_evidence['"] \? ['"]private, no-store/);
  assert.doesNotMatch(handler, /sendFile|\/generated\//);
});

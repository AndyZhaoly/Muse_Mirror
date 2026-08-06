import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('ambient capture UI exposes explicit grant, real completion, and developer reset states', () => {
  const app = fs.readFileSync('web/src/App.tsx', 'utf8');
  const canvas = fs.readFileSync('web/src/components/mirror/MirrorAgentCanvas.tsx', 'utf8');
  assert.match(app, /自动记录已开启/);
  assert.match(app, /一次性授权/);
  assert.match(app, /不保存连续视频/);
  assert.match(app, /sendAmbientCaptureFrame/);
  assert.match(app, /Reset my ambient wardrobe/);
  assert.match(canvas, /outfit_capture_completed|ambientCaptureEvent/);
  assert.match(canvas, /新加入/);
  assert.match(canvas, /已识别/);
  assert.match(canvas, /item\.imageStatus === 'ready' && item\.imageUrl/);
  assert.match(canvas, /正在整理衣橱图片/);
  assert.match(canvas, /未通过校验的图片不会展示/);
  assert.match(app, /acknowledgeAmbientCapture/);
  assert.match(app, /7_000/);
  assert.match(app, /evaluateEmptySceneGuard/);
  assert.match(app, /ambientEmptySceneStreamId/);
  assert.match(app, /resetAmbientEmptySceneGuard/);
  assert.match(app, /document\.hidden/);
  assert.match(app, /window\.clearInterval\(timer\)/);
  assert.match(app, /forcedProbeCount/);
  assert.match(app, /reentryLatencyMs/);
});

test('ambient capture runs outside Muse Agent tools and has no keyword router', () => {
  const runtime = fs.readFileSync('src/runtime/ambientCaptureCoordinator.ts', 'utf8');
  const agent = fs.readFileSync('src/server/openAiMuseRuntime.ts', 'utf8');
  assert.doesNotMatch(agent, /ambient_capture_current_outfit/);
  assert.doesNotMatch(runtime, /message\.includes|userMessage|keyword/i);
  assert.match(runtime, /decideMirrorSituation/);
});

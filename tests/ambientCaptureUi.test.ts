import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('ambient capture UI exposes explicit grant, semantic Wardrobe Moment, and developer reset states', () => {
  const app = fs.readFileSync('web/src/App.tsx', 'utf8');
  const canvas = fs.readFileSync('web/src/components/mirror/MirrorAgentCanvas.tsx', 'utf8');
  const moment = fs.readFileSync('web/src/components/mirror/wardrobeMoment.ts', 'utf8');
  const styles = fs.readFileSync('web/src/styles.css', 'utf8');
  assert.match(app, /自动记录已开启/);
  assert.match(app, /一次性授权/);
  assert.match(app, /不保存连续视频/);
  assert.match(app, /sendAmbientCaptureFrame/);
  assert.match(app, /Reset my ambient wardrobe/);
  assert.match(canvas, /state\.wardrobeMoment/);
  assert.match(canvas, /wardrobe-moment/);
  assert.match(canvas, /NEW · 正在整理/);
  assert.match(canvas, /衣橱已有/);
  assert.match(moment, /已加入你的衣橱/);
  assert.match(moment, /已记下清楚的部分/);
  assert.match(moment, /imageState: canonicalReady \? 'ready' : fallbackReady \? 'fallback' : 'processing'/);
  assert.match(app, /wardrobeMomentPollIntervalMs\(ambientCaptureEvent\)/);
  assert.match(styles, /\.wardrobe-moment-image img \{[^}]*max-width: 100%;[^}]*max-height: 100%;[^}]*object-fit: contain;/);
  assert.doesNotMatch(styles, /\.wardrobe-moment-card\.image-fallback \.wardrobe-moment-image img \{[^}]*object-fit: cover;/);
  assert.doesNotMatch(canvas, /ambient-image-progress|ambient-product-gallery|role="progressbar"/);
  assert.doesNotMatch(canvas, /生成并检查图片|图片通过视觉检查后会逐件出现在下方/);
  assert.match(app, /backfillAmbientProductImages/);
  assert.match(app, /needsReviewImageCount/);
  assert.doesNotMatch(app, /acknowledgeAmbientCapture/);
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

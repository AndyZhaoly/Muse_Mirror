import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { toCanvasPlainText } from '../web/src/components/mirror/mirrorCanvasContent.js';

test('Mirror Canvas consumes one projected screen state and approval is not duplicated', () => {
  const app = readFileSync('web/src/App.tsx', 'utf8');
  const canvas = readFileSync('web/src/components/mirror/MirrorAgentCanvas.tsx', 'utf8');
  const drawer = readFileSync('web/src/components/mirror/ConversationDrawer.tsx', 'utf8');

  assert.equal((app.match(/<ConsentCard/g) ?? []).length, 1);
  assert.match(app, /deriveMirrorScreenState/);
  assert.match(app, /state=\{mirrorScreenState\}/);
  assert.doesNotMatch(app, /const currentCanvasActivity/);
  assert.doesNotMatch(app, /const latestArtifactSummary/);
  assert.doesNotMatch(app, /const canvasContent/);
  assert.match(canvas, /state: MirrorScreenState/);
  assert.doesNotMatch(canvas, /MessageBubble|ActivityTimeline|messages\.map/);
  assert.match(drawer, /aria-expanded/);
  assert.match(drawer, /aria-controls/);
  assert.match(app, /id="complete-conversation"/);
});

test('Mirror Screen Controller remains a pure presentation projection', () => {
  const controller = readFileSync('web/src/components/mirror/mirrorScreenController.ts', 'utf8');
  assert.doesNotMatch(
    controller,
    /\bfetch\b|localStorage|setTimeout|setInterval|Date\.now|Math\.random|useEffect|useState|runAgentTurn|sendMirrorFrame|document\.|window\./,
  );
});

test('Canvas plain-text projection removes Markdown chrome without changing source data', () => {
  const source = '## 建议\n- **浅蓝衬衫**，参考[完整说明](https://example.com)。';
  const original = source.slice();

  assert.equal(toCanvasPlainText(source), '建议\n浅蓝衬衫，参考完整说明。');
  assert.equal(source, original);
});

import { existsSync, readFileSync } from 'node:fs';

const requiredFiles = [
  'START_HERE_FOR_CODEX.md',
  'UI_SPEC.md',
  'CODEX_UI_TASK.md',
  'CODEX_UI_HANDOFF_PROMPT.md',
  '.agents/skills/build-camera-first-fashion-ui/SKILL.md',
  'web/package.json',
  'web/index.html',
  'web/src/App.tsx',
  'web/src/styles.css',
  'web/src/main.tsx',
];

const missing = requiredFiles.filter((file) => !existsSync(file));
if (missing.length) {
  console.error(`Missing UI files:\n${missing.map((file) => `- ${file}`).join('\n')}`);
  process.exit(1);
}

const app = readFileSync('web/src/App.tsx', 'utf8');
const css = readFileSync('web/src/styles.css', 'utf8');
const spec = readFileSync('UI_SPEC.md', 'utf8');
const task = readFileSync('CODEX_UI_TASK.md', 'utf8');

const appSignals = [
  'navigator.mediaDevices.getUserMedia',
  'mirror-panel',
  'agent-panel',
  'AI 上身预览',
  '带脸生成',
  '不露脸，只看穿搭',
  '拍照分析',
];
for (const signal of appSignals) {
  if (!app.includes(signal)) {
    console.error(`Web shell is missing expected implementation signal: ${signal}`);
    process.exit(1);
  }
}

const cssSignals = [
  'grid-template-columns',
  '.mirror-panel',
  '.agent-panel',
  '@media (max-width:',
  '@media (prefers-reduced-motion: reduce)',
];
for (const signal of cssSignals) {
  if (!css.includes(signal)) {
    console.error(`Web stylesheet is missing expected rule: ${signal}`);
    process.exit(1);
  }
}

const architectureSignals = [
  'fixed intent classifier',
  'Large visual artifacts',
  'approval',
];
for (const signal of architectureSignals) {
  if (!task.includes(signal) && !spec.includes(signal)) {
    console.error(`UI documents are missing architecture/behavior requirement: ${signal}`);
    process.exit(1);
  }
}

const prohibitedUserFacingSignals = ['tool_call_id', 'serializedRunState'];
for (const signal of prohibitedUserFacingSignals) {
  if (app.includes(signal)) {
    console.error(`User-facing web shell exposes internal signal: ${signal}`);
    process.exit(1);
  }
}

console.log('Camera-first UI handoff and runnable web shell validation passed.');

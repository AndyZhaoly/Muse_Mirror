import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig } from '../config.js';
import { FashionAgentRuntime } from '../agent/runtime.js';
import { GemmaFashionRuntime } from '../server/gemmaFashionRuntime.js';
import { OpenAIMuseRuntime } from '../server/openAiMuseRuntime.js';
import type { FashionTurnResult, TurnPermissions } from '../types.js';

const config = loadConfig();
const runtime =
  config.agentProvider === 'gemma4'
    ? new GemmaFashionRuntime({ config })
    : config.runtimeProvider === 'legacy'
      ? new FashionAgentRuntime({ config })
      : new OpenAIMuseRuntime({ config });
const rl = readline.createInterface({ input, output });
const sessionId = `cli_${Date.now()}`;
const userId = 'local_cli_user';
let attachDemoPhoto = false;
const permissions: TurnPermissions = {
  allowVisualAnalysis: false,
  allowAiImageGeneration: false,
  allowPhotoUseForTryOn: false,
  allowPersistentMemory: false,
};

function printResult(result: FashionTurnResult): void {
  if (result.status === 'completed') {
    console.log(`\nAgent: ${result.text}`);
  }
  for (const artifact of result.artifacts) {
    console.log('\nUI artifact:', JSON.stringify(artifact, null, 2));
  }
}

async function resolveApprovals(
  pending: Extract<FashionTurnResult, { status: 'approval_required' }>,
): Promise<FashionTurnResult> {
  const decisions = [];
  for (const approval of pending.approvals) {
    const answer = await rl.question(
      `\n需要批准 ${approval.toolName}: ${approval.reason}\n批准吗？(y/n) `,
    );
    decisions.push({
      index: approval.index,
      approved: ['y', 'yes', '是'].includes(answer.trim().toLowerCase()),
    });
  }
  return runtime.resumeTurn({
    sessionId,
    userId,
    serializedRunState: pending.serializedRunState,
    decisions,
    permissions,
  });
}

console.log(`Conversational Fashion Agent CLI
Commands:
  /photo   attach examples/mock_user_photo.jpg as current photo
  /allow all|vision|image|tryon|memory
  /state   show current business state
  /exit    quit
`);

while (true) {
  const message = (await rl.question('\nYou: ')).trim();
  if (!message) continue;
  if (message === '/exit') break;
  if (message === '/photo') {
    attachDemoPhoto = true;
    console.log('Demo photo will be attached to the next turn.');
    continue;
  }
  if (message.startsWith('/allow ')) {
    const target = message.slice('/allow '.length).trim();
    if (target === 'all' || target === 'vision') permissions.allowVisualAnalysis = true;
    if (target === 'all' || target === 'image') permissions.allowAiImageGeneration = true;
    if (target === 'all' || target === 'tryon') permissions.allowPhotoUseForTryOn = true;
    if (target === 'all' || target === 'memory') permissions.allowPersistentMemory = true;
    console.log('Permissions:', permissions);
    continue;
  }
  if (message === '/state') {
    console.dir(runtime.stateStore.get(sessionId), { depth: 5 });
    continue;
  }

  let result = await runtime.runTurn({
    sessionId,
    userId,
    message,
    permissions,
    attachments: attachDemoPhoto
      ? [
          {
            id: `photo_${Date.now()}`,
            kind: 'user_photo',
            localPath: path.resolve('./examples/mock_user_photo.jpg'),
            mimeType: 'image/jpeg',
            makeCurrent: true,
            label: 'CLI demo user photo',
          },
        ]
      : undefined,
  });
  attachDemoPhoto = false;

  while (result.status === 'approval_required') {
    printResult(result);
    result = await resolveApprovals(result);
  }
  printResult(result);
}

runtime.stateStore.clear(sessionId);
rl.close();

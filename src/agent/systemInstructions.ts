import fs from 'node:fs';
import path from 'node:path';
import type { FashionSkillMetadata } from '../services/skillRegistry.js';
import type { FashionAgentContext } from '../types.js';

const baseInstructions = fs.readFileSync(
  path.resolve('./prompts/system_prompt.md'),
  'utf8',
);

export function buildSystemInstructions(
  context: FashionAgentContext,
  skillCatalog: FashionSkillMetadata[],
): string {
  const stateSummary = {
    currentUserImageAvailable: Boolean(context.state.currentUserImageId),
    currentUserImageId: context.state.currentUserImageId,
    activeOutfit: context.state.activeOutfit,
    lastGeneratedImageId: context.state.lastGeneratedImageId,
    activeVisualSelection: context.state.activeVisualSelection ?? { kind: 'none' },
    activeOutfitSnapshotId: context.state.activeOutfitSnapshotId,
    visualSession: context.state.visualSession,
    sessionPreferences: context.state.sessionPreferences,
    persistentPreferences: context.state.persistentPreferences,
    availableImageIds: Object.values(context.state.images).map((image) => ({
      id: image.id,
      kind: image.kind,
      label: image.label,
      aiGenerated: image.aiGenerated,
    })),
  };

  return `${baseInstructions}

## 可按需加载的专业 Skill（内部使用）
${JSON.stringify(
    skillCatalog,
    null,
    2,
  )}

Skill 只提供稳定的方法与判断框架；外部事实和动作仍应使用相应工具。不要为了展示能力而加载 Skill。

## 当前应用状态（内部使用，不要逐字复述给用户）
${JSON.stringify(
    stateSummary,
    null,
    2,
  )}

当前时间：${context.nowIso}
语言偏好：${context.locale}`;
}

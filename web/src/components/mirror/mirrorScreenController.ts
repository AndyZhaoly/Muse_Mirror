import type { AgentActivity, AgentArtifact } from '../../agentClient.js';
import { toCanvasPlainText } from './mirrorCanvasContent.js';
import type {
  MirrorContentKind,
  MirrorInteractionPhase,
  MirrorPrimaryArtifact,
  MirrorScreenControllerInput,
  MirrorScreenMessage,
  MirrorScreenState,
  MirrorVoicePresentation,
} from './mirrorScreenTypes.js';
import { deriveWardrobeMoment } from './wardrobeMoment.js';

const IDLE_FALLBACK = '你好。需要时，我可以看镜子、查衣柜或生成视觉参考。';

export function mirrorVoiceStatusLabel(state: MirrorVoicePresentation['state']): string {
  const labels: Record<MirrorVoicePresentation['state'], string> = {
    disabled: '语音模式未开启',
    idle: '正在准备聆听',
    requesting_permission: '正在请求麦克风权限',
    listening: '正在聆听',
    recognizing: '正在确认你说的话',
    thinking: 'Muse 正在回复',
    speaking: 'Muse 正在说话',
    error: '语音暂不可用',
  };
  return labels[state] ?? '语音状态';
}

export function mirrorToolDisplayName(name?: string): string {
  const labels: Record<string, string> = {
    observe_current_frame: '看当前画面',
    recommend_from_closet: '查真实衣柜',
    commit_outfit: '确认搭配方案',
    get_item_images: '查看衣服图片',
    get_weather: '查看天气',
    create_style_visual: '生成视觉参考',
    update_style_visual: '编辑视觉版本',
    edit_style_visual: '编辑视觉版本',
    restore_visual_version: '恢复上一版',
  };
  return name ? labels[name] ?? '处理能力' : '处理能力';
}

export function mirrorActivityLabel(activity: AgentActivity): string {
  if (activity.type.startsWith('tool.')) return mirrorToolDisplayName(activity.toolName);
  const labels: Record<AgentActivity['type'], string> = {
    'perception.started': '正在看当前画面',
    'perception.completed': '已看完当前画面',
    'perception.failed': '当前画面暂未看清',
    'weather.started': '正在查看天气',
    'weather.completed': '已查看天气',
    'weather.failed': '天气暂时没取到',
    'wardrobe.started': '正在找衣柜里的合适单品',
    'wardrobe.completed': '已找到衣柜候选',
    'wardrobe.failed': '衣柜暂时没取到',
    'strategy.started': '正在参考穿搭方法',
    'strategy.completed': '已参考穿搭方法',
    'strategy.failed': '穿搭方法暂时没取到',
    'synthesis.started': '正在整理建议',
    'synthesis.completed': '已整理建议',
    'synthesis.failed': '暂时没有返回',
    'generation.started': '正在准备视觉结果',
    'generation.completed': '视觉结果已完成',
    'generation.failed': '视觉结果暂未完成',
    'state.updated': '已更新本轮状态',
    'policy.warning': '已按权限边界处理',
    'turn.cancelled': '上一轮已取消',
    'tool.started': '正在处理',
    'tool.completed': '已完成',
    'tool.failed': '暂未完成',
  };
  return labels[activity.type] ?? '正在处理';
}

export function mirrorToolActivity(activity?: readonly AgentActivity[]): AgentActivity[] {
  return (activity ?? []).filter((item) => item.type.startsWith('tool.'));
}

export function isMirrorVisualGenerationTool(name?: string): boolean {
  return Boolean(
    name === 'create_style_visual' ||
      name === 'update_style_visual' ||
      name === 'edit_style_visual' ||
      name === 'restore_visual_version',
  );
}

export function summarizeMirrorActivity(activity: readonly AgentActivity[]): string | undefined {
  const toolActivity = mirrorToolActivity(activity);
  if (!toolActivity.length) return undefined;
  const names = new Set(toolActivity.map((item) => item.toolName));
  const hasActiveStep = toolActivity.some((item) => item.status === 'started');
  if (hasActiveStep) {
    if ([...names].some(isMirrorVisualGenerationTool)) return '正在生成视觉结果';
    if (names.has('recommend_from_closet')) return '正在查真实衣柜';
    if (names.has('observe_current_frame')) return '正在看当前画面';
    return '正在处理';
  }
  if (toolActivity.some((item) => item.status === 'failed')) return '有部分能力暂时没完成';
  if ([...names].some(isMirrorVisualGenerationTool)) return '生成并检查了视觉结果';
  if (names.has('recommend_from_closet')) return '查了真实衣柜';
  if (names.has('observe_current_frame')) return '看了一下当前画面';
  return '完成了需要的能力';
}

export function classifyMirrorArtifact(artifact: AgentArtifact): MirrorContentKind {
  switch (artifact.type) {
    case 'look_board':
      return 'look_board';
    case 'image':
      return artifact.source === 'ai_try_on' ? 'try_on' : 'visual';
    case 'item_grid':
      return 'closet';
    case 'product_cards':
      return 'products';
    case 'item_collection':
    case 'item_visual':
      return 'visual';
    case 'notice':
    default:
      return 'conversation';
  }
}

function imagePreviewTitle(artifact: Extract<AgentArtifact, { type: 'image' }>): string {
  if (artifact.source !== 'ai_try_on') return 'AI 搭配示意';
  if (artifact.previewScope === 'neckline_preview') return '领口与肩部预览';
  if (artifact.previewScope === 'upper_body_faithful') return '本人上半身预览';
  if (artifact.previewScope === 'full_body_synthetic') return 'AI 全身概念预览';
  if (artifact.previewScope === 'full_body') return '本人全身预览';
  return 'AI 上身预览';
}

export function summarizeMirrorArtifact(artifact: Exclude<AgentArtifact, { type: 'notice' }>): string {
  if (artifact.type === 'item_grid') return `${artifact.title} · ${artifact.items.length} 件衣柜单品`;
  if (artifact.type === 'product_cards') return `${artifact.title} · ${artifact.products.length} 个真实商品`;
  if (artifact.type === 'item_collection') return `${artifact.title} · ${artifact.items.length} 张概念单品图`;
  if (artifact.type === 'look_board') return `${artifact.title} · Look Board 已生成`;
  if (artifact.type === 'item_visual') return `${artifact.label} · 单品图已生成`;
  return `${artifact.label} · ${imagePreviewTitle(artifact)}`;
}

function lastNonNoticeArtifact(
  message?: MirrorScreenMessage,
): Exclude<AgentArtifact, { type: 'notice' }> | undefined {
  if (!message?.artifacts?.length) return undefined;
  for (let index = message.artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = message.artifacts[index];
    if (artifact && artifact.type !== 'notice') return artifact;
  }
  return undefined;
}

function latestCompletedAssistant(messages: readonly MirrorScreenMessage[]): MirrorScreenMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === 'assistant' &&
      (message.text?.trim() || message.commentary?.trim())
    ) {
      return message;
    }
  }
  return undefined;
}

function latestUserText(messages: readonly MirrorScreenMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && message.text?.trim()) return message.text.trim();
  }
  return undefined;
}

function phaseAndPriority({
  hasPendingApproval,
  activeAssistant,
  activeText,
  responding,
  generating,
  voice,
  completedAssistant,
}: {
  hasPendingApproval: boolean;
  activeAssistant?: MirrorScreenMessage;
  activeText?: string;
  responding: boolean;
  generating: boolean;
  voice: MirrorScreenControllerInput['voice'];
  completedAssistant?: MirrorScreenMessage;
}): { phase: MirrorInteractionPhase; priority: number } {
  if (hasPendingApproval) return { phase: 'awaiting_approval', priority: 100 };
  if (activeAssistant && activeText) {
    return { phase: voice.state === 'speaking' ? 'speaking' : 'showing_result', priority: 90 };
  }
  if (activeAssistant) return { phase: 'thinking', priority: 80 };
  if (generating || responding) return { phase: 'thinking', priority: 70 };
  if (voice.state === 'recognizing' || voice.partialTranscript?.trim()) {
    return { phase: 'recognizing', priority: 60 };
  }
  if (voice.state === 'listening') return { phase: 'listening', priority: 50 };
  if (voice.state === 'speaking' && completedAssistant) return { phase: 'speaking', priority: 40 };
  if (completedAssistant) return { phase: 'showing_result', priority: 20 };
  return { phase: 'idle', priority: 0 };
}

export function deriveMirrorScreenState(input: MirrorScreenControllerInput): MirrorScreenState {
  const activeAssistant = input.activeAssistantId
    ? input.messages.find(
      (message) => message.id === input.activeAssistantId && message.role === 'assistant',
    )
    : undefined;
  const foregroundSituation = input.situationDecision?.presentation.visibility === 'foreground';
  const explicitScreenTask = Boolean(
    activeAssistant ||
    input.responding ||
    input.generating ||
    input.hasPendingApproval ||
    input.foregroundVisualTask ||
    input.voice.state === 'requesting_permission' ||
    input.voice.state === 'recognizing' ||
    input.voice.state === 'thinking' ||
    input.voice.state === 'speaking' ||
    input.voice.partialTranscript?.trim() ||
    foregroundSituation,
  );
  const canShowWardrobeMoment = !explicitScreenTask &&
    !input.responding &&
    !input.generating &&
    (input.voice.state === 'disabled' || input.voice.state === 'idle' || input.voice.state === 'listening');
  const wardrobeMoment = canShowWardrobeMoment
    ? deriveWardrobeMoment(input.ambientCaptureEvent)
    : undefined;
  const ambientCaptureOwnsCanvas = Boolean(wardrobeMoment);
  const ambientCaptureEvent = ambientCaptureOwnsCanvas ? input.ambientCaptureEvent : undefined;
  const ambientCaptureStatus = ambientCaptureOwnsCanvas ? input.ambientCaptureStatus : undefined;
  const completedAssistant = ambientCaptureOwnsCanvas ? undefined : latestCompletedAssistant(input.messages);
  const ownerMessage = activeAssistant ?? completedAssistant;
  const activeText = activeAssistant?.text?.trim() || undefined;
  const activeCommentary = activeAssistant?.commentary?.trim() || undefined;
  const completedText = completedAssistant?.text?.trim() || undefined;
  const completedCommentary = completedAssistant?.commentary?.trim() || undefined;
  const { phase, priority } = phaseAndPriority({
    hasPendingApproval: input.hasPendingApproval,
    activeAssistant,
    activeText,
    responding: input.responding,
    generating: input.generating,
    voice: input.voice,
    completedAssistant,
  });

  let museText: string | undefined;
  let museTextSource: MirrorScreenState['caption']['museTextSource'];
  if (activeAssistant) {
    if (activeText) {
      museText = activeText;
      museTextSource = 'answer';
    } else if (activeCommentary) {
      museText = activeCommentary;
      museTextSource = 'commentary';
    }
  } else if (completedAssistant) {
    if (completedText) {
      museText = completedText;
      museTextSource = 'answer';
    } else if (completedCommentary) {
      museText = completedCommentary;
      museTextSource = 'commentary';
    }
  } else if (
    phase === 'idle' &&
    !input.hasPendingApproval &&
    !ambientCaptureOwnsCanvas &&
    input.voice.state !== 'error'
  ) {
    museText = IDLE_FALLBACK;
    museTextSource = 'idle_fallback';
  }

  const ownedActivity = activeAssistant
    ? (activeAssistant.activity?.length ? activeAssistant.activity : input.liveActivity)
    : [];
  const activityLabel = activeAssistant
    ? summarizeMirrorActivity(ownedActivity) ?? (
      input.responding ? 'Muse 正在回复' : input.generating ? '正在准备视觉结果' : undefined
    )
    : input.generating
      ? '正在准备视觉结果'
      : input.responding
        ? 'Muse 正在回复'
        : undefined;

  const artifact = lastNonNoticeArtifact(ownerMessage);
  const primaryArtifact: MirrorPrimaryArtifact | undefined = artifact && ownerMessage
    ? {
        ownerMessageId: ownerMessage.id,
        artifactType: artifact.type,
        contentKind: classifyMirrorArtifact(artifact),
        summary: summarizeMirrorArtifact(artifact),
        artifact,
      }
    : undefined;

  const voice: MirrorVoicePresentation = {
    enabled: input.voice.enabled,
    state: input.voice.state,
    partialTranscript: input.voice.partialTranscript?.trim() || undefined,
    error: input.voice.error?.trim() || undefined,
    statusLabel: mirrorVoiceStatusLabel(input.voice.state),
  };
  const recognizingText = phase === 'recognizing'
    ? input.voice.partialTranscript?.trim() || undefined
    : undefined;

  const screenOwner = input.hasPendingApproval || foregroundSituation
    ? 'blocking_interaction'
    : explicitScreenTask || completedAssistant
      ? 'explicit_task'
      : wardrobeMoment
        ? 'wardrobe_moment'
        : 'idle';

  return {
    screenOwner,
    phase: ambientCaptureOwnsCanvas && phase === 'idle' ? 'showing_result' : phase,
    contentKind: ambientCaptureOwnsCanvas ? 'garment_ingestion' : primaryArtifact?.contentKind ?? (
      input.situationDecision?.presentation.visibility === 'foreground'
        ? input.situationDecision.presentation.contentKind
        : 'conversation'
    ),
    priority: ambientCaptureOwnsCanvas && phase === 'idle' ? 30 : priority,
    ownerMessageId: ownerMessage?.id,
    ambient: {
      agentStatusLabel: input.agentStatusLabel,
      perceptionLabel: input.perceptionLabel,
    },
    caption: {
      latestUserText: ambientCaptureOwnsCanvas ? undefined : toCanvasPlainText(recognizingText ?? latestUserText(input.messages)),
      museText: toCanvasPlainText(museText),
      museTextSource,
      activityLabel,
      showTyping: Boolean(
        activeAssistant && !activeText && !activeCommentary ||
        !activeAssistant && phase === 'thinking' && !museText && !ambientCaptureOwnsCanvas,
      ),
    },
    voice,
    primaryArtifact,
    showApproval: input.hasPendingApproval,
    isActiveTurn: Boolean(activeAssistant),
    situationDecision: input.situationDecision,
    wardrobeMoment,
    ambientCaptureEvent,
    ambientCaptureStatus,
    ambientClosetItems: input.ambientClosetItems ?? [],
    ambientProductImageProviderReady: Boolean(input.ambientProductImageProviderReady),
    ambientProductImageBackfillPending: Boolean(input.ambientProductImageBackfillPending),
  };
}

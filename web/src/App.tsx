import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  confirmMemoryCandidate,
  createConversation,
  deleteConversation,
  deleteMemory,
  dismissMemoryCandidate,
  getPerceptionStatus,
  getAmbientCaptureState,
  acknowledgeAmbientCapture,
  getAgentStatus,
  getConversationMessages,
  listConversations,
  listMemories,
  listMemoryCandidates,
  setMemoryPaused,
  resumeAgentTurn,
  runAgentTurnStream,
  sendMirrorFrame,
  sendAmbientCaptureFrame,
  setAmbientCaptureGrant,
  endAmbientCaptureEpisode,
  resetAmbientCapture,
  type AgentActivity,
  type AgentArtifact,
  type AgentTurnResult,
  type ApprovalRequest,
  type Conversation,
  type ConversationMessage,
  type ExplicitPreferenceEvent,
	  type MuseDecisionSummary,
  type MemoryPolicy,
  type MemoryUsageDisclosure,
	  type PerceptionState,
	  type ExpressionIntensity,
	  type PreferenceMemoryScope,
  type PreferenceUiEvent,
	  type RecommendationScope,
	  type StylingProfile,
	  type TurnRequest,
  type UserMemory,
	  type AmbientCaptureCompletedEvent,
	  type AmbientCaptureOutcome,
	} from './agentClient';
import {
  frameStabilityScore,
  nextStableSampleCount,
  sampleVideoFrame,
  type FrameStabilitySample,
} from './ambientCapture';
import { useVoiceSession } from './voice/useVoiceSession';
import {
  attachMuseServerTelemetry,
  markMuseLatency,
} from './voice/latencyTelemetry';
import { getOrCreateBrowserUserId } from './browserIdentity';
import { ConversationDrawer } from './components/mirror/ConversationDrawer';
import { MirrorAgentCanvas } from './components/mirror/MirrorAgentCanvas';
import { MirrorSituationSimulator } from './components/mirror/MirrorSituationSimulator';
import {
  deriveMirrorScreenState,
  isMirrorVisualGenerationTool,
  mirrorActivityLabel,
  mirrorToolActivity,
  mirrorVoiceStatusLabel,
  summarizeMirrorActivity,
} from './components/mirror/mirrorScreenController';
import { MirrorWorkspace } from './components/mirror/MirrorWorkspace';
import {
  MIRROR_SITUATION_SCENARIOS,
  getMirrorSituationScenario,
  runMirrorSituationScenario,
} from '../../src/policy/mirrorSituationScenarios.js';

type CameraState = 'idle' | 'requesting' | 'active' | 'paused' | 'error';
type VisualMode =
  | 'live'
  | 'agent-image'
  | 'agent-look-board'
  | 'agent-items';
type MessageRole = 'assistant' | 'user';
type IconName =
  | 'camera'
  | 'pause'
  | 'play'
  | 'flip'
  | 'sparkle'
  | 'send'
  | 'close'
  | 'check'
  | 'sun'
  | 'chevron'
  | 'image'
  | 'mic';

type MessageSource = 'text' | 'voice';

type Message = {
  id: string;
  role: MessageRole;
  text?: string;
  commentary?: string;
  isTyping?: boolean;
  artifacts?: AgentArtifact[];
  activity?: AgentActivity[];
  decisionSummary?: MuseDecisionSummary;
  memoryUsage?: MemoryUsageDisclosure[];
  pendingMemoryCandidates?: ExplicitPreferenceEvent[];
};

const defaultStylingProfile: StylingProfile = {
  presentationPreference: 'unknown',
  presentationOpenness: 'open',
  recommendationScope: 'neutral_core',
  expressionIntensity: 'balanced',
  preferenceMemoryScope: 'turn',
  fitPreference: 'regular',
  source: 'unknown',
};

const recommendationScopeOptions: Array<{ id: RecommendationScope; label: string; presentationPreference: StylingProfile['presentationPreference']; openness: StylingProfile['presentationOpenness'] }> = [
  { id: 'neutral_core', label: '通用稳妥', presentationPreference: 'unknown', openness: 'open' },
  { id: 'menswear_inclusive', label: '偏传统男装', presentationPreference: 'masculine', openness: 'open' },
  { id: 'womenswear_inclusive', label: '偏传统女装', presentationPreference: 'feminine', openness: 'open' },
  { id: 'all', label: '全部都可以', presentationPreference: 'unrestricted', openness: 'unrestricted' },
];

const expressionIntensityOptions: Array<{ id: ExpressionIntensity; label: string }> = [
  { id: 'restrained', label: '低调' },
  { id: 'balanced', label: '平衡' },
  { id: 'bold', label: '鲜明' },
];

const preferenceMemoryScopeOptions: Array<{ id: PreferenceMemoryScope; label: string }> = [
  { id: 'turn', label: '本轮' },
  { id: 'session', label: '今天会话' },
  { id: 'persistent', label: '长期记住' },
];

type StageArtifact =
  | {
      kind: 'look_board';
      artifact: Extract<AgentArtifact, { type: 'look_board' }>;
    }
  | {
      kind: 'image';
      artifact: Extract<AgentArtifact, { type: 'image' }>;
    }
  | {
      kind: 'item_visual';
      artifact: Extract<AgentArtifact, { type: 'item_visual' }>;
    }
  | {
      kind: 'item_collection';
      artifact: Extract<AgentArtifact, { type: 'item_collection' }>;
    }
  | {
      kind: 'items';
      artifact: Extract<AgentArtifact, { type: 'item_grid' }>;
    }
  | {
      kind: 'products';
      artifact: Extract<AgentArtifact, { type: 'product_cards' }>;
    };

type PendingApproval = {
  approvals: ApprovalRequest[];
  resumeToken: string;
};

const initialMessages: Message[] = [
  {
    id: 'welcome',
    role: 'assistant',
    text: '你好，我是 Muse Mirror。你可以像和 GPT 聊天一样直接问我；需要时，我也可以看左侧镜子、查你的衣柜或生成视觉参考。',
  },
];

function makeSessionId(): string {
  return `web_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function messagesFromConversation(messages: ConversationMessage[]): Message[] {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message): Message => ({
      id: message.id,
      role: message.role as MessageRole,
      text: typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content),
      artifacts: [],
      activity: [],
    }));
}

function uiPersistenceForScope(scope: PreferenceMemoryScope): PreferenceUiEvent['persistence'] {
  if (scope === 'persistent') return 'persistent';
  if (scope === 'turn') return 'turn';
  return 'conversation';
}

function categoryLabel(category: string): string {
  const labels: Record<string, string> = {
    top: '上衣',
    bottom: '下装',
    dress: '连衣裙',
    jumpsuit: '连体装',
    outerwear: '外套',
    shoes: '鞋',
    bag: '包',
    accessory: '配饰',
  };
  return labels[category] ?? category;
}

function imagePreviewLabel(artifact: Extract<AgentArtifact, { type: 'image' }>): string {
  if (artifact.source !== 'ai_try_on') return 'AI 搭配示意 · 仅供风格参考';
  if (artifact.previewScope === 'neckline_preview') return '领口与肩部预览 · 仅供视觉参考';
  if (artifact.previewScope === 'upper_body_faithful') return '本人上半身预览 · 仅供视觉参考';
  if (artifact.previewScope === 'full_body_synthetic') return 'AI 全身概念预览 · 下半身为推测';
  if (artifact.previewScope === 'full_body') return '本人全身预览 · 仅供视觉参考';
  return 'AI 上身预览 · 仅供视觉参考';
}

async function loadCanvasImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load image: ${src}`));
    image.src = src;
  });
}

async function downloadLookBoardAsPng(artifact: Extract<AgentArtifact, { type: 'look_board' }>): Promise<void> {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 1600;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is unavailable.');
    ctx.fillStyle = '#f7f4ee';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#2f2a24';
    ctx.font = '600 46px Georgia, serif';
    ctx.fillText(artifact.title, 72, 92);
    if (artifact.dateLabel) {
      ctx.fillStyle = '#9b9286';
      ctx.font = '500 24px sans-serif';
      ctx.fillText(artifact.dateLabel, 1080, 90);
    }
    const hero = await loadCanvasImage(artifact.hero.imageUrl);
    const heroBox = { x: 72, y: 150, width: 760, height: 1240 };
    drawContainImage(ctx, hero, heroBox.x, heroBox.y, heroBox.width, heroBox.height);
    ctx.strokeStyle = 'rgba(68,58,47,.1)';
    ctx.strokeRect(heroBox.x, heroBox.y, heroBox.width, heroBox.height);
    const cardX = 880;
    const cardW = 300;
    let y = 165;
    for (const item of artifact.items.slice(0, 5)) {
      ctx.fillStyle = 'rgba(255,253,248,.92)';
      roundRect(ctx, cardX, y, cardW, 208, 26);
      ctx.fill();
      const itemImage = await loadCanvasImage(item.imageUrl);
      drawContainImage(ctx, itemImage, cardX + 78, y + 18, 144, 116);
      ctx.fillStyle = item.source === 'concept' ? '#697557' : '#8b8074';
      ctx.font = '700 19px sans-serif';
      ctx.fillText(item.badge, cardX + 24, y + 154);
      ctx.fillStyle = '#2f2a24';
      ctx.font = '600 24px sans-serif';
      ctx.fillText(item.label.slice(0, 16), cardX + 24, y + 186);
      y += 230;
    }
    ctx.fillStyle = '#8c8378';
    ctx.font = '18px sans-serif';
    wrapCanvasText(ctx, artifact.disclaimer, 72, 1480, 1100, 28);
    const url = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = url;
    link.download = `${artifact.title || 'muse-look-board'}.png`;
    link.click();
  } catch {
    window.alert('当前图片暂时无法导出。请稍后再试，导出失败不会重新调用图片模型。');
  }
}

function drawContainImage(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  ctx.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): void {
  const words = text.split('');
  let line = '';
  for (const word of words) {
    const testLine = line + word;
    if (ctx.measureText(testLine).width > maxWidth && line) {
      ctx.fillText(line, x, y);
      line = word;
      y += lineHeight;
    } else {
      line = testLine;
    }
  }
  if (line) ctx.fillText(line, x, y);
}

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    camera: <><path d="M5 7.5h2l1.2-2h7.6l1.2 2h2a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9.5a2 2 0 0 1 2-2Z"/><circle cx="12" cy="13" r="3.5"/></>,
    pause: <><path d="M8 6v12M16 6v12"/></>,
    play: <path d="m9 6 9 6-9 6Z"/>,
    flip: <><path d="M4 7h11l-2.5-2.5M20 17H9l2.5 2.5"/><path d="M18 7a7 7 0 0 1 1.2 8M6 17a7 7 0 0 1-1.2-8"/></>,
    sparkle: <><path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4Z"/><path d="m18.5 14 .7 2.3 2.3.7-2.3.8-.7 2.2-.8-2.2-2.2-.8 2.2-.7Z"/></>,
    send: <><path d="m3 11 17-8-6.5 18-3-7Z"/><path d="M10.5 14 20 3"/></>,
    close: <><path d="m7 7 10 10M17 7 7 17"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    sun: <><circle cx="12" cy="12" r="3.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    image: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 4.5-4.5 3.5 3 2.5-2.5L20 18"/></>,
    mic: <><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6"/></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

function CameraPermissionCard({ onStart, loading }: { onStart: () => void; loading: boolean }) {
  return (
    <div className="permission-card">
      <div className="permission-icon"><Icon name="camera" size={24} /></div>
      <p className="eyebrow">PRIVATE BY DEFAULT</p>
      <h2>开启你的实时试衣镜</h2>
      <p>授权后画面会先在浏览器显示；为保持视觉状态，Muse 会按低频截取当前画面并发送给视觉模型，不上传连续视频流。</p>
      <button className="button button-dark" onClick={onStart} disabled={loading}>
        <Icon name="camera" />
        {loading ? '正在请求权限...' : '开启摄像头'}
      </button>
      <span className="privacy-note">默认不录音；低频画面仅在镜子开启时按需分析</span>
    </div>
  );
}

function AgentArtifactStage({
  stage,
  visualHistory,
  compareVisual,
  onCompare,
  onRestore,
  onEdit,
  onSelect,
}: {
  stage: StageArtifact;
  visualHistory: Array<Extract<AgentArtifact, { type: 'image' }>>;
  compareVisual: boolean;
  onCompare: () => void;
  onRestore: () => void;
  onEdit: () => void;
  onSelect: (artifact: Extract<AgentArtifact, { type: 'image' }>) => void;
}) {
  if (stage.kind === 'look_board') {
    return (
      <div className="agent-image-stage is-look-board-stage">
        <div className="look-board-layout" data-look-board-id={stage.artifact.id}>
          <section className="look-board-hero" aria-label="Look Board 主视觉">
            <img src={stage.artifact.hero.imageUrl} alt={stage.artifact.title} />
          </section>
          <aside className="look-board-items" aria-label="关键单品">
            <div className="look-board-heading">
              <span className="eyebrow">MUSE LOOK</span>
              <h2>{stage.artifact.title}</h2>
              {stage.artifact.dateLabel && <time>{stage.artifact.dateLabel}</time>}
            </div>
            <div className="look-board-item-list">
              {stage.artifact.items.slice(0, 5).map((item) => (
                <article className={`look-board-item source-${item.source}`} key={item.conceptItemAssetId ?? item.closetItemId ?? item.productId ?? `${item.slot}-${item.label}`}>
                  <div className="look-board-item-image">
                    <img src={item.imageUrl} alt={item.label} />
                  </div>
                  <div className="look-board-item-copy">
                    <span>{item.badge}</span>
                    <strong>{item.label}</strong>
                    <small>{categoryLabel(item.category)}{item.color ? ` · ${item.color}` : ''}</small>
                  </div>
                </article>
              ))}
            </div>
            <p className="look-board-disclaimer">{stage.artifact.disclaimer}</p>
          </aside>
        </div>
        <div className="visual-actions" aria-label="视觉版本操作">
          <button type="button" onClick={onEdit}>Edit</button>
          <button type="button" onClick={onCompare} disabled>Compare</button>
          <button type="button" onClick={onRestore} disabled={!stage.artifact.parentVersionId}>Restore</button>
          <button
            type="button"
            onClick={() => {
              void downloadLookBoardAsPng(stage.artifact);
            }}
          >
            Download
          </button>
        </div>
      </div>
    );
  }

  if (stage.kind === 'item_visual') {
    return (
      <div className="agent-image-stage">
        <div className="single-item-visual-stage">
          <div className="single-item-visual-image">
            <img src={stage.artifact.imageUrl} alt={stage.artifact.label} />
          </div>
          <div className="single-item-visual-card">
            <span className="eyebrow">{stage.artifact.badge}</span>
            <h2>{stage.artifact.label}</h2>
            <p>{categoryLabel(stage.artifact.category)}{stage.artifact.color ? ` · ${stage.artifact.color}` : ''}</p>
            {stage.artifact.disclaimer && <small>{stage.artifact.disclaimer}</small>}
          </div>
        </div>
      </div>
    );
  }

  if (stage.kind === 'item_collection') {
    return (
      <div className="agent-items-stage">
        <div className="outfit-stage-heading">
          <div>
            <span className="eyebrow">AI CONCEPT ITEMS</span>
            <h2>{stage.artifact.title}</h2>
          </div>
          <small>{stage.artifact.items.length} 张已生成单品图</small>
        </div>
        <div className="concept-item-gallery">
          {stage.artifact.items.map((item) => (
            <article className="concept-item-gallery-card" key={item.conceptItemAssetId}>
              <div className="concept-item-gallery-image">
                <img src={item.imageUrl} alt={item.label} />
              </div>
              <div>
                <span>{item.badge}</span>
                <strong>{item.label}</strong>
                <small>{categoryLabel(item.category)}{item.color ? ` · ${item.color}` : ''}</small>
              </div>
            </article>
          ))}
        </div>
      </div>
    );
  }

  if (stage.kind === 'image') {
    const label = imagePreviewLabel(stage.artifact);
    const previous = visualHistory
      .filter((item) => item.visualVersionId !== stage.artifact.visualVersionId)
      .at(-1);
    const showVisualCard = !compareVisual && Boolean(stage.artifact.referenceItems?.length);
    const cardDate = new Date().toLocaleDateString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
    });
    return (
      <div className="agent-image-stage">
        {showVisualCard ? (
          <div className={`tryon-card-layout ${stage.artifact.previewScope === 'full_body' ? 'is-full-body' : 'is-upper-body'}`}>
            <div className="tryon-card-copy">
              <span># Muse Mirror Look</span>
              <time>{cardDate}</time>
            </div>
            <div className="tryon-card-person">
              <img src={stage.artifact.url} alt={stage.artifact.label} />
            </div>
            <div className="tryon-card-items" aria-label="关键单品">
              {stage.artifact.referenceItems?.slice(0, 5).map((item) => (
                <div className={`tryon-card-item ${item.imageUrl ? '' : 'is-concept'}`} key={item.id}>
                  {item.imageUrl ? (
                    <img src={item.imageUrl} alt={item.name} />
                  ) : (
                    <span className="concept-item-mark">{categoryLabel(item.category)}</span>
                  )}
                  <div>
                    <strong>{item.name}</strong>
                    <small>{item.source === 'closet' ? categoryLabel(item.category) : 'AI 概念单品'}</small>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className={`visual-main ${compareVisual && previous ? 'is-compare' : ''}`}>
            <img src={stage.artifact.url} alt={stage.artifact.label} />
            {compareVisual && previous && <img src={previous.url} alt={previous.label} />}
          </div>
        )}
        <div className="tryon-label">
          <span><Icon name="sparkle" size={14} /> {stage.artifact.partial ? '正在生成视觉预览' : label}</span>
          <strong>{stage.artifact.label}</strong>
          <small>{stage.artifact.disclaimer}</small>
        </div>
        {!stage.artifact.partial && (
          <div className="visual-actions" aria-label="视觉版本操作">
            <button type="button" onClick={onEdit}>Edit</button>
            <button type="button" onClick={onCompare} disabled={visualHistory.length < 2}>Compare</button>
            <button type="button" onClick={onRestore} disabled={visualHistory.length < 2}>Restore</button>
            <a href={stage.artifact.url} download>Download</a>
          </div>
        )}
        {visualHistory.length > 0 && (
          <div className="visual-history" aria-label="视觉历史版本">
            {visualHistory.slice(-6).map((item) => (
              <button
                type="button"
                key={item.visualVersionId ?? item.id}
                className={item.visualVersionId === stage.artifact.visualVersionId ? 'active' : ''}
                onClick={() => onSelect(item)}
                aria-label={item.label}
              >
                <img src={item.url} alt="" />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (stage.kind === 'items') {
    return (
      <div className="agent-items-stage">
        <div className="outfit-stage-heading">
          <div>
            <span className="eyebrow">CLOSET ITEMS</span>
            <h2>{stage.artifact.title}</h2>
          </div>
        </div>
        <div className="agent-item-grid">
          {stage.artifact.items.map((item) => (
            <div className="agent-stage-card" key={item.id}>
              <img src={item.imageUrl} alt={item.name} />
              <span>{item.name}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="agent-items-stage">
      <div className="outfit-stage-heading">
        <div>
          <span className="eyebrow">PRODUCTS</span>
          <h2>{stage.artifact.title}</h2>
        </div>
      </div>
      <div className="agent-item-grid">
        {stage.artifact.products.map((product) => (
          <div className="agent-stage-card" key={product.id}>
            <img src={product.imageUrl} alt={product.title} />
            <span>{product.brand} · {product.title}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConsentCard({
  busy,
  reason,
  onApprove,
  onCancel,
}: {
  busy: boolean;
  reason: string;
  onApprove: (faceMode: 'include' | 'conceal') => void;
  onCancel: () => void;
}) {
  return (
    <div className="consent-card">
      <div className="consent-icon"><Icon name="image" size={20} /></div>
      <div className="consent-copy">
        <span className="eyebrow">需要你的授权</span>
        <h3>这次上身预览要带脸吗？</h3>
        <p>{reason}</p>
        <div className="consent-actions">
          <button className="button button-dark button-small" onClick={() => onApprove('include')} disabled={busy}>
            {busy ? '正在继续...' : '带脸生成'}
          </button>
          <button className="button button-ghost button-small" onClick={() => onApprove('conceal')} disabled={busy}>
            不露脸，只看穿搭
          </button>
          <button className="button button-ghost button-small" onClick={onCancel} disabled={busy}>取消</button>
        </div>
      </div>
    </div>
  );
}

function parsePendingApprovalReply(text: string): 'include' | 'conceal' | 'cancel' | 'needs_face_choice' | null {
  const normalized = text.trim().toLowerCase().replace(/[\s,，。.!！?？、]/g, '');
  if (!normalized) return null;
  if (/^(不露脸|不要露脸|别露脸|不带脸|不要带脸|只看穿搭|只看衣服|遮脸|隐藏脸|去脸|无脸|noface|conceal)$/.test(normalized)) {
    return 'conceal';
  }
  if (/^(露脸|带脸|要露脸|要带脸|保留脸|露面|includeface)$/.test(normalized)) {
    return 'include';
  }
  if (/^(取消|算了|不做了|不要了|先不生成|不生成|不用了|stop|cancel)$/.test(normalized)) {
    return 'cancel';
  }
  if (/^(可以|确认|继续|好的|好|行|ok|yes|就这样)$/.test(normalized)) {
    return 'needs_face_choice';
  }
  return null;
}

function ArtifactStrip({ artifacts }: { artifacts: AgentArtifact[] }) {
  if (!artifacts.length) return null;
  return (
    <div className="artifact-strip">
      {artifacts.map((artifact) => {
        if (artifact.type === 'item_grid') {
          return (
            <div className="artifact-card" key={artifact.id}>
              <span className="eyebrow">衣柜实拍</span>
              <strong>{artifact.title}</strong>
              <div className="artifact-thumbs">
                {artifact.items.slice(0, 4).map((item) => (
                  <img key={item.id} src={item.imageUrl} alt={item.name} />
                ))}
              </div>
            </div>
          );
        }
        if (artifact.type === 'product_cards') {
          return (
            <div className="artifact-card" key={artifact.id}>
              <span className="eyebrow">真实商品图</span>
              <strong>{artifact.title}</strong>
              <span>{artifact.products.length} 个商品</span>
            </div>
          );
        }
        if (artifact.type === 'image') {
          return (
            <div className="artifact-card" key={artifact.id}>
              <span className="eyebrow">{artifact.source === 'ai_try_on' ? imagePreviewLabel(artifact).split(' · ')[0] : 'AI 搭配示意'}</span>
              <strong>{artifact.label}</strong>
              <span>已放到左侧视觉区</span>
            </div>
          );
        }
        if (artifact.type === 'item_visual') {
          return (
            <div className="artifact-card" key={artifact.id}>
              <span className="eyebrow">{artifact.badge}</span>
              <strong>{artifact.label}</strong>
              <span>已放到左侧视觉区</span>
            </div>
          );
        }
        if (artifact.type === 'item_collection') {
          return (
            <div className="artifact-card" key={artifact.id}>
              <span className="eyebrow">AI 概念单品</span>
              <strong>{artifact.title}</strong>
              <span>{artifact.items.length} 张单品图 · 已放到左侧视觉区</span>
            </div>
          );
        }
        if (artifact.type === 'look_board') {
          return (
            <div className="artifact-card" key={artifact.id}>
              <span className="eyebrow">LOOK BOARD</span>
              <strong>{artifact.title}</strong>
              <span>{artifact.items.length} 个单品 · 已放到左侧视觉区</span>
            </div>
          );
        }
        return (
          <div className={`artifact-card notice-${artifact.level}`} key={artifact.id}>
            <span className="eyebrow">提示</span>
            <strong>{artifact.text}</strong>
          </div>
        );
      })}
    </div>
  );
}

function ActivityTimeline({ activity }: { activity?: AgentActivity[] }) {
  const toolActivity = mirrorToolActivity(activity);
  if (!toolActivity.length || !shouldShowActivityTimeline(toolActivity)) return null;
  const visible = toolActivity.slice(0, 6);
  const statusLabel: Record<AgentActivity['status'], string> = {
    started: '进行中',
    completed: '完成',
    failed: '暂未完成',
    cancelled: '已取消',
  };
  const hasActiveStep = toolActivity.some((item) => item.status === 'started');
  const summary = summarizeMirrorActivity(toolActivity) ?? '完成了需要的能力';
  return (
    <details className="activity-timeline" aria-label="处理过程" open={hasActiveStep}>
      <summary>
        <span className="activity-summary-copy">
          <span className="eyebrow">过程</span>
          <strong>{summary}</strong>
        </span>
        <Icon name="chevron" />
      </summary>
      <div className="activity-list">
        {visible.map((item) => (
          <div className={`activity-item status-${item.status}`} key={item.id}>
            <i />
            <div>
              <strong>{item.label ?? mirrorActivityLabel(item)}</strong>
              <span>{item.displayDetail ?? statusLabel[item.status]}</span>
            </div>
          </div>
        ))}
      </div>
    </details>
  );
}

function DecisionSummaryCard({
  summary,
  onSelectRecommendationScope,
  onSelectExpressionIntensity,
  onSelectMemoryScope,
}: {
  summary?: MuseDecisionSummary;
  onSelectRecommendationScope: (scope: RecommendationScope) => void;
  onSelectExpressionIntensity: (intensity: ExpressionIntensity) => void;
  onSelectMemoryScope: (scope: PreferenceMemoryScope) => void;
}) {
  if (!summary) return null;
  const hasContent =
    summary.conclusion ||
    summary.checked.length ||
    summary.constraintsApplied.length ||
    summary.keyTradeoffs.length ||
    summary.uncertainties.length;
  if (!hasContent) return null;
  return (
    <details className="decision-summary">
      <summary>
        <span>为什么这样建议</span>
        <Icon name="chevron" />
      </summary>
      {summary.conclusion && <p>{summary.conclusion}</p>}
      <DecisionSummaryList title="看过的信息" items={summary.checked} />
      <DecisionSummaryList title="遵守的边界" items={summary.constraintsApplied} />
      <DecisionSummaryList title="取舍" items={summary.keyTradeoffs} />
      <DecisionSummaryList title="仍需确认" items={summary.uncertainties} />
      <div className="preference-correction">
        <strong>调整下次推荐</strong>
        <PreferenceButtonGroup
          label="推荐范围"
          options={recommendationScopeOptions}
          onSelect={(id) => onSelectRecommendationScope(id)}
        />
        <PreferenceButtonGroup
          label="表达强度"
          options={expressionIntensityOptions}
          onSelect={(id) => onSelectExpressionIntensity(id)}
        />
        <PreferenceButtonGroup
          label="作用范围"
          options={preferenceMemoryScopeOptions}
          onSelect={(id) => onSelectMemoryScope(id)}
        />
      </div>
    </details>
  );
}

function PreferenceButtonGroup<T extends string>({
  label,
  options,
  onSelect,
}: {
  label: string;
  options: Array<{ id: T; label: string }>;
  onSelect: (id: T) => void;
}) {
  return (
    <div className="preference-button-group">
      <span>{label}</span>
      <div>
        {options.map((option) => (
          <button type="button" key={option.id} onClick={() => onSelect(option.id)}>
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function DecisionSummaryList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <section>
      <strong>{title}</strong>
      <ul>
        {items.slice(0, 4).map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function MemoryUsageCard({
  usage,
  candidates,
  onOpenMemory,
}: {
  usage?: MemoryUsageDisclosure[];
  candidates?: ExplicitPreferenceEvent[];
  onOpenMemory: () => void;
}) {
  const active = usage ?? [];
  const pending = candidates ?? [];
  if (!active.length && !pending.length) return null;
  return (
    <div className="memory-usage-card">
      {!!active.length && (
        <div>
          <strong>本轮参考了记忆</strong>
          {active.slice(0, 3).map((item) => (
            <span key={item.label}>{item.label}</span>
          ))}
        </div>
      )}
      {!!pending.length && (
        <div>
          <strong>建议记住</strong>
          {pending.slice(0, 3).map((item) => (
            <span key={item.id}>{memoryValueLabel(item.intent.value)}</span>
          ))}
        </div>
      )}
      <button type="button" onClick={onOpenMemory}>管理记忆</button>
    </div>
  );
}

function memoryValueLabel(value: UserMemory['value']): string {
  if (value.namespace === 'avoidance') return `不推荐：${value.values.join('、')}`;
  if (value.namespace === 'style_preference' && value.key === 'expression_intensity') return `表达强度：${value.values.join('、')}`;
  if (value.namespace === 'style_preference' && value.key === 'style_tone') return `风格偏好：${value.values.join('、')}`;
  if (value.namespace === 'style_preference' && value.key === 'recommendation_scope') return `推荐范围：${value.values.join('、')}`;
  if (value.namespace === 'fit_preference') return `合身偏好：${value.values.join('、')}`;
  return value.values.join('、');
}

function HistoryPanel({
  conversations,
  currentId,
  onClose,
  onNew,
  onTemporary,
  onLoad,
  onDelete,
}: {
  conversations: Conversation[];
  currentId: string;
  onClose: () => void;
  onNew: () => void;
  onTemporary: () => void;
  onLoad: (conversation: Conversation) => void;
  onDelete: (conversation: Conversation, action: 'keep' | 'delete') => void;
}) {
  return (
    <div className="side-drawer history-drawer">
      <div className="drawer-header">
        <div>
          <span className="eyebrow">HISTORY</span>
          <strong>历史对话</strong>
        </div>
        <button type="button" onClick={onClose}>关闭</button>
      </div>
      <div className="drawer-actions">
        <button type="button" onClick={onNew}>新对话</button>
        <button type="button" onClick={onTemporary}>临时对话</button>
      </div>
      <div className="drawer-list">
        {conversations.length ? conversations.map((conversation) => (
          <div className={`drawer-row ${conversation.id === currentId ? 'active' : ''}`} key={conversation.id}>
            <button type="button" onClick={() => onLoad(conversation)}>
              <strong>{conversation.title}</strong>
              <span>{new Date(conversation.updatedAt).toLocaleString()}</span>
            </button>
            <div className="drawer-row-actions">
              <button type="button" onClick={() => onDelete(conversation, 'keep')}>删对话</button>
              <button type="button" onClick={() => onDelete(conversation, 'delete')}>连记忆删</button>
            </div>
          </div>
        )) : <p className="drawer-empty">还没有历史对话。</p>}
      </div>
    </div>
  );
}

function MemoryPanel({
  memories,
  candidates,
  policy,
  onPolicyChange,
  onClose,
  onPause,
  onDelete,
  onConfirm,
  onDismiss,
}: {
  memories: UserMemory[];
  candidates: ExplicitPreferenceEvent[];
  policy: MemoryPolicy;
  onPolicyChange: (policy: MemoryPolicy) => void;
  onClose: () => void;
  onPause: (memory: UserMemory, paused: boolean) => void;
  onDelete: (memory: UserMemory) => void;
  onConfirm: (candidate: ExplicitPreferenceEvent) => void;
  onDismiss: (candidate: ExplicitPreferenceEvent) => void;
}) {
  return (
    <div className="side-drawer memory-drawer">
      <div className="drawer-header">
        <div>
          <span className="eyebrow">MEMORY</span>
          <strong>Muse 记住了什么</strong>
        </div>
        <button type="button" onClick={onClose}>关闭</button>
      </div>
      <div className="memory-switches">
        <label><input type="checkbox" checked={policy.usePersistentMemories} onChange={(event) => onPolicyChange({ ...policy, usePersistentMemories: event.target.checked })} /> 使用长期记忆</label>
        <label><input type="checkbox" checked={policy.allowExplicitMemoryWrites} onChange={(event) => onPolicyChange({ ...policy, allowExplicitMemoryWrites: event.target.checked })} /> 允许显式写入</label>
        <label><input type="checkbox" checked={policy.referencePastChats} onChange={(event) => onPolicyChange({ ...policy, referencePastChats: event.target.checked })} /> 引用历史对话</label>
      </div>
      {!!candidates.length && (
        <section className="memory-section">
          <strong>建议记住</strong>
          {candidates.map((candidate) => (
            <div className="memory-row pending" key={candidate.id}>
              <span>{memoryValueLabel(candidate.intent.value)}</span>
              <div>
                <button type="button" onClick={() => onConfirm(candidate)}>记住</button>
                <button type="button" onClick={() => onDismiss(candidate)}>忽略</button>
              </div>
            </div>
          ))}
        </section>
      )}
      <section className="memory-section">
        <strong>已保存</strong>
        {memories.length ? memories.map((memory) => (
          <div className={`memory-row status-${memory.status}`} key={memory.id}>
            <span>{memoryValueLabel(memory.value)}</span>
            <small>{memory.status === 'active' ? '启用中' : memory.status}</small>
            <div>
              <button type="button" onClick={() => onPause(memory, memory.status !== 'paused')}>
                {memory.status === 'paused' ? '启用' : '暂停'}
              </button>
              <button type="button" onClick={() => onDelete(memory)}>删除</button>
            </div>
          </div>
        )) : <p className="drawer-empty">Muse 暂时没有长期记忆。</p>}
      </section>
    </div>
  );
}

function shouldShowActivityTimeline(activity: AgentActivity[]): boolean {
  if (!activity.length) return false;
  const names = new Set(activity.map((item) => item.toolName));
  if ([...names].some(isMirrorVisualGenerationTool)) return true;
  if (names.size >= 2) return true;
  const single = activity[activity.length - 1];
  const elapsed = single.elapsedMs ?? (single.status === 'started' ? Date.now() - single.timestamp : 0);
  return elapsed > 1200 && !hasOnlyFastPerception(names);
}

function hasPerceptionTool(names: Set<string | undefined>): boolean {
  return names.has('observe_current_frame');
}

function hasOnlyFastPerception(names: Set<string | undefined>): boolean {
  return names.size === 1 && hasPerceptionTool(names);
}

function mergeActivity(current: AgentActivity[] = [], activity: AgentActivity): AgentActivity[] {
  const semanticKey = activityKey(activity);
  return [...current.filter((item) => item.id !== activity.id && activityKey(item) !== semanticKey), activity];
}

function activityKey(activity: AgentActivity): string {
  return [
    activity.type,
    activity.toolName ?? '',
    activity.status,
    activity.label ?? '',
    activity.displayDetail ?? '',
  ].join('|');
}

function hasFreshObservation(perception: PerceptionState): boolean {
  if (perception.status !== 'observed' || !perception.analyzedAt) return false;
  if (perception.expiresAt && Date.now() > perception.expiresAt) return false;
  return true;
}

function perceptionLabel(cameraState: CameraState, perception: PerceptionState): string {
  if (cameraState !== 'active') return 'Camera off';
  if (hasFreshObservation(perception)) {
    if (perception.visibleRegion === 'full_body') return '已看到全身';
    if (perception.visibleRegion === 'upper_body') return '已看到上半身';
    return '已看到部分画面';
  }
  if (perception.status === 'unclear' || perception.status === 'failed' || perception.failureReason) return '暂未拿到视觉结果';
  return '镜子预览中';
}

function captureStatusText(cameraState: CameraState, perception: PerceptionState): string {
  if (cameraState !== 'active') return '开启镜子后可带当前帧';
  if (hasFreshObservation(perception)) return perception.summary ?? perceptionLabel(cameraState, perception);
  if (perception.status === 'frame_received' || perception.status === 'analyzing') return '已收到镜子帧，正在形成观察';
  if (perception.status === 'unclear' || perception.status === 'failed') return '暂未拿到稳定视觉结果';
  return '本地预览中，按需带当前帧';
}

function normalizeMarkdownText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/([。！？!?])\s+(#{2,4}\s+)/g, '$1\n\n$2')
    .replace(/\s+(#{2,4}\s+)/g, '\n\n$1')
    .replace(/\s+(-\s+\*\*)/g, '\n$1')
    .replace(/([^\n])\s+(\d+\.\s+\*\*)/g, '$1\n$2')
    .trim();
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+?\*\*)/g);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    return part;
  });
}

function isOrderedListConnector(line: string): boolean {
  return /^(或者|或)[:：]?$/.test(line.trim());
}

function renderMarkdownBlocks(text: string): ReactNode[] {
  const lines = normalizeMarkdownText(text).split('\n');
  const blocks: ReactNode[] = [];
  let orderedListNextStart: number | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;

    const heading = /^(#{2,4})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push(
        <h4 className="message-heading" key={`heading-${index}`}>
          {renderInlineMarkdown(heading[2])}
        </h4>,
      );
      orderedListNextStart = null;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*]\s+/, ''));
        index += 1;
      }
      index -= 1;
      blocks.push(
        <ul className="message-list-markdown" key={`ul-${index}`}>
          {items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item)}</li>)}
        </ul>,
      );
      orderedListNextStart = null;
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      const firstNumber = Number(/^(\d+)\.\s+/.exec(line)?.[1] ?? 1);
      const start: number = orderedListNextStart ?? firstNumber;
      while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+\.\s+/, ''));
        index += 1;
      }
      index -= 1;
      blocks.push(
        <ol className="message-list-markdown" key={`ol-${index}`} start={start}>
          {items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item)}</li>)}
        </ol>,
      );
      orderedListNextStart = start + items.length;
      continue;
    }

    const paragraphLines = [line];
    while (
      index + 1 < lines.length &&
      lines[index + 1].trim() &&
      !/^(#{2,4})\s+/.test(lines[index + 1].trim()) &&
      !/^[-*]\s+/.test(lines[index + 1].trim()) &&
      !/^\d+\.\s+/.test(lines[index + 1].trim())
    ) {
      index += 1;
      paragraphLines.push(lines[index].trim());
    }
    blocks.push(
      <p key={`p-${index}`}>
        {renderInlineMarkdown(paragraphLines.join(' '))}
      </p>,
    );
    if (!paragraphLines.every(isOrderedListConnector)) orderedListNextStart = null;
  }

  return blocks;
}

function MessageBubble({
  message,
  onSelectRecommendationScope,
  onSelectExpressionIntensity,
  onSelectMemoryScope,
  onOpenMemory,
}: {
  message: Message;
  onSelectRecommendationScope: (scope: RecommendationScope) => void;
  onSelectExpressionIntensity: (intensity: ExpressionIntensity) => void;
  onSelectMemoryScope: (scope: PreferenceMemoryScope) => void;
  onOpenMemory: () => void;
}) {
  return (
    <div className={`message-row ${message.role}`}>
      {message.role === 'assistant' && <div className="agent-avatar">M</div>}
      <div className="message-stack">
        {message.role === 'assistant' && message.commentary && !message.text && (
          <div className="commentary-line">{message.commentary}</div>
        )}
        {message.role === 'assistant' && message.isTyping && !message.text && !message.commentary && (
          <div className="typing-indicator"><span /><span /><span /></div>
        )}
        {message.role === 'assistant' && <ActivityTimeline activity={message.activity} />}
        {message.text && (
          <div className={`message-bubble ${message.role === 'assistant' ? 'markdown-message' : ''}`}>
            {message.role === 'assistant' ? renderMarkdownBlocks(message.text) : message.text}
          </div>
        )}
        {message.role === 'assistant' && (
          <DecisionSummaryCard
            summary={message.decisionSummary}
            onSelectRecommendationScope={onSelectRecommendationScope}
            onSelectExpressionIntensity={onSelectExpressionIntensity}
            onSelectMemoryScope={onSelectMemoryScope}
          />
        )}
        {message.role === 'assistant' && (
          <MemoryUsageCard
            usage={message.memoryUsage}
            candidates={message.pendingMemoryCandidates}
            onOpenMemory={onOpenMemory}
          />
        )}
        {message.artifacts && <ArtifactStrip artifacts={message.artifacts} />}
      </div>
    </div>
  );
}

function App() {
  const [userId] = useState(getOrCreateBrowserUserId);
  const [sessionId] = useState(makeSessionId);
  const [cameraState, setCameraState] = useState<CameraState>('idle');
  const [mirror, setMirror] = useState(true);
  const [visualMode, setVisualMode] = useState<VisualMode>('live');
  const [stageArtifact, setStageArtifact] = useState<StageArtifact | null>(null);
  const [visualHistory, setVisualHistory] = useState<Array<Extract<AgentArtifact, { type: 'image' }>>>([]);
  const [compareVisual, setCompareVisual] = useState(false);
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [conversationId, setConversationId] = useState<string>('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [memories, setMemories] = useState<UserMemory[]>([]);
  const [memoryCandidates, setMemoryCandidates] = useState<ExplicitPreferenceEvent[]>([]);
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [conversationExpanded, setConversationExpanded] = useState(false);
  const [temporaryChat, setTemporaryChat] = useState(false);
  const [memoryPolicy, setMemoryPolicy] = useState<MemoryPolicy>({
    usePersistentMemories: true,
    referencePastChats: false,
    allowExplicitMemoryWrites: true,
  });
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState('');
  const [responding, setResponding] = useState(false);
  const [streamingAssistantId, setStreamingAssistantId] = useState<string | null>(null);
  const [liveActivity, setLiveActivity] = useState<AgentActivity[]>([]);
  const [developmentSituationScenarioId, setDevelopmentSituationScenarioId] = useState('');
  const [transport, setTransport] = useState<'api' | 'mock' | 'unknown'>('unknown');
  const [agentStatusLabel, setAgentStatusLabel] = useState('在线 · 可自然对话');
  const [statusNote, setStatusNote] = useState('Muse Mirror 在线；需要时会按权限使用镜子、衣柜和图片能力。');
  const [mirrorFrameIntervalMs, setMirrorFrameIntervalMs] = useState(6000);
  const [stylingProfile, setStylingProfile] = useState<StylingProfile>(defaultStylingProfile);
  const [pendingStylingOverride, setPendingStylingOverride] = useState<TurnRequest['stylingProfileOverride'] | undefined>();
  const [pendingPreferenceUiEvents, setPendingPreferenceUiEvents] = useState<PreferenceUiEvent[]>([]);
  const [perception, setPerception] = useState<PerceptionState>({
    cameraActive: false,
    status: 'no_camera',
    failureReason: 'no_frame',
  });
  const [ambientCaptureEnabled, setAmbientCaptureEnabled] = useState(false);
  const [showAmbientGrantPrompt, setShowAmbientGrantPrompt] = useState(false);
  const [ambientCaptureEvent, setAmbientCaptureEvent] = useState<AmbientCaptureCompletedEvent>();
  const [ambientCaptureOutcome, setAmbientCaptureOutcome] = useState<AmbientCaptureOutcome>();
  const [ambientCaptureCounts, setAmbientCaptureCounts] = useState({ closet: 0, captures: 0 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mirrorFrameInFlight = useRef(false);
  const ambientFrameInFlight = useRef(false);
  const ambientPreviousSample = useRef<FrameStabilitySample | undefined>(undefined);
  const ambientStableSamples = useRef(0);
  const ambientNextCaptureAt = useRef(0);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const typingTimerRef = useRef<number | undefined>(undefined);
  const idRef = useRef(1);

  const bindVideoRef = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element;
    const stream = streamRef.current;
    if (!element || !stream) return;
    if (element.srcObject !== stream) {
      element.srcObject = stream;
    }
    if (cameraState === 'active') {
      void element.play().catch(() => undefined);
    }
  }, [cameraState]);

  const nextMessageId = () => {
    idRef.current += 1;
    return `msg_${idRef.current}_${Date.now().toString(36)}`;
  };

  const addMessage = (message: Omit<Message, 'id'>) => {
    const id = nextMessageId();
    setMessages((current) => [...current, { ...message, id }]);
    return id;
  };

  const updateMessage = (id: string, updater: (message: Message) => Message) => {
    setMessages((current) => current.map((message) => (message.id === id ? updater(message) : message)));
  };

  useEffect(() => {
    if (!conversationExpanded) return;
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [conversationExpanded, messages, pendingApproval, responding, liveActivity]);

  useEffect(() => () => {
    if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getAmbientCaptureState(userId)
      .then((state) => {
        if (cancelled) return;
        setAmbientCaptureEnabled(state.diagnostics.grantActive);
        setAmbientCaptureOutcome(state.diagnostics.lastOutcome);
        setAmbientCaptureEvent(state.pendingCompletionEvent);
        setAmbientCaptureCounts({
          closet: state.diagnostics.closetItemCount,
          captures: state.diagnostics.captureCount,
        });
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [userId]);

  useEffect(() => {
    if (ambientCaptureOutcome?.status !== 'committed_processing_images') return undefined;
    let cancelled = false;
    const poll = window.setInterval(() => {
      void getAmbientCaptureState().then((state) => {
        if (cancelled) return;
        setAmbientCaptureOutcome(state.diagnostics.lastOutcome);
        if (state.pendingCompletionEvent) setAmbientCaptureEvent(state.pendingCompletionEvent);
      }).catch(() => undefined);
    }, 1800);
    return () => { cancelled = true; window.clearInterval(poll); };
  }, [ambientCaptureOutcome?.status]);

  useEffect(() => {
    if (!ambientCaptureEvent) return undefined;
    const eventId = ambientCaptureEvent.eventId;
    const timer = window.setTimeout(() => {
      void acknowledgeAmbientCapture()
        .then(() => {
          setAmbientCaptureEvent((current) => current?.eventId === eventId ? undefined : current);
        })
        .catch(() => undefined);
    }, 7_000);
    return () => window.clearTimeout(timer);
  }, [ambientCaptureEvent?.eventId]);

  useEffect(() => {
    let cancelled = false;
    getAgentStatus()
      .then((status) => {
        if (cancelled) return;
        if (status.agentReady) {
          setTransport('api');
          setAgentStatusLabel('Muse Mirror 小助手已连接');
          const image = status.capabilities?.image;
          const imageToolHost = status.capabilities?.imageToolHost;
          const imageNote = image?.generationReady
            ? imageToolHost?.ready
              ? '视觉生成宿主和图片模型已验证。'
              : '图片模型已验证，视觉生成宿主暂未验证。'
            : '图片生成暂未验证。';
	          setStatusNote(
	            status.provider === 'gemma4'
	              ? '对话小助手和视觉助手已在线。'
	              : `Muse 已连接。${imageNote}`,
	          );
          if (typeof status.mirrorFrameIntervalMs === 'number') {
            setMirrorFrameIntervalMs(status.mirrorFrameIntervalMs);
          }
        } else {
          setTransport('mock');
          setAgentStatusLabel('在线 · 可自然对话');
          setStatusNote('小助手暂不可用；不会展示模拟结果。');
        }
      })
      .catch(() => {
        if (cancelled) return;
        setTransport('mock');
        setStatusNote('Muse 暂不可用；不会展示模拟结果。');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshMemoryState = async () => {
    const [nextMemories, nextCandidates] = await Promise.all([
      listMemories(userId),
      listMemoryCandidates(userId),
    ]);
    setMemories(nextMemories);
    setMemoryCandidates(nextCandidates);
  };

  const refreshConversations = async () => {
    const next = await listConversations(userId);
    setConversations(next);
    return next;
  };

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      try {
        const [created] = await Promise.all([
          createConversation({ userId }),
          refreshMemoryState(),
        ]);
        if (cancelled) return;
        setConversationId(created.conversation.id);
        void refreshConversations();
      } catch {
        if (!cancelled) {
          setConversationId(`local_${sessionId}`);
        }
      }
    };
    void boot();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const loadConversation = async (conversation: Conversation) => {
    setTemporaryChat(false);
    setMemoryPolicy({
      usePersistentMemories: true,
      referencePastChats: false,
      allowExplicitMemoryWrites: true,
    });
    setConversationId(conversation.id);
    const loaded = await getConversationMessages(userId, conversation.id);
    const nextMessages = messagesFromConversation(loaded);
    setMessages(nextMessages.length ? nextMessages : initialMessages);
    setShowHistoryPanel(false);
  };

  const startNewConversation = async () => {
    const created = await createConversation({ userId });
    setConversationId(created.conversation.id);
    setTemporaryChat(false);
    setMemoryPolicy({
      usePersistentMemories: true,
      referencePastChats: false,
      allowExplicitMemoryWrites: true,
    });
    setMessages(initialMessages);
    setShowHistoryPanel(false);
    void refreshConversations();
  };

  const startTemporaryConversation = () => {
    setTemporaryChat(true);
    setConversationId(`temp_${makeSessionId()}`);
    setMessages(initialMessages);
    setMemoryPolicy({
      usePersistentMemories: false,
      referencePastChats: false,
      allowExplicitMemoryWrites: false,
    });
    setShowHistoryPanel(false);
  };

  const deleteConversationFromUi = async (conversation: Conversation, memoryAction: 'keep' | 'delete') => {
    await deleteConversation({ userId, conversationId: conversation.id, memoryAction });
    void refreshConversations();
    void refreshMemoryState();
    if (conversation.id === conversationId) {
      await startNewConversation();
    }
  };

  const confirmMemoryCandidateFromUi = async (candidate: ExplicitPreferenceEvent) => {
    await confirmMemoryCandidate({ userId, candidateId: candidate.id });
    await refreshMemoryState();
  };

  const dismissMemoryCandidateFromUi = async (candidate: ExplicitPreferenceEvent) => {
    await dismissMemoryCandidate({ userId, candidateId: candidate.id });
    await refreshMemoryState();
  };

  const pauseMemoryFromUi = async (memory: UserMemory, paused: boolean) => {
    await setMemoryPaused({ userId, memoryId: memory.id, paused });
    await refreshMemoryState();
  };

  const deleteMemoryFromUi = async (memory: UserMemory) => {
    await deleteMemory({ userId, memoryId: memory.id });
    await refreshMemoryState();
  };

  const startCamera = async () => {
    setCameraState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraState('active');
      setPerception((current) => ({
        ...current,
        cameraActive: true,
        status: current.status === 'no_camera' || current.status === 'failed' ? 'preview_only' : current.status,
        failureReason: undefined,
      }));
      setVisualMode('live');
    } catch {
      setCameraState('error');
      setPerception((current) => ({
        ...current,
        cameraActive: false,
        status: 'failed',
        failureReason: 'permission',
      }));
    }
  };

  useEffect(() => {
    if (visualMode !== 'live' || cameraState !== 'active') return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }
    void video.play().catch(() => undefined);
  }, [cameraState, visualMode]);

  const togglePause = () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const nextEnabled = !track.enabled;
    track.enabled = nextEnabled;
    setCameraState(nextEnabled ? 'active' : 'paused');
    setPerception((current) => ({
      ...current,
      cameraActive: nextEnabled,
      status: nextEnabled ? (current.status === 'no_camera' ? 'preview_only' : current.status) : current.status,
    }));
    if (!nextEnabled && ambientCaptureEnabled) {
      void endAmbientCaptureEpisode({ userId, sessionId }).catch(() => undefined);
    }
  };

  const takeSnapshot = (maxWidth = 960, quality = 0.82): string | null => {
    let captured: string | null = null;
    const video = videoRef.current;
    if (video && video.videoWidth > 0) {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, maxWidth / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        if (mirror) {
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        captured = canvas.toDataURL('image/jpeg', quality);
      }
    }
    return captured;
  };

  useEffect(() => {
    if (cameraState !== 'active' || !streamRef.current) return undefined;
    let cancelled = false;
    const sendFrame = async () => {
      if (cancelled || mirrorFrameInFlight.current || document.hidden) return;
      const capturedImageDataUrl = takeSnapshot(480, 0.7);
      if (!capturedImageDataUrl) return;
      mirrorFrameInFlight.current = true;
      try {
        const result = await sendMirrorFrame({
          sessionId,
          userId,
          cameraLocalActive: true,
          capturedImageDataUrl,
          permissions: {
            allowVisualAnalysis: true,
            allowAiImageGeneration: false,
            allowPhotoUseForTryOn: false,
            allowPersistentMemory: false,
          },
        });
        if (result.perception) setPerception(result.perception);
        if (
          result.status === 'accepted' &&
          (result.perception?.status === 'frame_received' || result.perception?.status === 'analyzing')
        ) {
          window.setTimeout(() => {
            if (cancelled) return;
            void getPerceptionStatus(sessionId).then(setPerception).catch(() => undefined);
          }, 1600);
        }
      } catch {
        setPerception((current) => ({
          ...current,
          cameraActive: true,
          status: 'failed',
          failureReason: 'network',
        }));
        // Mirror frame cache is opportunistic; chat still works without it.
      } finally {
        mirrorFrameInFlight.current = false;
      }
    };
    const timer = window.setInterval(() => { void sendFrame(); }, Math.max(3000, mirrorFrameIntervalMs));
    const warmup = window.setTimeout(() => { void sendFrame(); }, 800);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearTimeout(warmup);
    };
  }, [cameraState, mirror, mirrorFrameIntervalMs, sessionId]);

  useEffect(() => {
    if (cameraState !== 'active') return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      getPerceptionStatus(sessionId)
        .then((next) => {
          if (!cancelled) setPerception((current) => ({ ...next, cameraActive: current.cameraActive || next.cameraActive }));
        })
        .catch(() => undefined);
    }, Math.max(3000, mirrorFrameIntervalMs));
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [cameraState, mirrorFrameIntervalMs, sessionId]);

  useEffect(() => {
    if (!ambientCaptureEnabled || cameraState !== 'active' || !streamRef.current) {
      ambientPreviousSample.current = undefined;
      ambientStableSamples.current = 0;
      return undefined;
    }
    let cancelled = false;
    const sampleIntervalMs = 1200;
    const inspect = async () => {
      const video = videoRef.current;
      if (!video || cancelled || document.hidden || ambientFrameInFlight.current) return;
      const sample = sampleVideoFrame(video, mirror);
      if (!sample) return;
      const score = frameStabilityScore(ambientPreviousSample.current, sample);
      ambientPreviousSample.current = sample;
      ambientStableSamples.current = nextStableSampleCount(ambientStableSamples.current, score);
      if (ambientStableSamples.current < 3 || Date.now() < ambientNextCaptureAt.current) return;
      const capturedImageDataUrl = takeSnapshot(1280, 0.9);
      if (!capturedImageDataUrl) return;
      ambientFrameInFlight.current = true;
      ambientStableSamples.current = 0;
      try {
        const response = await sendAmbientCaptureFrame({
          userId,
          sessionId,
          frameId: `ambient_${Date.now().toString(36)}`,
          capturedAt: new Date().toISOString(),
          capturedImageDataUrl,
          activeTask: responding || generating || Boolean(pendingApproval),
          stability: {
            score,
            stableSamples: 3,
            sampleIntervalMs,
            sourceWidth: sample.sourceWidth,
            sourceHeight: sample.sourceHeight,
          },
        });
        if (cancelled) return;
        setAmbientCaptureOutcome(response.outcome);
        if (response.outcome.completedEvent) {
          setAmbientCaptureEvent(response.outcome.completedEvent);
          setAmbientCaptureCounts((current) => ({
            closet: current.closet + response.outcome.completedEvent!.newItemIds.length,
            captures: current.captures + (response.outcome.status === 'already_committed' ? 0 : 1),
          }));
        }
        ambientNextCaptureAt.current = Date.now() + (response.outcome.retryAfterMs ?? 5_000);
      } catch {
        ambientNextCaptureAt.current = Date.now() + 10_000;
        // Ambient capture is deliberately non-blocking. Chat and the local
        // mirror continue even when its real vision provider is unavailable.
      } finally {
        ambientFrameInFlight.current = false;
      }
    };
    const timer = window.setInterval(() => { void inspect(); }, sampleIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [ambientCaptureEnabled, cameraState, generating, mirror, pendingApproval, responding, sessionId, userId]);

  const enableAmbientCapture = async () => {
    await setAmbientCaptureGrant({ userId, enabled: true });
    setAmbientCaptureEnabled(true);
    setShowAmbientGrantPrompt(false);
    ambientPreviousSample.current = undefined;
    ambientStableSamples.current = 0;
    ambientNextCaptureAt.current = 0;
  };

  const disableAmbientCapture = async () => {
    await setAmbientCaptureGrant({ userId, enabled: false });
    setAmbientCaptureEnabled(false);
    setShowAmbientGrantPrompt(false);
    ambientPreviousSample.current = undefined;
    ambientStableSamples.current = 0;
    ambientNextCaptureAt.current = 0;
    await endAmbientCaptureEpisode({ userId, sessionId }).catch(() => undefined);
  };

  const toggleAmbientCapture = () => {
    if (ambientCaptureEnabled) {
      void disableAmbientCapture();
      return;
    }
    setShowAmbientGrantPrompt(true);
  };

  const resetAmbientCaptureFromUi = async () => {
    await resetAmbientCapture(userId);
    setAmbientCaptureEnabled(false);
    setAmbientCaptureEvent(undefined);
    setAmbientCaptureOutcome(undefined);
    setAmbientCaptureCounts({ closet: 0, captures: 0 });
  };

  const updateStageFromArtifacts = (artifacts: AgentArtifact[]) => {
    const lookBoard = [...artifacts].reverse().find((artifact): artifact is Extract<AgentArtifact, { type: 'look_board' }> => artifact.type === 'look_board');
    if (lookBoard) {
      setStageArtifact({ kind: 'look_board', artifact: lookBoard });
      setVisualMode('agent-look-board');
      setCompareVisual(false);
      return;
    }

    const itemVisual = [...artifacts].reverse().find((artifact): artifact is Extract<AgentArtifact, { type: 'item_visual' }> => artifact.type === 'item_visual');
    if (itemVisual) {
      setStageArtifact({ kind: 'item_visual', artifact: itemVisual });
      setVisualMode('agent-look-board');
      setCompareVisual(false);
      return;
    }

    const itemCollection = [...artifacts].reverse().find((artifact): artifact is Extract<AgentArtifact, { type: 'item_collection' }> => artifact.type === 'item_collection');
    if (itemCollection) {
      setStageArtifact({ kind: 'item_collection', artifact: itemCollection });
      setVisualMode('agent-look-board');
      setCompareVisual(false);
      return;
    }

    const image = [...artifacts].reverse().find((artifact): artifact is Extract<AgentArtifact, { type: 'image' }> => artifact.type === 'image');
    if (image) {
      setStageArtifact({ kind: 'image', artifact: image });
      if (!image.partial && !image.temporary) {
        setVisualHistory((current) => {
          const key = image.visualVersionId ?? image.id;
          return [...current.filter((item) => (item.visualVersionId ?? item.id) !== key), image].slice(-8);
        });
      }
      return;
    }

    const itemGrid = [...artifacts].reverse().find((artifact): artifact is Extract<AgentArtifact, { type: 'item_grid' }> => artifact.type === 'item_grid');
    if (itemGrid) {
      setStageArtifact({ kind: 'items', artifact: itemGrid });
      return;
    }

    const products = [...artifacts].reverse().find((artifact): artifact is Extract<AgentArtifact, { type: 'product_cards' }> => artifact.type === 'product_cards');
    if (products) {
      setStageArtifact({ kind: 'products', artifact: products });
    }
  };

  const applyAgentResult = (result: AgentTurnResult, targetMessageId?: string) => {
    updateStageFromArtifacts(result.artifacts);
    if (result.status === 'approval_required') {
      setPendingApproval({
        approvals: result.approvals,
        resumeToken: result.resumeToken,
      });
      const reason =
        result.approvals[0]?.reason ??
        '这个操作需要你的确认。默认不长期保存原图，AI 预览仅供视觉参考。';
      const message = {
        role: 'assistant' as const,
        text: `可以继续，但需要你先确认：${reason}`,
        artifacts: result.artifacts,
        activity: result.activity,
        commentary: undefined,
        isTyping: false,
      };
      if (targetMessageId) {
        updateMessage(targetMessageId, (current) => ({ ...current, ...message }));
      } else {
        addMessage(message);
      }
      return;
    }
    if (result.state.perception) setPerception(result.state.perception);
    if (result.state.stylingProfile) setStylingProfile(result.state.stylingProfile);
    if (result.state.pendingMemoryCandidates?.length || result.state.memoryUsage?.length) {
      void refreshMemoryState();
    }

    const message = {
      role: 'assistant',
      text: result.text || (result.artifacts.length ? '我把结果放在左侧视觉区了。' : '好的。'),
      artifacts: result.artifacts,
      activity: result.activity,
      decisionSummary: result.decisionSummary,
      memoryUsage: result.state.memoryUsage,
      pendingMemoryCandidates: result.state.pendingMemoryCandidates,
      commentary: undefined,
      isTyping: false,
    } satisfies Omit<Message, 'id'>;
    if (targetMessageId) {
      updateMessage(targetMessageId, (current) => ({ ...current, ...message }));
    } else {
      addMessage(message);
    }
  };

  const runAgentFailure = (error?: unknown, targetMessageId?: string) => {
    setTransport('mock');
    setStatusNote(
      error instanceof Error
        ? 'Muse 暂不可用；没有展示模拟结果。'
        : 'Muse 暂未返回；没有展示模拟结果。',
    );
    const message = {
      role: 'assistant',
      text: 'Muse 这轮暂时没有成功返回，所以我不展示模拟答案。你可以稍后再试，或者刷新后重新发一次。',
      activity: [],
      commentary: undefined,
      isTyping: false,
    } satisfies Omit<Message, 'id'>;
    if (targetMessageId) {
      updateMessage(targetMessageId, (current) => ({
        ...current,
        ...message,
      }));
    } else {
      addMessage(message);
    }
  };

  const sendAgentMessage = async (
    text: string,
    source: MessageSource,
    traceId?: string,
  ): Promise<AgentTurnResult | undefined> => {
    const capturedImageDataUrl =
      cameraState === 'active' && streamRef.current ? takeSnapshot(1280, 0.85) : null;
    const stylingOverrideForTurn = pendingStylingOverride;
    const preferenceUiEventsForTurn = pendingPreferenceUiEvents;
    addMessage({ role: 'user', text });
    const assistantId = nextMessageId();
    setMessages((current) => [
      ...current,
      { id: assistantId, role: 'assistant', text: '', artifacts: [], activity: [] },
    ]);
    setResponding(true);
    setStreamingAssistantId(assistantId);
    setLiveActivity([]);
    setPendingApproval(null);
    let streamedText = '';
    let streamedArtifacts: AgentArtifact[] = [];
    const clearWaitingState = () => {
      if (typingTimerRef.current) {
        window.clearTimeout(typingTimerRef.current);
        typingTimerRef.current = undefined;
      }
      updateMessage(assistantId, (message) => ({ ...message, isTyping: false }));
    };
    typingTimerRef.current = window.setTimeout(() => {
      updateMessage(assistantId, (message) => (
        message.text || message.commentary ? message : { ...message, isTyping: true }
      ));
    }, 500);

    try {
      const result = await runAgentTurnStream(
        {
          sessionId,
          userId,
          inputSource: source,
          traceId,
          conversationId,
          temporary: temporaryChat,
          message: text,
          cameraLocalActive: cameraState === 'active',
          capturedImageDataUrl,
          stylingProfileOverride: stylingOverrideForTurn,
          preferenceUiEvents: preferenceUiEventsForTurn,
          memoryPolicy,
          locale: 'zh-CN',
	          permissions: {
	            allowVisualAnalysis: Boolean(capturedImageDataUrl),
	            allowAiImageGeneration: true,
	            allowPhotoUseForTryOn: false,
	            allowPersistentMemory: memoryPolicy.allowExplicitMemoryWrites,
	          },
        },
        (activity) => {
          clearWaitingState();
          setLiveActivity((current) => mergeActivity(current, activity));
          updateMessage(assistantId, (message) => ({
            ...message,
            activity: mergeActivity(message.activity, activity),
          }));
        },
        (delta) => {
          clearWaitingState();
          if (traceId && !streamedText) {
            markMuseLatency(traceId, 'first_final_answer_delta');
          }
          streamedText += delta;
          updateMessage(assistantId, (message) => ({ ...message, text: streamedText, commentary: undefined }));
        },
        (artifact) => {
          clearWaitingState();
          streamedArtifacts = [...streamedArtifacts.filter((item) => item.id !== artifact.id), artifact];
          updateStageFromArtifacts(streamedArtifacts);
          updateMessage(assistantId, (message) => ({
            ...message,
            artifacts: streamedArtifacts,
          }));
        },
        (commentary) => {
          clearWaitingState();
          updateMessage(assistantId, (message) => (
            message.text ? message : { ...message, commentary }
          ));
        },
      );
      if (traceId) {
        markMuseLatency(traceId, 'final_result_ready');
        if (result.status === 'completed') {
          attachMuseServerTelemetry(traceId, result.telemetry);
        }
      }
      setTransport('api');
      setAgentStatusLabel('Muse Mirror 小助手已响应');
      setStatusNote('小助手已响应；工具和图片权限由后端策略控制。');
      setPendingStylingOverride(undefined);
      setPendingPreferenceUiEvents([]);
      applyAgentResult(result, assistantId);
      void refreshConversations();
      return result;
    } catch (error) {
      clearWaitingState();
      runAgentFailure(error, assistantId);
      return undefined;
    } finally {
      if (typingTimerRef.current) {
        window.clearTimeout(typingTimerRef.current);
        typingTimerRef.current = undefined;
      }
      setLiveActivity([]);
      setResponding(false);
      setStreamingAssistantId(null);
    }
  };

  const approveTryOn = async (faceMode: 'include' | 'conceal') => {
    if (!pendingApproval) {
      addMessage({ role: 'assistant', text: '目前没有等待确认的真实生成任务。' });
      return;
    }

    setGenerating(true);
    try {
      const result = await resumeAgentTurn({
        sessionId,
        userId,
        resumeToken: pendingApproval.resumeToken,
	        decisions: pendingApproval.approvals.map((approval) => ({
	          index: approval.index,
	          approved: true,
	          faceMode,
	        })),
        permissions: {
          allowVisualAnalysis: true,
          allowAiImageGeneration: true,
          allowPhotoUseForTryOn: true,
          allowPersistentMemory: false,
        },
      });
      setPendingApproval(null);
      setTransport('api');
      applyAgentResult(result);
    } catch (error) {
      runAgentFailure(error);
    } finally {
      setGenerating(false);
    }
  };

  const cancelTryOn = async () => {
    if (!pendingApproval) {
      addMessage({ role: 'assistant', text: '好的，不生成上身预览。我们可以继续只看搭配方案。' });
      return;
    }

    const approval = pendingApproval;
    setPendingApproval(null);
    try {
      const result = await resumeAgentTurn({
        sessionId,
        userId,
        resumeToken: approval.resumeToken,
        decisions: approval.approvals.map((item) => ({
          index: item.index,
          approved: false,
          rejectionMessage: '用户取消了本次照片使用和 AI 生成。',
        })),
        permissions: {
          allowVisualAnalysis: false,
          allowAiImageGeneration: false,
          allowPhotoUseForTryOn: false,
          allowPersistentMemory: false,
        },
      });
      applyAgentResult(result);
    } catch {
      addMessage({ role: 'assistant', text: '好的，我不会使用照片生成上身预览。我们继续用文字和真实单品图来调整。' });
    }
  };

  const selectRecommendationScope = (scope: RecommendationScope) => {
    const option = recommendationScopeOptions.find((item) => item.id === scope) ?? recommendationScopeOptions[0];
    const nextMemoryScope = stylingProfile.preferenceMemoryScope ?? 'turn';
    setStylingProfile((current) => ({
      ...current,
      recommendationScope: option.id,
      presentationPreference: option.presentationPreference,
      presentationOpenness: option.openness,
      preferenceMemoryScope: nextMemoryScope,
      source: nextMemoryScope === 'persistent' ? 'explicit_user' : 'session_override',
    }));
    setPendingStylingOverride((current) => ({
      ...current,
      recommendationScope: option.id,
      presentationPreference: option.presentationPreference,
      presentationOpenness: option.openness,
      preferenceMemoryScope: nextMemoryScope,
      scope: nextMemoryScope,
    }));
    setPendingPreferenceUiEvents((current) => [
      ...current,
      {
        type: 'set_recommendation_scope',
        scope: option.id,
        persistence: uiPersistenceForScope(nextMemoryScope),
      },
    ]);
  };

  const selectExpressionIntensity = (intensity: ExpressionIntensity) => {
    const nextMemoryScope = stylingProfile.preferenceMemoryScope ?? 'turn';
    setStylingProfile((current) => ({
      ...current,
      expressionIntensity: intensity,
      preferenceMemoryScope: nextMemoryScope,
      source: nextMemoryScope === 'persistent' ? 'explicit_user' : 'session_override',
    }));
    setPendingStylingOverride((current) => ({
      ...current,
      expressionIntensity: intensity,
      preferenceMemoryScope: nextMemoryScope,
      scope: nextMemoryScope,
    }));
    setPendingPreferenceUiEvents((current) => [
      ...current,
      {
        type: 'set_expression_intensity',
        intensity,
        persistence: uiPersistenceForScope(nextMemoryScope),
      },
    ]);
  };

  const selectMemoryScope = (scope: PreferenceMemoryScope) => {
    setStylingProfile((current) => ({
      ...current,
      preferenceMemoryScope: scope,
      source: scope === 'persistent' ? 'explicit_user' : current.source === 'unknown' ? 'session_override' : current.source,
    }));
    setPendingStylingOverride((current) => ({
      ...current,
      preferenceMemoryScope: scope,
      scope,
    }));
  };

  const submitUserMessage = async (
    message: string,
    source: MessageSource,
    traceId?: string,
  ): Promise<AgentTurnResult | undefined> => {
    const value = message.trim();
    if (!value) return;
    setAmbientCaptureEvent(undefined);
    if (pendingApproval) {
      const approvalReply = parsePendingApprovalReply(value);
      if (approvalReply === 'include' || approvalReply === 'conceal') {
        addMessage({ role: 'user', text: value });
        await approveTryOn(approvalReply);
        return undefined;
      }
      if (approvalReply === 'cancel') {
        addMessage({ role: 'user', text: value });
        await cancelTryOn();
        return undefined;
      }
      if (approvalReply === 'needs_face_choice') {
        addMessage({ role: 'user', text: value });
        addMessage({ role: 'assistant', text: '可以继续，但我还需要你选一下：带脸生成，还是不露脸只看穿搭？你也可以直接点下面的按钮。' });
        return undefined;
      }
    }
    return sendAgentMessage(value, source, traceId);
  };

  const submitMessage = (event: FormEvent) => {
    event.preventDefault();
    const value = draft.trim();
    if (!value) return;
    setDraft('');
    void submitUserMessage(value, 'text');
  };

  const voice = useVoiceSession({
    submitMessage: (message, traceId) => submitUserMessage(message, 'voice', traceId),
  });

  const visualTabs = useMemo(() => [
    { id: 'live' as const, label: '实时镜子' },
    ...(stageArtifact ? [{
      id: stageArtifact.kind === 'image'
        ? 'agent-image' as const
        : stageArtifact.kind === 'look_board'
          ? 'agent-look-board' as const
          : 'agent-items' as const,
      label: stageArtifact.kind === 'items'
        ? '真实图卡'
        : '视觉结果',
    }] : []),
  ], [stageArtifact]);

  const renderVisual = () => {
    if ((visualMode === 'agent-image' || visualMode === 'agent-items' || visualMode === 'agent-look-board') && stageArtifact) {
      return (
        <AgentArtifactStage
          stage={stageArtifact}
          visualHistory={visualHistory}
          compareVisual={compareVisual}
          onCompare={() => setCompareVisual((value) => !value)}
          onRestore={() => { void submitUserMessage('还是上一版好，帮我恢复上一版视觉结果', 'text'); }}
          onEdit={() => setDraft('把当前视觉版本里的外套换成黑色')}
          onSelect={(artifact) => {
            setStageArtifact({ kind: 'image', artifact });
            setVisualMode('agent-image');
            setCompareVisual(false);
          }}
        />
      );
    }
    return (
      <div className="camera-surface">
        <video ref={bindVideoRef} muted playsInline className={mirror ? 'mirrored' : ''} />
        {(cameraState === 'idle' || cameraState === 'requesting') && <CameraPermissionCard onStart={startCamera} loading={cameraState === 'requesting'} />}
        {cameraState === 'error' && (
            <div className="permission-card error-card">
              <div className="permission-icon"><Icon name="camera" size={24} /></div>
              <h2>暂时无法打开摄像头</h2>
              <p>请检查浏览器权限；你也可以继续用文字和真实衣柜图卡对话。</p>
              <button className="button button-dark" onClick={startCamera}>重新尝试</button>
            </div>
        )}
        {cameraState === 'paused' && <div className="paused-overlay"><Icon name="pause" /><span>镜子已暂停</span></div>}
        {cameraState === 'active' && <div className="live-badge"><span /> LIVE · 本地预览 / 低频分析</div>}
      </div>
    );
  };

  const consentReason =
    pendingApproval?.approvals[0]?.reason ??
    '默认不长期保存原图。预览不代表真实尺码、面料垂坠或剪裁。';

  const developmentSituationResult = useMemo(() => {
    if (!import.meta.env.DEV || !developmentSituationScenarioId) return undefined;
    const scenario = getMirrorSituationScenario(developmentSituationScenarioId);
    return scenario ? runMirrorSituationScenario(scenario) : undefined;
  }, [developmentSituationScenarioId]);

  const mirrorScreenState = useMemo(
    () => deriveMirrorScreenState({
      messages,
      activeAssistantId: streamingAssistantId,
      responding,
      generating,
      liveActivity,
      hasPendingApproval: Boolean(pendingApproval),
      voice: {
        enabled: voice.enabled,
        state: voice.state,
        partialTranscript: voice.partialTranscript,
        error: voice.lastError,
      },
      agentStatusLabel,
      perceptionLabel: perceptionLabel(cameraState, perception),
      situationDecision: developmentSituationResult?.decision,
      ambientCaptureEvent,
      ambientCaptureStatus: ambientCaptureOutcome?.status,
    }),
    [
      agentStatusLabel,
      cameraState,
      generating,
      liveActivity,
      messages,
      pendingApproval,
      perception,
      responding,
      streamingAssistantId,
      voice.enabled,
      voice.lastError,
      voice.partialTranscript,
      voice.state,
      developmentSituationResult,
      ambientCaptureEvent,
      ambientCaptureOutcome?.status,
    ],
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">M</span>
          <div><strong>Muse Mirror</strong><span>AI FASHION MIRROR</span></div>
        </div>
        <div className="topbar-context">
          <button className="context-chip chip-button" type="button" onClick={() => setShowHistoryPanel(true)}>历史</button>
          <button className="context-chip chip-button" type="button" onClick={() => { setShowMemoryPanel(true); void refreshMemoryState(); }}>记忆</button>
          <button className={`context-chip chip-button ${temporaryChat ? 'is-active' : ''}`} type="button" onClick={startTemporaryConversation}>临时</button>
          <span className="context-chip"><Icon name="sun" size={15} />18°C · 晴</span>
          <span className={`camera-status ${cameraState === 'active' ? 'is-active' : ''}`}><i />{perceptionLabel(cameraState, perception)}</span>
        </div>
      </header>

      {import.meta.env.DEV && (
        <MirrorSituationSimulator
          scenarios={MIRROR_SITUATION_SCENARIOS}
          selectedScenarioId={developmentSituationScenarioId}
          result={developmentSituationResult}
          onSelect={setDevelopmentSituationScenarioId}
        />
      )}

      {showHistoryPanel && (
        <HistoryPanel
          conversations={conversations}
          currentId={conversationId}
          onClose={() => setShowHistoryPanel(false)}
          onNew={() => { void startNewConversation(); }}
          onTemporary={startTemporaryConversation}
          onLoad={(conversation) => { void loadConversation(conversation); }}
          onDelete={(conversation, action) => { void deleteConversationFromUi(conversation, action); }}
        />
      )}
      {showMemoryPanel && (
        <MemoryPanel
          memories={memories}
          candidates={memoryCandidates}
          policy={memoryPolicy}
          onPolicyChange={setMemoryPolicy}
          onClose={() => setShowMemoryPanel(false)}
          onPause={(memory, paused) => { void pauseMemoryFromUi(memory, paused); }}
          onDelete={(memory) => { void deleteMemoryFromUi(memory); }}
          onConfirm={(candidate) => { void confirmMemoryCandidateFromUi(candidate); }}
          onDismiss={(candidate) => { void dismissMemoryCandidateFromUi(candidate); }}
        />
      )}

      <MirrorWorkspace
        mirror={(
          <section className="mirror-panel" aria-label="实时镜子与视觉结果">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">LIVE MIRROR</span>
                <h1>先看看现在的画面。</h1>
              </div>
              <div className="visual-tabs" role="tablist" aria-label="视觉模式">
                {visualTabs.map((tab) => (
                  <button
                    key={tab.id}
                    role="tab"
                    aria-selected={visualMode === tab.id}
                    className={visualMode === tab.id ? 'active' : ''}
                    onClick={() => setVisualMode(tab.id)}
                  >{tab.label}</button>
                ))}
              </div>
            </div>

            <div className={`visual-stage ${generating ? 'is-generating' : ''}`}>
              {renderVisual()}
              {generating && (
                <div className="generation-overlay">
                  <div className="generation-orbit"><Icon name="sparkle" size={22} /></div>
                  <strong>正在生成新的视觉预览</strong>
                  <span>保留姿态与比例，只调整服装</span>
                </div>
              )}
            </div>

            <div className="mirror-footer">
              <div className="camera-controls">
                <button className="round-control" onClick={togglePause} disabled={!streamRef.current} aria-label={cameraState === 'paused' ? '继续摄像头' : '暂停摄像头'}>
                  <Icon name={cameraState === 'paused' ? 'play' : 'pause'} />
                </button>
                <div className="capture-status" aria-live="polite" aria-label="拍照分析状态">
                  <span><Icon name="camera" size={18} /></span>
                  {captureStatusText(cameraState, perception)}
                </div>
                <button className="round-control" onClick={() => setMirror((value) => !value)} aria-label="切换镜像">
                  <Icon name="flip" />
                </button>
                <button
                  className={`ambient-capture-toggle ${ambientCaptureEnabled ? 'is-active' : ''}`}
                  type="button"
                  aria-pressed={ambientCaptureEnabled}
                  onClick={toggleAmbientCapture}
                  title="自动记录单人稳定画面中穿着的衣物"
                >
                  <i />
                  {ambientCaptureEnabled ? '自动记录已开启' : '开启自动记录'}
                </button>
              </div>
              <p><Icon name="check" size={14} />本地镜子和小助手视觉状态分开显示</p>
            </div>
            {showAmbientGrantPrompt && !ambientCaptureEnabled && (
              <section className="ambient-capture-consent" role="dialog" aria-labelledby="ambient-capture-consent-title">
                <div>
                  <span>一次性授权</span>
                  <strong id="ambient-capture-consent-title">自动记录我穿着的衣物</strong>
                  <p>
                    仅在单人、稳定且能看清整套穿着时分析。Muse 会保存用于复认的选定画面证据，
                    不保存连续视频；手持衣物、多人画面和不可靠结果不会写入衣橱。
                  </p>
                </div>
                <div className="ambient-capture-consent-actions">
                  <button type="button" className="primary-action" onClick={() => { void enableAmbientCapture(); }}>同意并开启</button>
                  <button type="button" onClick={() => setShowAmbientGrantPrompt(false)}>暂不开启</button>
                </div>
              </section>
            )}
            {(import.meta.env.DEV || new URLSearchParams(window.location.search).has('ambientDebug')) && (
              <details className="ambient-capture-debug">
                <summary>Ambient capture diagnostics</summary>
                <code>
                  grant={String(ambientCaptureEnabled)} · items={ambientCaptureCounts.closet} · captures={ambientCaptureCounts.captures} · outcome={ambientCaptureOutcome?.status ?? 'none'}
                </code>
                <button type="button" onClick={() => { void resetAmbientCaptureFromUi(); }}>Reset my ambient wardrobe</button>
              </details>
            )}
          </section>
        )}
        canvas={(
          <MirrorAgentCanvas
            state={mirrorScreenState}
            approval={mirrorScreenState.showApproval && pendingApproval ? (
              <ConsentCard
                busy={generating}
                reason={consentReason}
                onApprove={(faceMode) => { void approveTryOn(faceMode); }}
                onCancel={() => { void cancelTryOn(); }}
              />
            ) : undefined}
            composer={(
              <div className="agent-composer-area">
                <form className="composer" onSubmit={submitMessage}>
                  <button type="button" className="composer-icon" aria-label="上传图片"><Icon name="image" size={19} /></button>
                  <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="跟 Muse 说点什么..." aria-label="输入消息" />
                  <button
                    type="button"
                    className={`voice-button ${voice.enabled ? 'is-active' : ''} voice-${voice.state}`}
                    aria-label={voice.enabled ? '停止或关闭语音模式' : '开启语音模式'}
                    aria-pressed={voice.enabled}
                    title={voice.available ? mirrorVoiceStatusLabel(voice.state) : '语音服务尚未配置'}
                    onClick={voice.toggle}
                  >
                    <Icon name="mic" size={18} />
                  </button>
                  <button className="send-button" type="submit" aria-label="发送消息"><Icon name="send" size={18} /></button>
                </form>
                <span className="voice-privacy">摄像头帧会按需发送给视觉模型；麦克风只在语音模式开启时使用，音频会发送给语音识别服务，Muse 服务不持久化原始音频。</span>
                <span className={`mock-note transport-${transport}`}>{statusNote}</span>
              </div>
            )}
          />
        )}
        conversation={(
          <ConversationDrawer
            id="complete-conversation"
            expanded={conversationExpanded}
            messageCount={messages.length}
            onToggle={() => setConversationExpanded((value) => !value)}
          >
            <div className="conversation-date">今天</div>
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                onSelectRecommendationScope={selectRecommendationScope}
                onSelectExpressionIntensity={selectExpressionIntensity}
                onSelectMemoryScope={selectMemoryScope}
                onOpenMemory={() => {
                  setShowMemoryPanel(true);
                  void refreshMemoryState();
                }}
              />
            ))}
            <div ref={messageEndRef} />
          </ConversationDrawer>
        )}
      />
    </div>
  );
}

export default App;

import type { ReactNode } from 'react';
import type {
  MirrorScreenState,
  MirrorVoicePresentation,
} from './mirrorScreenTypes';

interface MirrorAgentCanvasProps {
  state: MirrorScreenState;
  approval?: ReactNode;
  composer: ReactNode;
  onBackfillProductImages?: () => void;
}

function needsFullConversationHint(text?: string): boolean {
  if (!text) return false;
  return text.length > 180 || text.split('\n').length > 6;
}

function closetCategoryLabel(category: string): string {
  return ({
    top: '上衣',
    bottom: '下装',
    dress: '连衣装',
    jumpsuit: '连体装',
    outerwear: '外套',
    shoes: '鞋',
    bag: '包',
    accessory: '配饰',
  } as Record<string, string>)[category] ?? category;
}

function MirrorVoiceDock({ voice }: { voice: MirrorVoicePresentation }) {
  if (!voice.enabled && !voice.partialTranscript && !voice.error) return null;
  return (
    <div className={`voice-session voice-${voice.state}`} aria-live="polite">
      <span className="voice-session-dot" />
      <div>
        <strong>{voice.statusLabel}</strong>
        {voice.partialTranscript && <span>{voice.partialTranscript}</span>}
        {!voice.partialTranscript && voice.error && <span>{voice.error}</span>}
      </div>
    </div>
  );
}

export function MirrorAgentCanvas({
  state,
  approval,
  composer,
  onBackfillProductImages,
}: MirrorAgentCanvasProps) {
  const { caption } = state;
  const showFullConversationHint = needsFullConversationHint(caption.museText);
  const ariaLive = state.phase === 'speaking' || state.isActiveTurn ? 'off' : 'polite';
  const ambientProductImages = state.ambientClosetItems
    .filter((entry) => entry.item.imageStatus === 'ready' && entry.item.imageUrl)
    .slice(-6)
    .reverse();

  return (
    <aside
      className={`mirror-agent-canvas phase-${state.phase} content-${state.contentKind}`}
      data-phase={state.phase}
      data-content-kind={state.contentKind}
      aria-label="镜面 Agent 主屏"
    >
      <header className="mirror-canvas-header">
        <div className="mirror-canvas-identity">
          <div className="agent-avatar large">M</div>
          <div>
            <strong>Muse Mirror</strong>
            <span><i />{state.ambient.agentStatusLabel}</span>
          </div>
        </div>
        <span className="mirror-canvas-perception">{state.ambient.perceptionLabel}</span>
      </header>

      <div className="mirror-canvas-body">
        <div className="mirror-canvas-current">
          {caption.latestUserText && (
            <section className="mirror-canvas-user" aria-label="你刚刚说">
              <span className="eyebrow">YOU</span>
              <p>{caption.latestUserText}</p>
            </section>
          )}

          <section
            className="mirror-canvas-muse"
            aria-label="Muse 当前回答"
            aria-live={ariaLive}
            aria-atomic="true"
          >
            <span className="eyebrow">MUSE</span>
            {caption.activityLabel && state.phase === 'thinking' && (
              <span className="mirror-canvas-progress"><i />{caption.activityLabel}</span>
            )}
            {caption.showTyping && !caption.museText ? (
              <div className="mirror-canvas-typing" aria-label="Muse 正在回复">
                <span /><span /><span />
              </div>
            ) : caption.museText ? (
              <p>{caption.museText}</p>
            ) : null}
            {showFullConversationHint && <small>完整内容见下方对话</small>}
          </section>

          {state.primaryArtifact && (
            <div className="mirror-canvas-artifact" aria-label="当前视觉结果">
              <span>已更新左侧视觉区</span>
              <strong>{state.primaryArtifact.summary}</strong>
            </div>
          )}

          {state.situationDecision &&
            state.situationDecision.presentation.visibility !== 'hidden' && (
              <section
                className={`mirror-situation-hint tone-${state.situationDecision.presentation.tone}`}
                aria-label="镜前情境策略提示"
                data-situation-action={state.situationDecision.action}
              >
                <span>{state.situationDecision.presentation.title}</span>
                <p>{state.situationDecision.presentation.detail}</p>
              </section>
            )}

          {state.ambientCaptureEvent && (
            <section className="ambient-capture-complete" aria-label="自动穿搭记录完成">
              <span className="eyebrow">WARDROBE</span>
              <strong>
                {state.ambientCaptureEvent.repeatedOutfit
                  ? '✓ 这套我已经认识了'
                  : state.ambientCaptureEvent.newItemIds.length
                    ? '✓ 今天这套我记下了'
                    : '✓ 已记录今天的穿着'}
              </strong>
              <p className="ambient-capture-summary">
                {state.ambientCaptureEvent.repeatedOutfit
                  ? '已记录今天的穿着'
                  : [
                      state.ambientCaptureEvent.newItemIds.length
                        ? `新加入 ${state.ambientCaptureEvent.newItemIds.length} 件`
                        : undefined,
                      state.ambientCaptureEvent.recognizedItemIds.length
                        ? `已识别 ${state.ambientCaptureEvent.recognizedItemIds.length} 件`
                        : undefined,
                    ].filter(Boolean).join(' · ')}
              </p>
              <div className="ambient-capture-items">
                {state.ambientCaptureEvent.itemSummaries.filter((item) => item.imageStatus === 'ready' && item.imageUrl).map((item) => (
                  <span className="ambient-capture-item" key={`${state.ambientCaptureEvent?.captureId}_${item.closetItemId}`}>
                    <img src={item.imageUrl} alt="" />
                    <i className={item.status === 'new' ? 'is-new' : 'is-known'} />
                    <b>{item.label}</b>
                    <small>{item.status === 'new' ? '新加入' : '已识别'}</small>
                  </span>
                ))}
              </div>
              {state.ambientCaptureEvent.newItemIds.length > 0 && (
                <p className="ambient-capture-footnote">之后推荐时会一起考虑</p>
              )}
            </section>
          )}

          {!state.ambientCaptureEvent && state.ambientCaptureStatus === 'committed_processing_images' && (
            <section className="ambient-capture-complete is-processing" aria-label="正在整理衣橱图片" aria-live="polite">
              <span className="eyebrow">WARDROBE</span>
              <strong>正在整理衣橱图片</strong>
              <p className="ambient-capture-summary">穿着记录已经保存，验证后的单品图准备好后会在这里出现。</p>
            </section>
          )}

          {!state.ambientCaptureEvent && state.ambientCaptureStatus === 'image_needs_review' && (
            <section className="ambient-capture-complete is-limited" aria-label="衣橱图片尚未完成">
              <span className="eyebrow">WARDROBE</span>
              <strong>今日穿搭已记录</strong>
              <p className="ambient-capture-summary">衣橱图片还需要整理；未通过校验的图片不会展示。</p>
              {state.ambientProductImageProviderReady && onBackfillProductImages && (
                <button
                  className="ambient-product-action"
                  type="button"
                  disabled={state.ambientProductImageBackfillPending}
                  onClick={onBackfillProductImages}
                >
                  {state.ambientProductImageBackfillPending ? '正在逐件生成…' : '生成衣橱单品图'}
                </button>
              )}
            </section>
          )}

          {ambientProductImages.length > 0 && (
            <section className="ambient-product-gallery" aria-label="已整理的衣橱单品图">
              <div className="ambient-product-gallery-heading">
                <span className="eyebrow">MY WARDROBE</span>
                <strong>镜头录入的衣橱单品</strong>
                <small>AI 基于实拍整理 · 通过视觉检查</small>
              </div>
              <div className="ambient-product-grid">
                {ambientProductImages.map((entry) => (
                  <article key={entry.item.id} className="ambient-product-card">
                    <img src={entry.item.imageUrl} alt={entry.item.name} />
                    <div>
                      <span>AI 整理图</span>
                      <strong>{entry.item.name}</strong>
                      <small>{entry.item.color} · {closetCategoryLabel(entry.item.category)}</small>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          {state.showApproval && approval && (
            <div className="mirror-canvas-approval">{approval}</div>
          )}
        </div>
      </div>

      <footer className="mirror-canvas-dock">
        <MirrorVoiceDock voice={state.voice} />
        {composer}
      </footer>
    </aside>
  );
}

import type { ReactNode } from 'react';
import type {
  MirrorScreenState,
  MirrorVoicePresentation,
} from './mirrorScreenTypes';

interface MirrorAgentCanvasProps {
  state: MirrorScreenState;
  approval?: ReactNode;
  composer: ReactNode;
}

function needsFullConversationHint(text?: string): boolean {
  if (!text) return false;
  return text.length > 180 || text.split('\n').length > 6;
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

function wardrobeItemStatus(
  status: 'new' | 'recognized' | 'pending',
  imageState: 'processing' | 'ready' | 'fallback' | 'pending',
): string {
  if (status === 'pending') return '还在确认';
  if (status === 'recognized') return '✓ 衣橱已有';
  if (imageState === 'processing') return 'NEW · 正在整理…';
  return 'NEW · 已加入';
}

export function MirrorAgentCanvas({
  state,
  approval,
  composer,
}: MirrorAgentCanvasProps) {
  const { caption } = state;
  const showFullConversationHint = needsFullConversationHint(caption.museText);
  const ariaLive = state.phase === 'speaking' || state.isActiveTurn ? 'off' : 'polite';
  const showMuseCaption = Boolean(
    caption.activityLabel || caption.showTyping || caption.museText,
  );

  return (
    <aside
      className={`mirror-agent-canvas phase-${state.phase} content-${state.contentKind}`}
      data-phase={state.phase}
      data-content-kind={state.contentKind}
      data-screen-owner={state.screenOwner}
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

          {showMuseCaption && (
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
          )}

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

          {state.wardrobeMoment && (
            <section
              className="wardrobe-moment"
              aria-label="衣橱刚刚更新"
              aria-live="polite"
              data-capture-id={state.wardrobeMoment.captureId}
            >
              <div className="wardrobe-moment-heading">
                <span className="eyebrow">MUSE WARDROBE</span>
                <h2>{state.wardrobeMoment.headline}</h2>
                <p>{state.wardrobeMoment.summary}</p>
              </div>
              <div
                className={`wardrobe-moment-grid items-${Math.min(state.wardrobeMoment.items.length, 3)}`}
              >
                {state.wardrobeMoment.items.map((item) => (
                  <article
                    className={`wardrobe-moment-card status-${item.status} image-${item.imageState}`}
                    key={item.id}
                  >
                    <div className="wardrobe-moment-image">
                      {item.imageUrl ? (
                        <img src={item.imageUrl} alt={item.label} />
                      ) : (
                        <div className="wardrobe-moment-placeholder" aria-hidden="true">
                          <i />
                        </div>
                      )}
                    </div>
                    <div className="wardrobe-moment-item-copy">
                      <strong>{item.label}</strong>
                      <span>{wardrobeItemStatus(item.status, item.imageState)}</span>
                    </div>
                  </article>
                ))}
              </div>
              {state.wardrobeMoment.supportingText && (
                <p className="wardrobe-moment-support">{state.wardrobeMoment.supportingText}</p>
              )}
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

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

export function MirrorAgentCanvas({
  state,
  approval,
  composer,
}: MirrorAgentCanvasProps) {
  const { caption } = state;
  const showFullConversationHint = needsFullConversationHint(caption.museText);
  const ariaLive = state.phase === 'speaking' || state.isActiveTurn ? 'off' : 'polite';

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

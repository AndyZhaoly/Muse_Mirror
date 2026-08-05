import type { ReactNode } from 'react';
import {
  toCanvasPlainText,
  type CurrentCanvasContent,
} from './mirrorCanvasContent';

interface MirrorAgentCanvasProps extends CurrentCanvasContent {
  agentStatusLabel: string;
  perceptionLabel: string;
  assistantIsActive: boolean;
  currentActivityLabel?: string;
  latestArtifactSummary?: string;
  approval?: ReactNode;
  voiceDock?: ReactNode;
  composer: ReactNode;
}

function needsFullConversationHint(text?: string): boolean {
  if (!text) return false;
  return text.length > 180 || text.split('\n').length > 6;
}

export function MirrorAgentCanvas({
  agentStatusLabel,
  perceptionLabel,
  latestUserText,
  latestAssistantText,
  latestAssistantCommentary,
  assistantIsTyping,
  assistantIsActive,
  currentActivityLabel,
  latestArtifactSummary,
  approval,
  voiceDock,
  composer,
}: MirrorAgentCanvasProps) {
  const museCaption = toCanvasPlainText(latestAssistantCommentary ?? latestAssistantText);
  const userCaption = toCanvasPlainText(latestUserText);
  const showFullConversationHint = needsFullConversationHint(museCaption);

  return (
    <aside className="mirror-agent-canvas" aria-label="镜面 Agent 主屏">
      <header className="mirror-canvas-header">
        <div className="mirror-canvas-identity">
          <div className="agent-avatar large">M</div>
          <div>
            <strong>Muse Mirror</strong>
            <span><i />{agentStatusLabel}</span>
          </div>
        </div>
        <span className="mirror-canvas-perception">{perceptionLabel}</span>
      </header>

      <div className="mirror-canvas-body">
        <div className="mirror-canvas-current">
          {userCaption && (
            <section className="mirror-canvas-user" aria-label="你刚刚说">
              <span className="eyebrow">YOU</span>
              <p>{userCaption}</p>
            </section>
          )}

          <section
            className="mirror-canvas-muse"
            aria-label="Muse 当前回答"
            aria-live={assistantIsActive ? 'off' : 'polite'}
            aria-atomic="true"
          >
            <span className="eyebrow">MUSE</span>
            {currentActivityLabel && assistantIsActive && (
              <span className="mirror-canvas-progress"><i />{currentActivityLabel}</span>
            )}
            {assistantIsTyping && !museCaption ? (
              <div className="mirror-canvas-typing" aria-label="Muse 正在回复">
                <span /><span /><span />
              </div>
            ) : (
              <p>{museCaption ?? '你好。需要时，我可以看镜子、查衣柜或生成视觉参考。'}</p>
            )}
            {showFullConversationHint && (
              <small>完整内容见下方对话</small>
            )}
          </section>

          {latestArtifactSummary && (
            <div className="mirror-canvas-artifact" aria-label="最近视觉结果">
              <span>已更新左侧视觉区</span>
              <strong>{latestArtifactSummary}</strong>
            </div>
          )}

          {approval && <div className="mirror-canvas-approval">{approval}</div>}
        </div>
      </div>

      <footer className="mirror-canvas-dock">
        {voiceDock}
        {composer}
      </footer>
    </aside>
  );
}

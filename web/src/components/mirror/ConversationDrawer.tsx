import type { ReactNode } from 'react';

interface ConversationDrawerProps {
  id: string;
  expanded: boolean;
  messageCount: number;
  onToggle: () => void;
  children: ReactNode;
}

export function ConversationDrawer({
  id,
  expanded,
  messageCount,
  onToggle,
  children,
}: ConversationDrawerProps) {
  return (
    <section className={`conversation-drawer ${expanded ? 'is-expanded' : ''}`} aria-label="完整对话">
      <button
        type="button"
        className="conversation-drawer-toggle"
        aria-expanded={expanded}
        aria-controls={id}
        onClick={onToggle}
      >
        <span>
          <small>CONVERSATION</small>
          <strong>{expanded ? '收起完整对话' : '查看完整对话'}</strong>
        </span>
        <span className="conversation-drawer-count">{messageCount} 条</span>
        <i aria-hidden="true" />
      </button>

      <div
        id={id}
        className="conversation-drawer-region"
        role="region"
        aria-label="当前会话的完整消息与处理细节"
        hidden={!expanded}
      >
        <div className="conversation-drawer-scroll">
          {children}
        </div>
      </div>
    </section>
  );
}

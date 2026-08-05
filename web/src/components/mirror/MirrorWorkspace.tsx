import type { ReactNode } from 'react';

interface MirrorWorkspaceProps {
  mirror: ReactNode;
  canvas: ReactNode;
  conversation: ReactNode;
}

export function MirrorWorkspace({
  mirror,
  canvas,
  conversation,
}: MirrorWorkspaceProps) {
  return (
    <main className="mirror-experience">
      <div className="mirror-workspace-grid">
        {mirror}
        {canvas}
      </div>
      {conversation}
    </main>
  );
}

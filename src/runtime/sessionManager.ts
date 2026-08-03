import { MemorySession } from '@openai/agents';

export class AgentSessionManager {
  private readonly sessions = new Map<string, MemorySession>();

  get(sessionId: string): MemorySession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = new MemorySession({ sessionId });
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  async clear(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) await session.clearSession();
    this.sessions.delete(sessionId);
  }
}

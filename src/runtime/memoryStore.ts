import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ContextOverride,
  Conversation,
  ConversationMessage,
  ExplicitPreferenceEvent,
  MemoryAuditEvent,
  MemoryPolicy,
  MemorySource,
  MemoryUsageDisclosure,
  MusePersonalizationContext,
  UserMemory,
} from '../types.js';
import { makeId } from '../utils/ids.js';

interface MemoryStoreData {
  conversations: Conversation[];
  messages: ConversationMessage[];
  contextOverrides: ContextOverride[];
  preferenceEvents: ExplicitPreferenceEvent[];
  memories: UserMemory[];
  auditEvents: MemoryAuditEvent[];
}

const emptyData = (): MemoryStoreData => ({
  conversations: [],
  messages: [],
  contextOverrides: [],
  preferenceEvents: [],
  memories: [],
  auditEvents: [],
});

export class JsonMuseMemoryStore {
  private data?: MemoryStoreData;

  constructor(private readonly filePath: string) {}

  async ensureConversation(args: {
    userId: string;
    conversationId?: string;
    title?: string;
    temporary?: boolean;
  }): Promise<Conversation> {
    const data = await this.read();
    const now = new Date().toISOString();
    const existing = args.conversationId
      ? data.conversations.find((item) => item.id === args.conversationId && item.userId === args.userId)
      : undefined;
    if (existing) return existing;
    const conversation: Conversation = {
      id: args.conversationId && args.conversationId.trim()
        ? args.conversationId
        : makeId(args.temporary ? 'temp_conversation' : 'conversation'),
      userId: args.userId,
      title: args.title?.trim() || '新的对话',
      status: args.temporary ? 'temporary' : 'active',
      temporary: args.temporary,
      createdAt: now,
      updatedAt: now,
    };
    if (!args.temporary) {
      data.conversations.unshift(conversation);
      await this.write(data);
    }
    return conversation;
  }

  async listConversations(userId: string, args?: { includeArchived?: boolean; query?: string }): Promise<Conversation[]> {
    const data = await this.read();
    const query = args?.query?.trim().toLowerCase();
    return data.conversations
      .filter((item) => item.userId === userId)
      .filter((item) => item.status !== 'deleted' && item.status !== 'temporary')
      .filter((item) => args?.includeArchived || item.status !== 'archived')
      .filter((item) => !query || item.title.toLowerCase().includes(query) || this.messagesFor(data, item.id, userId).some((message) => {
        const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
        return content.toLowerCase().includes(query);
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getMessages(userId: string, conversationId: string): Promise<ConversationMessage[]> {
    const data = await this.read();
    return this.messagesFor(data, conversationId, userId);
  }

  async appendMessage(args: {
    userId: string;
    conversationId: string;
    role: ConversationMessage['role'];
    content: unknown;
    id?: string;
    nowIso?: string;
    temporary?: boolean;
  }): Promise<ConversationMessage> {
    const now = args.nowIso ?? new Date().toISOString();
    const message: ConversationMessage = {
      id: args.id ?? makeId('message'),
      conversationId: args.conversationId,
      userId: args.userId,
      role: args.role,
      content: args.content,
      createdAt: now,
    };
    if (args.temporary) return message;
    const data = await this.read();
    data.messages.push(message);
    const conversation = data.conversations.find((item) => item.id === args.conversationId && item.userId === args.userId);
    if (conversation) {
      if (conversation.title === '新的对话' && args.role === 'user' && typeof args.content === 'string') {
        conversation.title = titleFromMessage(args.content);
      }
      conversation.updatedAt = now;
    }
    await this.write(data);
    return message;
  }

  async deleteConversation(args: {
    userId: string;
    conversationId: string;
    memoryAction: 'keep' | 'delete';
  }): Promise<{ deleted: boolean; affectedMemoryCount: number }> {
    const data = await this.read();
    const now = new Date().toISOString();
    const conversation = data.conversations.find((item) => item.id === args.conversationId && item.userId === args.userId);
    if (!conversation) return { deleted: false, affectedMemoryCount: 0 };
    const related = data.memories.filter((memory) =>
      memory.userId === args.userId &&
      memory.source.type === 'conversation' &&
      memory.source.conversationId === args.conversationId &&
      memory.status !== 'deleted'
    );
    if (args.memoryAction === 'delete') {
      for (const memory of related) {
        this.audit(data, args.userId, memory, 'deleted', 'user');
        memory.status = 'deleted';
        memory.updatedAt = now;
      }
    } else {
      for (const memory of related) {
        memory.source = { type: 'deleted_conversation', originalSourceDeletedAt: now };
        memory.updatedAt = now;
      }
    }
    conversation.status = 'deleted';
    conversation.updatedAt = now;
    data.messages = data.messages.filter((message) => message.conversationId !== args.conversationId || message.userId !== args.userId);
    data.contextOverrides = data.contextOverrides.filter((item) => item.conversationId !== args.conversationId || item.userId !== args.userId);
    data.preferenceEvents = data.preferenceEvents.filter((item) => item.conversationId !== args.conversationId || item.userId !== args.userId);
    await this.write(data);
    return { deleted: true, affectedMemoryCount: related.length };
  }

  async listMemories(userId: string, includeInactive = true): Promise<UserMemory[]> {
    const data = await this.read();
    this.expireMemories(data);
    await this.write(data);
    return data.memories
      .filter((item) => item.userId === userId)
      .filter((item) => includeInactive || item.status === 'active')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createMemory(args: {
    userId: string;
    memory: Omit<UserMemory, 'id' | 'createdAt' | 'updatedAt' | 'status'> & { status?: UserMemory['status'] };
    actor: MemoryAuditEvent['actor'];
  }): Promise<UserMemory> {
    const data = await this.read();
    const now = new Date().toISOString();
    const memory: UserMemory = {
      ...args.memory,
      id: makeId('memory'),
      userId: args.userId,
      status: args.memory.status ?? 'active',
      createdAt: now,
      updatedAt: now,
    };
    if (memory.status === 'active') {
      for (const existing of data.memories.filter((item) => shouldSupersede(item, memory))) {
        existing.status = 'superseded';
        existing.updatedAt = now;
        this.audit(data, args.userId, existing, 'superseded', 'system');
        memory.supersedesMemoryId = existing.id;
      }
    }
    data.memories.push(memory);
    this.audit(data, args.userId, memory, 'created', args.actor);
    await this.write(data);
    return memory;
  }

  async updateMemory(
    userId: string,
    memoryId: string,
    patch: Partial<Pick<UserMemory, 'value' | 'applicability' | 'validUntil' | 'validFrom' | 'status'>>,
    actor: MemoryAuditEvent['actor'] = 'user',
  ): Promise<UserMemory | undefined> {
    const data = await this.read();
    const memory = data.memories.find((item) => item.id === memoryId && item.userId === userId);
    if (!memory) return undefined;
    this.audit(data, userId, memory, patch.status === 'deleted' ? 'deleted' : 'updated', actor);
    Object.assign(memory, patch, { updatedAt: new Date().toISOString() });
    await this.write(data);
    return memory;
  }

  async listPreferenceEvents(userId: string, status?: ExplicitPreferenceEvent['status']): Promise<ExplicitPreferenceEvent[]> {
    const data = await this.read();
    return data.preferenceEvents
      .filter((item) => item.userId === userId)
      .filter((item) => !status || item.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async addPreferenceEvents(events: ExplicitPreferenceEvent[]): Promise<void> {
    if (!events.length) return;
    const data = await this.read();
    const existing = new Set(data.preferenceEvents.map((item) => item.id));
    data.preferenceEvents.push(...events.filter((event) => !existing.has(event.id)));
    await this.write(data);
  }

  async updatePreferenceEvent(
    userId: string,
    eventId: string,
    status: ExplicitPreferenceEvent['status'],
  ): Promise<ExplicitPreferenceEvent | undefined> {
    const data = await this.read();
    const event = data.preferenceEvents.find((item) => item.id === eventId && item.userId === userId);
    if (!event) return undefined;
    event.status = status;
    await this.write(data);
    return event;
  }

  async addContextOverrides(overrides: Array<Omit<ContextOverride, 'id' | 'createdAt' | 'updatedAt'>>): Promise<ContextOverride[]> {
    if (!overrides.length) return [];
    const data = await this.read();
    const now = new Date().toISOString();
    const created = overrides.map((override): ContextOverride => ({
      ...override,
      id: makeId('override'),
      createdAt: now,
      updatedAt: now,
    }));
    data.contextOverrides.push(...created);
    await this.write(data);
    return created;
  }

  async listContextOverrides(userId: string, conversationId?: string): Promise<ContextOverride[]> {
    const data = await this.read();
    const now = Date.now();
    data.contextOverrides = data.contextOverrides.filter((override) => !override.validUntil || Date.parse(override.validUntil) > now);
    await this.write(data);
    return data.contextOverrides
      .filter((item) => item.userId === userId)
      .filter((item) => !conversationId || item.conversationId === conversationId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async deleteContextOverride(userId: string, overrideId: string): Promise<boolean> {
    const data = await this.read();
    const before = data.contextOverrides.length;
    data.contextOverrides = data.contextOverrides.filter((item) => !(item.id === overrideId && item.userId === userId));
    await this.write(data);
    return data.contextOverrides.length !== before;
  }

  async updateContextOverride(
    userId: string,
    overrideId: string,
    patch: Partial<Pick<ContextOverride, 'scope' | 'value' | 'validUntil' | 'validFrom'>>,
  ): Promise<ContextOverride | undefined> {
    const data = await this.read();
    const override = data.contextOverrides.find((item) => item.id === overrideId && item.userId === userId);
    if (!override) return undefined;
    Object.assign(override, patch, { updatedAt: new Date().toISOString() });
    await this.write(data);
    return override;
  }

  async buildPersonalizationContext(
    userId: string,
    conversationId: string,
    policy: MemoryPolicy,
  ): Promise<{
    context: MusePersonalizationContext;
    usage: MemoryUsageDisclosure[];
    overrides: ContextOverride[];
  }> {
    const overrides = await this.listContextOverrides(userId, conversationId);
    const memories = policy.usePersistentMemories ? await this.listMemories(userId, false) : [];
    const activeMemories = memories.filter((memory) => memory.status === 'active');
    const context: MusePersonalizationContext = {
      persistentMemories: activeMemories.map((memory) => ({
        type: memory.value.namespace,
        key: memory.value.key,
        value: memory.value,
        applicability: memory.applicability,
        authority: 'confirmed_persistent_memory',
      })),
      contextOverrides: overrides.map((override) => ({
        scope: override.scope,
        value: override.value,
        expiresAt: override.validUntil,
        authority: 'current_context_override',
      })),
      historicalContext: [],
    };
    return {
      context,
      usage: activeMemories.map((memory) => ({
        label: labelForMemory(memory),
        reason: '你曾要求 Muse 长期记住',
        editable: true,
      })),
      overrides,
    };
  }

  async close(): Promise<void> {
    if (this.data) await this.write(this.data);
  }

  private messagesFor(data: MemoryStoreData, conversationId: string, userId: string): ConversationMessage[] {
    return data.messages
      .filter((item) => item.conversationId === conversationId && item.userId === userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private async read(): Promise<MemoryStoreData> {
    if (this.data) return this.data;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<MemoryStoreData>;
      this.data = {
        conversations: Array.isArray(parsed.conversations) ? parsed.conversations : [],
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        contextOverrides: Array.isArray(parsed.contextOverrides) ? parsed.contextOverrides : [],
        preferenceEvents: Array.isArray(parsed.preferenceEvents) ? parsed.preferenceEvents : [],
        memories: Array.isArray(parsed.memories) ? parsed.memories : [],
        auditEvents: Array.isArray(parsed.auditEvents) ? parsed.auditEvents : [],
      };
    } catch {
      this.data = emptyData();
    }
    return this.data;
  }

  private async write(data: MemoryStoreData): Promise<void> {
    this.data = data;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  private expireMemories(data: MemoryStoreData): void {
    const now = Date.now();
    for (const memory of data.memories) {
      if (memory.status === 'active' && memory.validUntil && Date.parse(memory.validUntil) <= now) {
        this.audit(data, memory.userId, memory, 'expired', 'system');
        memory.status = 'expired';
        memory.updatedAt = new Date().toISOString();
      }
    }
  }

  private audit(
    data: MemoryStoreData,
    userId: string,
    memory: UserMemory,
    action: MemoryAuditEvent['action'],
    actor: MemoryAuditEvent['actor'],
  ): void {
    data.auditEvents.push({
      id: makeId('audit'),
      userId,
      memoryId: memory.id,
      action,
      actor,
      previousValueHash: stableHash(memory.value),
      createdAt: new Date().toISOString(),
    });
  }
}

export function defaultMemoryPolicy(): MemoryPolicy {
  return {
    usePersistentMemories: true,
    referencePastChats: false,
    allowExplicitMemoryWrites: true,
  };
}

export function memoryFromPreferenceEvent(event: ExplicitPreferenceEvent): Omit<UserMemory, 'id' | 'createdAt' | 'updatedAt' | 'status'> {
  return {
    userId: event.userId,
    value: event.intent.value,
    applicability: event.intent.applicability,
    explicitness: event.intent.memoryAuthorization === 'explicit' ? 'user_requested' : 'user_stated',
    authorization: event.intent.memoryAuthorization === 'explicit' ? 'explicit' : 'implicit_durable_statement',
    confidence: event.intent.confidence,
    validFrom: event.intent.temporalValidity?.startsAt,
    validUntil: event.intent.temporalValidity?.expiresAt,
    source: {
      type: 'conversation',
      conversationId: event.conversationId,
      messageId: event.messageId,
    },
  };
}

export function labelForMemory(memory: UserMemory): string {
  const value = memory.value;
  if (value.namespace === 'avoidance') return `不推荐：${value.values.join('、')}`;
  if (value.namespace === 'style_preference' && value.key === 'expression_intensity') return `表达强度：${value.values.join('、')}`;
  if (value.namespace === 'style_preference' && value.key === 'style_tone') return `风格偏好：${value.values.join('、')}`;
  if (value.namespace === 'style_preference' && value.key === 'recommendation_scope') return `推荐范围：${value.values.join('、')}`;
  if (value.namespace === 'fit_preference') return `合身偏好：${value.values.join('、')}`;
  return value.values.join('、');
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

function titleFromMessage(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, ' ');
  return trimmed.length > 18 ? `${trimmed.slice(0, 18)}...` : trimmed || '新的对话';
}

function shouldSupersede(existing: UserMemory, next: UserMemory): boolean {
  if (existing.userId !== next.userId) return false;
  if (existing.status !== 'active') return false;
  if (existing.value.namespace !== next.value.namespace) return false;
  if (existing.value.key !== next.value.key) return false;
  return stableStringify(existing.applicability ?? {}) === stableStringify(next.applicability ?? {});
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sourceForDisplay(source: MemorySource): string {
  if (source.type === 'conversation') return '来自对话';
  if (source.type === 'settings') return '来自设置';
  if (source.type === 'migration') return '来自旧设置';
  return '来源对话已删除';
}

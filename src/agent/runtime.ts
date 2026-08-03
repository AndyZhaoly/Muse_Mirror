import {
  OpenAIProvider,
  RunContext,
  RunState,
  Runner,
  setTracingDisabled,
  type Agent,
} from '@openai/agents';
import type { AppConfig } from '../config.js';
import { defaultPermissions, loadConfig } from '../config.js';
import { makeId } from '../utils/ids.js';
import type {
  FashionAgentContext,
  FashionTurnInput,
  FashionTurnResult,
  ResumeFashionTurnInput,
  TurnPermissions,
} from '../types.js';
import { AgentSessionManager } from '../runtime/sessionManager.js';
import {
  InMemorySessionStateStore,
  type SessionStateStore,
} from '../runtime/stateStore.js';
import {
  createServiceContainer,
  type ServiceContainer,
} from '../runtime/serviceContainer.js';
import { createFashionAgent } from './createFashionAgent.js';
import { buildTurnResult } from './resultBuilder.js';

function mergePermissions(
  supplied?: Partial<TurnPermissions>,
): TurnPermissions {
  return { ...defaultPermissions, ...supplied };
}

export class FashionAgentRuntime {
  readonly config: AppConfig;
  readonly services: ServiceContainer;
  readonly stateStore: SessionStateStore;
  readonly sessions: AgentSessionManager;
  readonly agent: Agent<FashionAgentContext>;
  private readonly modelProvider?: OpenAIProvider;
  private readonly runner: Runner;

  constructor(options?: {
    config?: AppConfig;
    services?: ServiceContainer;
    stateStore?: SessionStateStore;
    sessions?: AgentSessionManager;
  }) {
    this.config = options?.config ?? loadConfig();
    this.services = options?.services ?? createServiceContainer(this.config);
    this.stateStore = options?.stateStore ?? new InMemorySessionStateStore();
    this.sessions = options?.sessions ?? new AgentSessionManager();
    this.agent = createFashionAgent(this.config, this.services);
    this.modelProvider =
      this.config.agentProvider === 'gemma4'
        ? new OpenAIProvider({
            apiKey: process.env.GEMMA4_OLLAMA_API_KEY ?? 'ollama',
            baseURL: ollamaOpenAIBaseUrl(this.config.gemma4OllamaEndpoint),
            useResponses: false,
            strictFeatureValidation: false,
          })
        : undefined;
    this.runner = new Runner({
      ...(this.modelProvider ? { modelProvider: this.modelProvider } : {}),
      tracingDisabled: !this.config.trace,
    });
    setTracingDisabled(!this.config.trace);
  }

  async runTurn(input: FashionTurnInput): Promise<FashionTurnResult> {
    const state = this.stateStore.get(input.sessionId);
    const context: FashionAgentContext = {
      sessionId: input.sessionId,
      userId: input.userId,
      turnId: makeId('turn'),
      locale: input.locale ?? 'zh-CN',
      nowIso: new Date().toISOString(),
      permissions: mergePermissions(input.permissions),
      state,
    };

    for (const attachment of input.attachments ?? []) {
      this.services.imageStore.registerAttachment(context, attachment);
    }

    const result = await this.runner.run(this.agent, input.message, {
      context,
      session: this.sessions.get(input.sessionId),
      maxTurns: 10,
    });

    this.stateStore.set(input.sessionId, context.state);
    return buildTurnResult(result, context);
  }

  async resumeTurn(input: ResumeFashionTurnInput): Promise<FashionTurnResult> {
    const stateData = this.stateStore.get(input.sessionId);
    const context: FashionAgentContext = {
      sessionId: input.sessionId,
      userId: input.userId,
      turnId: makeId('turn'),
      locale: input.locale ?? 'zh-CN',
      nowIso: new Date().toISOString(),
      permissions: mergePermissions(input.permissions),
      state: stateData,
    };

    const runState = await RunState.fromStringWithContext(
      this.agent,
      input.serializedRunState,
      new RunContext(context),
      { contextStrategy: 'replace' },
    );

    const interruptions = runState.getInterruptions();
    for (const decision of input.decisions) {
      const interruption = interruptions[decision.index];
      if (!interruption) {
        throw new Error(`No approval interruption at index ${decision.index}.`);
      }
      if (decision.approved) {
        runState.approve(interruption, { alwaysApprove: decision.always ?? false });
      } else {
        runState.reject(interruption, {
          alwaysReject: decision.always ?? false,
          message:
            decision.rejectionMessage ??
            '用户没有批准这个操作。请在不执行该工具的情况下继续帮助用户。',
        });
      }
    }

    const result = await this.runner.run(this.agent, runState, {
      session: this.sessions.get(input.sessionId),
      maxTurns: 10,
    });

    this.stateStore.set(input.sessionId, context.state);
    return buildTurnResult(result, context);
  }

  async clearSession(sessionId: string): Promise<void> {
    this.stateStore.clear(sessionId);
    await this.sessions.clear(sessionId);
  }

  async close(): Promise<void> {
    await this.modelProvider?.close();
  }
}

function ollamaOpenAIBaseUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

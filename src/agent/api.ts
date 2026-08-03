import type {
  FashionTurnInput,
  FashionTurnResult,
  ResumeFashionTurnInput,
} from '../types.js';
import { loadConfig } from '../config.js';
import { GemmaFashionRuntime } from '../server/gemmaFashionRuntime.js';
import { OpenAIMuseRuntime } from '../server/openAiMuseRuntime.js';
import { FashionAgentRuntime } from './runtime.js';

type RuntimeLike = {
  runTurn(input: FashionTurnInput): Promise<FashionTurnResult>;
  resumeTurn(input: ResumeFashionTurnInput): Promise<FashionTurnResult>;
  stateStore: { clear(sessionId: string): void };
};

let defaultRuntime: RuntimeLike | undefined;

/**
 * Lazily creates the process-local default runtime.
 * Production applications will usually instantiate FashionAgentRuntime
 * explicitly so they can inject persistent stores and provider adapters.
 */
export function getDefaultFashionAgentRuntime(): RuntimeLike {
  const config = loadConfig();
  defaultRuntime ??=
    config.agentProvider === 'gemma4'
      ? new GemmaFashionRuntime({ config })
      : config.runtimeProvider === 'legacy'
        ? new FashionAgentRuntime({ config })
        : new OpenAIMuseRuntime({ config });
  return defaultRuntime;
}

export function runFashionTurn(
  input: FashionTurnInput,
): Promise<FashionTurnResult> {
  return getDefaultFashionAgentRuntime().runTurn(input);
}

export function resumeFashionTurn(
  input: ResumeFashionTurnInput,
): Promise<FashionTurnResult> {
  return getDefaultFashionAgentRuntime().resumeTurn(input);
}

export function clearFashionSession(sessionId: string): Promise<void> {
  getDefaultFashionAgentRuntime().stateStore.clear(sessionId);
  return Promise.resolve();
}

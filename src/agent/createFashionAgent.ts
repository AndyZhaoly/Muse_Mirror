import { Agent } from '@openai/agents';
import type { AppConfig } from '../config.js';
import type { ServiceContainer } from '../runtime/serviceContainer.js';
import type { FashionAgentContext } from '../types.js';
import { createFashionTools } from '../tools/index.js';
import { buildSystemInstructions } from './systemInstructions.js';

export function createFashionAgent(
  config: AppConfig,
  services: ServiceContainer,
): Agent<FashionAgentContext> {
  const modelSettings =
    config.agentProvider === 'openai'
      ? {
          toolChoice: 'auto' as const,
          parallelToolCalls: true,
          reasoning: { effort: 'low' as const, summary: null },
          text: { verbosity: 'medium' as const },
        }
      : {
          toolChoice: 'auto' as const,
          parallelToolCalls: false,
          temperature: 0.3,
        };

  return new Agent<FashionAgentContext>({
    name: 'Muse Mirror Fashion Agent',
    model: config.agentModel,
    instructions: (runContext) =>
      buildSystemInstructions(runContext.context, services.skills.catalog()),
    tools: createFashionTools(services),
    modelSettings,
  });
}

import type { RunContext } from '@openai/agents';
import type { FashionAgentContext, OutfitCandidate } from '../types.js';

export function requireContext(
  runContext?: RunContext<unknown>,
): FashionAgentContext {
  if (!runContext?.context) {
    throw new Error('Fashion agent tool was called without application context.');
  }
  return runContext.context as FashionAgentContext;
}

export function resolveOutfit(
  context: FashionAgentContext,
  supplied?: OutfitCandidate,
): OutfitCandidate {
  const outfit = supplied ?? context.state.activeOutfit;
  if (!outfit) {
    throw new Error(
      'No active outfit is available. Ask the user to select a look or provide an outfit description first.',
    );
  }
  return outfit;
}

import { tool } from '@openai/agents';
import { z } from 'zod';
import { asJson } from '../utils/json.js';
import { requireContext } from './helpers.js';

const preferenceValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
]);

export function createMemoryTools() {
  const saveUserPreference = tool({
    name: 'save_user_preference',
    description:
      'Save an explicit user preference. Use session scope for temporary constraints in the current conversation. Use persistent scope only for stable future preferences such as never recommending heels. Do not save inferred sensitive traits or every casual remark.',
    parameters: z.object({
      key: z.string().min(1),
      value: preferenceValueSchema,
      scope: z.enum(['session', 'persistent']).default('session'),
      evidence: z.string().min(1).describe('Brief quote or paraphrase of the user’s explicit preference.'),
    }),
    needsApproval: async (runContext, input) =>
      input.scope === 'persistent' &&
      !requireContext(runContext).permissions.allowPersistentMemory,
    execute: async ({ key, value, scope, evidence }, runContext) => {
      const context = requireContext(runContext);
      if (scope === 'persistent') {
        context.state.persistentPreferences[key] = value;
      } else {
        context.state.sessionPreferences[key] = value;
      }
      return asJson({ saved: true, key, value, scope, evidence });
    },
  });

  return [saveUserPreference];
}

import { tool } from '@openai/agents';
import { z } from 'zod';
import type { ServiceContainer } from '../runtime/serviceContainer.js';
import { withToolLog } from '../runtime/toolLogging.js';
import { asJson } from '../utils/json.js';
import { requireContext } from './helpers.js';
import { runtimeFashionSkillNames } from '../services/skillRegistry.js';

export function createSkillLoaderTools(services: ServiceContainer) {
  const loadFashionSkill = tool({
    name: 'load_fashion_skill',
    description:
      'Load a stable professional styling method or one of its references when a complex diagnosis, occasion plan, complete-look review, or AI try-on preparation benefits from focused instructions. This loader does not fetch live data, inspect images, generate artifacts, or change user state. Do not load a skill for a simple question that can be answered confidently and directly.',
    parameters: z.object({
      skill: z.enum(runtimeFashionSkillNames),
      reference: z
        .string()
        .regex(/^[a-z0-9][a-z0-9._-]*\.md$/i)
        .optional()
        .describe('Optional reference filename listed by the skill.'),
    }),
    execute: async ({ skill, reference }, runContext) => {
      const context = requireContext(runContext);
      const result = await withToolLog(
        context.state,
        'load_fashion_skill',
        async () => services.skills.load(skill, reference),
        (value) =>
          value.reference
            ? `Loaded ${value.name}/${value.reference.name}`
            : `Loaded fashion skill ${value.name}`,
      );
      return asJson(result);
    },
  });

  return [loadFashionSkill];
}

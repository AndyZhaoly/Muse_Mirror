import { tool } from '@openai/agents';
import { z } from 'zod';
import type { ServiceContainer } from '../runtime/serviceContainer.js';
import { withToolLog } from '../runtime/toolLogging.js';
import { asJson } from '../utils/json.js';
import { requireContext } from './helpers.js';
import { outfitSchema } from './schemas.js';

export function createOutfitTools(services: ServiceContainer) {
  const verifyOutfitQuality = tool({
    name: 'verify_outfit_quality',
    description:
      'Run an independent structured quality verification on a complete outfit for occasion fit, color coherence, silhouette, proportion, footwear, completeness, weather, and stated preferences. Use when repeatable verification, logging, an important occasion, shopping, or pre-generation confidence justifies an external evaluator. For ordinary self-review, load the outfit-review skill instead; do not force this tool into every exchange.',
    parameters: z.object({
      outfit: outfitSchema,
      makeActiveIfPasses: z.boolean().default(false),
    }),
    execute: async ({ outfit, makeActiveIfPasses }, runContext) => {
      const context = requireContext(runContext);
      const evaluation = await withToolLog(
        context.state,
        'verify_outfit_quality',
        async () => services.evaluator.evaluate(outfit, context),
        (value) => `Outfit score ${value.overallScore}; pass=${value.pass}`,
      );
      if (makeActiveIfPasses && evaluation.pass) {
        context.state.activeOutfit = outfit;
      }
      return asJson({ outfitId: outfit.id, evaluation });
    },
  });

  const setActiveOutfit = tool({
    name: 'set_active_outfit',
    description:
      'Store the outfit that the user has selected or that will be referenced in later turns as “this look”, “the first one”, or similar. This is session state only and produces no user-visible image. Do not call merely to record every speculative idea.',
    parameters: z.object({ outfit: outfitSchema }),
    execute: async ({ outfit }, runContext) => {
      const context = requireContext(runContext);
      context.state.activeOutfit = outfit;
      return asJson({ saved: true, activeOutfitId: outfit.id });
    },
  });

  return [verifyOutfitQuality, setActiveOutfit];
}

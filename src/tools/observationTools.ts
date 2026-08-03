import { tool } from '@openai/agents';
import { z } from 'zod';
import type { ServiceContainer } from '../runtime/serviceContainer.js';
import { withToolLog } from '../runtime/toolLogging.js';
import { asJson } from '../utils/json.js';
import { requireContext } from './helpers.js';

export function createObservationTools(services: ServiceContainer) {
  const analyzeCurrentView = tool({
    name: 'analyze_current_view',
    description:
      'Analyze the user’s currently authorized camera frame or photo for visible garments, colors, silhouette, proportion cues, formality, and uncertainty. Use only when the answer genuinely depends on seeing the current outfit. Do not use for general fashion theory. This tool analyzes an existing image; it never generates or edits images.',
    parameters: z.object({
      imageId: z
        .string()
        .optional()
        .describe('Authorized user image id. Omit to use the current user photo.'),
      focus: z
        .enum(['overall_outfit', 'color', 'silhouette', 'fit', 'comparison'])
        .default('overall_outfit'),
    }),
    needsApproval: async (runContext) =>
      !requireContext(runContext).permissions.allowVisualAnalysis,
    execute: async ({ imageId, focus }, runContext) => {
      const context = requireContext(runContext);
      const image = imageId
        ? services.imageStore.getAuthorized(context, imageId, ['user_photo'])
        : services.imageStore.getCurrentUserImage(context);
      const observation = await withToolLog(
        context.state,
        'analyze_current_view',
        () => services.vision.analyze(image, focus),
        (value) => `Observed ${value.visibleItems.length} visible items`,
      );
      return asJson({ imageId: image.id, observation });
    },
  });

  return [analyzeCurrentView];
}

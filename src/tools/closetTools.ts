import { tool } from '@openai/agents';
import { z } from 'zod';
import type { ServiceContainer } from '../runtime/serviceContainer.js';
import { pushArtifact } from '../runtime/artifacts.js';
import { withToolLog } from '../runtime/toolLogging.js';
import { makeId } from '../utils/ids.js';
import { asJson } from '../utils/json.js';
import { requireContext } from './helpers.js';

export function createClosetTools(services: ServiceContainer) {
  const searchCloset = tool({
    name: 'search_closet',
    description:
      'Search the user’s actual closet inventory when the user wants to use clothes they already own or when a recommendation must be grounded in available pieces. This tool returns real closet records. It does not generate images and does not search stores.',
    parameters: z.object({
      query: z.string().min(1),
      categories: z.array(z.string()).optional(),
      colors: z.array(z.string()).optional(),
      formality: z.string().optional(),
      limit: z.number().int().min(1).max(12).default(8),
    }),
    execute: async (input, runContext) => {
      const context = requireContext(runContext);
      const items = await withToolLog(
        context.state,
        'search_closet',
        async () => services.closet.search(input),
        (value) => `Found ${value.length} closet items`,
      );
      return asJson({ items });
    },
  });

  const getItemImages = tool({
    name: 'get_item_images',
    description:
      'Display real images of specific items that already exist in the user’s closet. Use when the user asks “which item?”, “show me that jacket”, or wants to visually confirm referenced closet pieces. Never use this tool to invent a garment or show store products.',
    parameters: z.object({
      itemIds: z.array(z.string()).min(1).max(12),
      title: z.string().default('衣柜单品'),
    }),
    execute: async ({ itemIds, title }, runContext) => {
      const context = requireContext(runContext);
      const items = services.closet.getByIds(itemIds);
      if (!items.length) throw new Error('No matching closet items were found.');
      pushArtifact(context.state, {
        type: 'item_grid',
        id: makeId('artifact'),
        title,
        items: items.map((item) => ({
          id: item.id,
          name: item.name,
          imageUrl: item.imageUrl,
          source: 'closet' as const,
        })),
      });
      return asJson({ displayed: items.map(({ id, name, imageUrl }) => ({ id, name, imageUrl })) });
    },
  });

  return [searchCloset, getItemImages];
}

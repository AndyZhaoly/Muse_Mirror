import { tool } from '@openai/agents';
import { z } from 'zod';
import type { ServiceContainer } from '../runtime/serviceContainer.js';
import { pushArtifact } from '../runtime/artifacts.js';
import { withToolLog } from '../runtime/toolLogging.js';
import { makeId } from '../utils/ids.js';
import { asJson } from '../utils/json.js';
import { requireContext } from './helpers.js';

export function createProductTools(services: ServiceContainer) {
  const findClothingProducts = tool({
    name: 'find_clothing_products',
    description:
      'Search a real merchant/catalog provider for purchasable clothing when the user explicitly wants shopping options or lacks a needed closet item. Return real product images, prices, source, and links. Never use AI-generated images as product listings.',
    parameters: z.object({
      query: z.string().min(1),
      category: z.string().optional(),
      color: z.string().optional(),
      maxPrice: z.number().positive().optional(),
      limit: z.number().int().min(1).max(12).default(6),
    }),
    execute: async (input, runContext) => {
      const context = requireContext(runContext);
      const products = await withToolLog(
        context.state,
        'find_clothing_products',
        () => services.products.search(input),
        (value) => `Found ${value.length} catalog products`,
      );
      pushArtifact(context.state, {
        type: 'product_cards',
        id: makeId('artifact'),
        title: '可购买的真实商品',
        products,
      });
      return asJson({ products });
    },
  });

  return [findClothingProducts];
}

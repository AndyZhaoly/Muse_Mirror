import { z } from 'zod';

export const outfitItemSchema = z.object({
  category: z.string().min(1),
  name: z.string().min(1),
  color: z.string().min(1),
  fit: z.string().optional(),
  source: z.enum(['closet', 'catalog', 'suggested']).optional(),
  itemId: z.string().optional(),
});

export const outfitSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  occasion: z.string().optional(),
  items: z.array(outfitItemSchema).min(1),
  stylingActions: z.array(z.string()).optional(),
  rationale: z.string().optional(),
});

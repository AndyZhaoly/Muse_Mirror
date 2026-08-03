import type { ServiceContainer } from '../runtime/serviceContainer.js';
import { createClosetTools } from './closetTools.js';
import { createContextTools } from './contextTools.js';
import { createMemoryTools } from './memoryTools.js';
import { createObservationTools } from './observationTools.js';
import { createOutfitTools } from './outfitTools.js';
import { createProductTools } from './productTools.js';
import { createSkillLoaderTools } from './skillTools.js';
import { createVisualTools } from './visualTools.js';

/**
 * The skill loader exposes deferred instruction bundles. The remaining tools
 * perform external I/O, generation, persistence, or independent verification.
 */
export function createFashionTools(services: ServiceContainer) {
  return [
    ...createSkillLoaderTools(services),
    ...createObservationTools(services),
    ...createClosetTools(services),
    ...createContextTools(services),
    ...createOutfitTools(services),
    ...createProductTools(services),
    ...createVisualTools(services),
    ...createMemoryTools(),
  ];
}

import { tool } from '@openai/agents';
import { z } from 'zod';
import type { ServiceContainer } from '../runtime/serviceContainer.js';
import { withToolLog } from '../runtime/toolLogging.js';
import { asJson } from '../utils/json.js';
import { requireContext } from './helpers.js';

export function createContextTools(services: ServiceContainer) {
  const getWeather = tool({
    name: 'get_weather',
    description:
      'Get current weather for a location when temperature, rain, wind, or outdoor conditions materially affect what the user should wear. Do not call for every fashion question or when the user already supplied sufficient weather information.',
    parameters: z.object({
      location: z.string().min(1),
    }),
    execute: async ({ location }, runContext) => {
      const context = requireContext(runContext);
      const result = await withToolLog(
        context.state,
        'get_weather',
        () => services.weather.getCurrent(location),
        (value) => `${value.location}: ${value.temperatureC}C, ${value.condition}`,
      );
      return asJson(result);
    },
  });

  return [getWeather];
}

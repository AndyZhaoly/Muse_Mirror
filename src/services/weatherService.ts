import fs from 'node:fs';
import path from 'node:path';
import type { WeatherResult } from '../types.js';

interface MockWeatherRecord {
  temperatureC: number;
  condition: string;
  feelsLikeC: number;
  precipitationChance: number;
  windKph: number;
}

export class WeatherService {
  private readonly mockData: Record<string, MockWeatherRecord>;

  constructor(
    private readonly mockTools: boolean,
    dataPath = path.resolve('./data/mock-weather.json'),
  ) {
    this.mockData = JSON.parse(
      fs.readFileSync(dataPath, 'utf8'),
    ) as Record<string, MockWeatherRecord>;
  }

  async getCurrent(location: string): Promise<WeatherResult> {
    if (!this.mockTools) {
      throw new Error(
        'Real weather provider is not configured. Implement WeatherService with your chosen provider.',
      );
    }
    const record = this.mockData[location] ?? this.mockData.default;
    if (!record) throw new Error('Mock weather data is missing a default record.');
    return {
      location,
      ...record,
      observedAt: new Date().toISOString(),
      source: 'mock_weather',
    };
  }
}

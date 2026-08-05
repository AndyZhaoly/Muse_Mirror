import fs from 'node:fs/promises';
import OpenAI from 'openai';
import type { VisionProvider } from '../config.js';
import type {
  AmbientCapturePacket,
  WornOutfitObservation,
} from '../domain/ambientCapture.js';
import { extractJsonObject } from '../utils/json.js';
import { makeId } from '../utils/ids.js';

export interface OutfitObservationInput {
  packet: AmbientCapturePacket;
}

export interface OutfitObservationProvider {
  readonly ready: boolean;
  analyze(input: OutfitObservationInput): Promise<WornOutfitObservation>;
}

const observationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['personCount', 'coverage', 'quality', 'garments', 'uncertainties'],
  properties: {
    personCount: { type: 'integer', minimum: 0, maximum: 5 },
    coverage: {
      type: 'string',
      enum: ['none', 'head_shoulders', 'upper_body', 'three_quarter', 'full_body'],
    },
    quality: { type: 'string', enum: ['unusable', 'limited', 'good'] },
    garments: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'slot',
          'category',
          'description',
          'dominantColor',
          'secondaryColors',
          'pattern',
          'silhouette',
          'fit',
          'distinctiveFeatures',
          'boundingBox',
          'confidence',
          'uncertainties',
        ],
        properties: {
          slot: {
            type: 'string',
            enum: ['top', 'bottom', 'dress', 'outerwear', 'shoes', 'bag', 'accessory'],
          },
          category: {
            type: 'string',
            enum: ['top', 'bottom', 'dress', 'jumpsuit', 'outerwear', 'shoes', 'bag', 'accessory'],
          },
          description: { type: 'string' },
          dominantColor: { type: 'string' },
          secondaryColors: { type: 'array', items: { type: 'string' }, maxItems: 4 },
          pattern: { type: 'string' },
          silhouette: { type: 'string' },
          fit: { type: 'string' },
          distinctiveFeatures: { type: 'array', items: { type: 'string' }, maxItems: 8 },
          boundingBox: {
            type: 'object',
            additionalProperties: false,
            required: ['x', 'y', 'width', 'height'],
            properties: {
              x: { type: 'number', minimum: 0, maximum: 1 },
              y: { type: 'number', minimum: 0, maximum: 1 },
              width: { type: 'number', minimum: 0, maximum: 1 },
              height: { type: 'number', minimum: 0, maximum: 1 },
            },
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          uncertainties: { type: 'array', items: { type: 'string' }, maxItems: 8 },
        },
      },
    },
    uncertainties: { type: 'array', items: { type: 'string' }, maxItems: 10 },
  },
} as const;

export class RealOutfitObservationProvider implements OutfitObservationProvider {
  readonly ready: boolean;

  constructor(
    private readonly options: {
      provider: VisionProvider;
      openaiModel: string;
      ollamaEndpoint: string;
      ollamaModel: string;
    },
  ) {
    this.ready = options.provider === 'openai'
      ? Boolean(process.env.OPENAI_API_KEY)
      : options.provider === 'ollama';
  }

  async analyze(input: OutfitObservationInput): Promise<WornOutfitObservation> {
    if (!this.ready || this.options.provider === 'mock') {
      throw new Error('A real outfit observation provider is not available.');
    }
    const raw = this.options.provider === 'openai'
      ? await this.analyzeOpenAI(input.packet)
      : await this.analyzeOllama(input.packet);
    return normalizeObservation(raw, {
      provider: this.options.provider,
      model: this.options.provider === 'openai'
        ? this.options.openaiModel
        : this.options.ollamaModel,
    });
  }

  private async analyzeOpenAI(packet: AmbientCapturePacket): Promise<unknown> {
    const bytes = await fs.readFile(packet.imagePath);
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.responses.create({
      model: this.options.openaiModel,
      store: false,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: observationPrompt() },
          {
            type: 'input_image',
            image_url: `data:${packet.imageMimeType};base64,${bytes.toString('base64')}`,
            detail: 'high',
          },
        ],
      }],
      text: {
        format: {
          type: 'json_schema',
          name: 'ambient_worn_outfit_observation',
          strict: true,
          schema: observationSchema,
        },
      },
    } as any);
    return extractJsonObject<unknown>(response.output_text);
  }

  private async analyzeOllama(packet: AmbientCapturePacket): Promise<unknown> {
    const bytes = await fs.readFile(packet.imagePath);
    const response = await fetch(`${this.options.ollamaEndpoint.replace(/\/+$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.options.ollamaModel,
        messages: [{ role: 'user', content: observationPrompt(), images: [bytes.toString('base64')] }],
        stream: false,
        format: observationSchema,
        think: false,
        options: { temperature: 0, num_ctx: 8192, num_predict: 1400 },
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(`Outfit observation failed with HTTP ${response.status}.`);
    const body = await response.json() as { message?: { content?: string } };
    return extractJsonObject<unknown>(body.message?.content ?? '');
  }
}

function observationPrompt(): string {
  return `Inspect this real mirror frame for passive wardrobe capture.

Return only the structured observation requested by the schema.
- Count people conservatively.
- Describe only garments visibly WORN by the single person. Ignore garments held in hands, furniture, bedding, and background clothing.
- Emit separate items by slot. A visible open overshirt is outerwear; the shirt beneath it is top.
- Use stable visual attributes useful for recognizing the same physical garment later: category, main color, pattern, silhouette, fit, and distinctive visible details.
- Bounding boxes are normalized to the entire image (0..1).
- quality=good only when garment color and shape are sufficiently clear.
- coverage=three_quarter requires the upper body and most of the legs; full_body requires feet.
- Do not infer brand, price, ownership, identity, gender, body traits, sensitive attributes, or unseen garments.
- If evidence is weak, lower confidence and state uncertainties rather than guessing.`;
}

function normalizeObservation(
  value: any,
  provenance: { provider: string; model: string },
): WornOutfitObservation {
  const garments = Array.isArray(value?.garments) ? value.garments : [];
  return {
    observationId: makeId('ambient_observation'),
    provider: provenance.provider,
    model: provenance.model,
    analyzedAt: new Date().toISOString(),
    personCount: integer(value?.personCount, 0, 5),
    coverage: enumValue(value?.coverage, ['none', 'head_shoulders', 'upper_body', 'three_quarter', 'full_body'], 'none'),
    quality: enumValue(value?.quality, ['unusable', 'limited', 'good'], 'unusable'),
    garments: garments.map((item: any, index: number) => ({
      observationItemId: `${makeId('observed_garment')}_${index}`,
      slot: enumValue(item?.slot, ['top', 'bottom', 'dress', 'outerwear', 'shoes', 'bag', 'accessory'], 'accessory'),
      category: enumValue(item?.category, ['top', 'bottom', 'dress', 'jumpsuit', 'outerwear', 'shoes', 'bag', 'accessory'], 'accessory'),
      description: text(item?.description, 'visible garment'),
      dominantColor: text(item?.dominantColor, 'unknown'),
      secondaryColors: texts(item?.secondaryColors),
      pattern: text(item?.pattern, 'solid'),
      silhouette: text(item?.silhouette, 'unknown'),
      fit: text(item?.fit, 'unknown'),
      distinctiveFeatures: texts(item?.distinctiveFeatures),
      boundingBox: {
        x: unit(item?.boundingBox?.x),
        y: unit(item?.boundingBox?.y),
        width: unit(item?.boundingBox?.width),
        height: unit(item?.boundingBox?.height),
      },
      confidence: unit(item?.confidence),
      uncertainties: texts(item?.uncertainties),
    })),
    uncertainties: texts(value?.uncertainties),
  };
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 240) : fallback;
}

function texts(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim().slice(0, 120)).slice(0, 8)
    : [];
}

function unit(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : minimum;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return typeof value === 'string' && values.includes(value as T) ? value as T : fallback;
}

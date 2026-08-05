import fs from 'node:fs/promises';
import OpenAI from 'openai';
import type {
  GarmentImageAsset,
  GarmentVisualVerification,
  ProductImageVerification,
} from '../domain/ambientCapture.js';
import type { ClosetItem } from '../types.js';

export interface GarmentVisualVerifierInput {
  currentAppearance: GarmentImageAsset;
  candidates: Array<{
    closetItem: ClosetItem;
    appearanceAssets: GarmentImageAsset[];
    fallbackCatalogImage?: GarmentImageAsset;
  }>;
}

export interface GarmentVisualVerifier {
  readonly ready: boolean;
  verify(input: GarmentVisualVerifierInput): Promise<GarmentVisualVerification>;
}

export interface ProductImageVerifier {
  readonly ready: boolean;
  verify(input: {
    sourceAppearance: GarmentImageAsset;
    generatedProductImage: GarmentImageAsset;
    category: string;
  }): Promise<ProductImageVerification>;
}

export class OpenAIGarmentVisualVerifier implements GarmentVisualVerifier {
  readonly ready: boolean;

  constructor(
    private readonly options: {
      model: string;
      apiKey?: string;
      responseCreate?: (request: unknown) => Promise<unknown>;
    },
  ) {
    this.ready = Boolean(options.responseCreate || options.apiKey);
  }

  async verify(input: GarmentVisualVerifierInput): Promise<GarmentVisualVerification> {
    if (!this.ready) return uncertainGarmentVerification('VISUAL_VERIFIER_UNAVAILABLE');
    if (!input.candidates.length) {
      return { result: 'different', confidence: 1, evidence: ['No recalled candidate exists.'], mismatches: [] };
    }
    const allowedIds = input.candidates.map((candidate) => candidate.closetItem.id);
    const content: Array<Record<string, unknown>> = [
      {
        type: 'input_text',
        text: [
          'Compare the current garment crop against only the supplied candidate garments.',
          'Ignore the wearer, face, body, pose, lighting, and background.',
          'Use garment identity details: neckline, sleeves, closures, pockets, pattern placement, stitching, cuffs, length, texture, and silhouette proportions.',
          `Allowed candidate IDs: ${allowedIds.join(', ')}`,
          'Return same only when one candidate is visibly the same physical garment. Return different when every candidate is clearly different. Otherwise return uncertain.',
        ].join('\n'),
      },
      { type: 'input_text', text: 'CURRENT GARMENT' },
      { type: 'input_image', image_url: await assetDataUrl(input.currentAppearance) },
    ];
    for (const candidate of input.candidates) {
      content.push({ type: 'input_text', text: `CANDIDATE ${candidate.closetItem.id}` });
      const references = candidate.appearanceAssets.length
        ? candidate.appearanceAssets.slice(-2)
        : candidate.fallbackCatalogImage ? [candidate.fallbackCatalogImage] : [];
      for (const reference of references) {
        content.push({ type: 'input_image', image_url: await assetDataUrl(reference) });
      }
    }
    const response = await this.create({
      model: this.options.model,
      store: false,
      input: [{ role: 'user', content }],
      text: {
        format: {
          type: 'json_schema',
          name: 'garment_visual_verification',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              result: { type: 'string', enum: ['same', 'different', 'uncertain'] },
              matchedClosetItemId: { type: ['string', 'null'] },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              evidence: { type: 'array', items: { type: 'string' } },
              mismatches: { type: 'array', items: { type: 'string' } },
            },
            required: ['result', 'matchedClosetItemId', 'confidence', 'evidence', 'mismatches'],
          },
        },
      },
    });
    const parsed = parseOutputJson(response) as GarmentVisualVerification & { matchedClosetItemId?: string | null };
    if (!['same', 'different', 'uncertain'].includes(parsed.result) || !Number.isFinite(parsed.confidence)) {
      return uncertainGarmentVerification('VISUAL_VERIFIER_INVALID_OUTPUT');
    }
    if (parsed.matchedClosetItemId && !allowedIds.includes(parsed.matchedClosetItemId)) {
      return uncertainGarmentVerification('VISUAL_VERIFIER_RETURNED_NON_ALLOWLIST_ID');
    }
    if (parsed.result === 'same' && !parsed.matchedClosetItemId) {
      return uncertainGarmentVerification('VISUAL_VERIFIER_MATCH_WITHOUT_ID');
    }
    return {
      result: parsed.result,
      matchedClosetItemId: parsed.matchedClosetItemId ?? undefined,
      confidence: clamp(parsed.confidence),
      evidence: safeStrings(parsed.evidence),
      mismatches: safeStrings(parsed.mismatches),
    };
  }

  private async create(request: unknown): Promise<unknown> {
    if (this.options.responseCreate) return this.options.responseCreate(request);
    return new OpenAI({ apiKey: this.options.apiKey }).responses.create(request as never);
  }
}

export class OpenAIProductImageVerifier implements ProductImageVerifier {
  readonly ready: boolean;

  constructor(
    private readonly options: {
      model: string;
      apiKey?: string;
      responseCreate?: (request: unknown) => Promise<unknown>;
    },
  ) {
    this.ready = Boolean(options.responseCreate || options.apiKey);
  }

  async verify(input: {
    sourceAppearance: GarmentImageAsset;
    generatedProductImage: GarmentImageAsset;
    category: string;
  }): Promise<ProductImageVerification> {
    if (!this.ready) return uncertainProductVerification('PRODUCT_IMAGE_VERIFIER_UNAVAILABLE');
    const response = await this.create({
      model: this.options.model,
      store: false,
      input: [{
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: [
              `Verify whether the generated catalog image preserves the same ${input.category} shown in the real crop.`,
              'Compare category, main color, pattern, neckline, sleeve, closures, pockets, silhouette, length, and visible logos.',
              'The first image is real evidence. The second is AI-edited catalog output.',
              'Fail any critical identity change. Return uncertain when occlusion prevents a reliable comparison.',
            ].join('\n'),
          },
          { type: 'input_text', text: 'REAL GARMENT CROP' },
          { type: 'input_image', image_url: await assetDataUrl(input.sourceAppearance) },
          { type: 'input_text', text: 'GENERATED CATALOG IMAGE' },
          { type: 'input_image', image_url: await assetDataUrl(input.generatedProductImage) },
        ],
      }],
      text: {
        format: {
          type: 'json_schema',
          name: 'product_image_verification',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              result: { type: 'string', enum: ['pass', 'fail', 'uncertain'] },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              checks: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  colorMatch: { type: 'boolean' }, patternMatch: { type: 'boolean' }, necklineMatch: { type: 'boolean' },
                  sleeveMatch: { type: 'boolean' }, closureMatch: { type: 'boolean' }, pocketMatch: { type: 'boolean' },
                  silhouetteMatch: { type: 'boolean' }, lengthMatch: { type: 'boolean' }, logoMatch: { type: 'boolean' },
                },
                required: ['colorMatch', 'patternMatch', 'necklineMatch', 'sleeveMatch', 'closureMatch', 'pocketMatch', 'silhouetteMatch', 'lengthMatch', 'logoMatch'],
              },
              mismatches: { type: 'array', items: { type: 'string' } },
              notes: { type: 'array', items: { type: 'string' } },
            },
            required: ['result', 'confidence', 'checks', 'mismatches', 'notes'],
          },
        },
      },
    });
    const parsed = parseOutputJson(response) as ProductImageVerification;
    if (!['pass', 'fail', 'uncertain'].includes(parsed.result) || !parsed.checks) {
      return uncertainProductVerification('PRODUCT_IMAGE_VERIFIER_INVALID_OUTPUT');
    }
    return {
      ...parsed,
      confidence: clamp(parsed.confidence),
      mismatches: safeStrings(parsed.mismatches),
      notes: safeStrings(parsed.notes),
    };
  }

  private async create(request: unknown): Promise<unknown> {
    if (this.options.responseCreate) return this.options.responseCreate(request);
    return new OpenAI({ apiKey: this.options.apiKey }).responses.create(request as never);
  }
}

export class DisabledGarmentVisualVerifier implements GarmentVisualVerifier {
  readonly ready = false;
  async verify(): Promise<GarmentVisualVerification> {
    return uncertainGarmentVerification('VISUAL_VERIFIER_DISABLED');
  }
}

export class DisabledProductImageVerifier implements ProductImageVerifier {
  readonly ready = false;
  async verify(): Promise<ProductImageVerification> {
    return uncertainProductVerification('PRODUCT_IMAGE_VERIFIER_DISABLED');
  }
}

async function assetDataUrl(asset: GarmentImageAsset): Promise<string> {
  if (!asset.storagePath) throw new Error(`Asset ${asset.assetId} has no readable storage path.`);
  const bytes = await fs.readFile(asset.storagePath);
  return `data:${asset.mimeType};base64,${bytes.toString('base64')}`;
}

function parseOutputJson(response: unknown): unknown {
  const value = response as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
  const text = value.output_text ?? value.output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? '').join('');
  if (!text) throw new Error('Visual verifier returned no structured output.');
  return JSON.parse(text);
}

function uncertainGarmentVerification(reason: string): GarmentVisualVerification {
  return { result: 'uncertain', confidence: 0, evidence: [], mismatches: [reason] };
}

function uncertainProductVerification(reason: string): ProductImageVerification {
  return {
    result: 'uncertain', confidence: 0,
    checks: { colorMatch: false, patternMatch: false },
    mismatches: [reason], notes: [],
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function safeStrings(values: unknown): string[] {
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string').slice(0, 20) : [];
}

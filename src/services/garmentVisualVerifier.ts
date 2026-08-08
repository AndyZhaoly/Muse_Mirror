import fs from 'node:fs/promises';
import OpenAI from 'openai';
import type {
  GarmentAppearanceDescriptor,
  GarmentIdentityFeature,
  GarmentImageAsset,
  PairwiseGarmentVerification,
  ProductImageVerification,
} from '../domain/ambientCapture.js';
import type { ClosetItem } from '../types.js';
import {
  CANONICAL_COLORS,
  CANONICAL_NECKLINES,
  CANONICAL_SLEEVES,
  canonicalizeColor,
  canonicalizeNeckline,
  canonicalizeSleeve,
} from './garmentVocabulary.js';

export const GARMENT_PAIRWISE_PROMPT_VERSION = 'garment-pairwise-v3-instance-taxonomy';

export interface GarmentPairwiseVerificationInput {
  currentAppearance: GarmentImageAsset;
  lockedDescriptor: GarmentAppearanceDescriptor;
  candidate: {
    closetItem: ClosetItem;
    referenceAppearances: GarmentImageAsset[];
    catalogFallbackImage?: GarmentImageAsset;
  };
}

export interface GarmentPairwiseVerifier {
  readonly ready: boolean;
  verifyPair(input: GarmentPairwiseVerificationInput): Promise<PairwiseGarmentVerification>;
}

/** @deprecated Pairwise verification is the only supported identity contract. */
export type GarmentVisualVerifier = GarmentPairwiseVerifier;

export interface ProductImageVerifier {
  readonly ready: boolean;
  verify(input: {
    sourceAppearance: GarmentImageAsset;
    generatedProductImage: GarmentImageAsset;
    category: string;
  }): Promise<ProductImageVerification>;
}

export class OpenAIGarmentVisualVerifier implements GarmentPairwiseVerifier {
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

  async verifyPair(input: GarmentPairwiseVerificationInput): Promise<PairwiseGarmentVerification> {
    if (!this.ready) return uncertainGarmentVerification('VISUAL_VERIFIER_UNAVAILABLE', this.options.model);
    const references = input.candidate.referenceAppearances.length
      ? input.candidate.referenceAppearances.slice(-2)
      : input.candidate.catalogFallbackImage ? [input.candidate.catalogFallbackImage] : [];
    if (!references.length) return uncertainGarmentVerification('VISUAL_REFERENCE_UNAVAILABLE', this.options.model);
    const content: Array<Record<string, unknown>> = [
      {
        type: 'input_text',
        text: [
          `Pairwise garment identity verification. Prompt version: ${GARMENT_PAIRWISE_PROMPT_VERSION}.`,
          'Compare the current garment crop with exactly one candidate ClosetItem.',
          `Candidate ID: ${input.candidate.closetItem.id}`,
          `Locked current descriptor: ${JSON.stringify({
            dominantColor: input.lockedDescriptor.dominantColor,
            pattern: input.lockedDescriptor.pattern,
            sleeve: input.lockedDescriptor.sleeve ?? 'unknown',
            neckline: input.lockedDescriptor.neckline ?? 'unknown',
            lengthClass: input.lockedDescriptor.lengthClass ?? 'unknown',
            materialClass: input.lockedDescriptor.materialClass ?? 'unknown',
          })}`,
          'Treat the locked current descriptor as the canonical reading of the current garment. Do not reinterpret the current image to resemble the reference.',
          'Repeat your own current-image color, sleeve, and neckline readings in the structured currentColor/currentSleeve/currentNeckline fields.',
          'Color, category family, sleeve length, neckline family, texture family, fit, silhouette, length, and general shape are class-level style evidence. They can never establish that two physical garments are the same item.',
          'Use only regions and features that are jointly visible in the current and reference images.',
          'A feature visible in one image but occluded, covered, or cropped out in the other is unknown, never different.',
          'For example, when a shirt covers a trouser waistband or drawstring, absence of that detail is not identity evidence.',
          'Length, fit, looseness, and silhouette are affected by crop, distance, wearer pose, and body position. They may be weak supporting evidence but can never alone decide different.',
          'Lighting and white balance can change apparent color. Slight color drift is not decisive.',
          'Physical identity requires jointly visible instance-specific construction details: pattern/print/logo placement, pocket geometry, drawstring construction, closure/button/zipper layout, unique decoration, stitching layout, waistband/hem/cuff construction, unique texture details, or distinctive hardware.',
          'Use pattern_family only for the broad pattern type. Use pattern_placement or print_placement for location-specific evidence. Use pocket_geometry, button_layout, and the other construction-specific enum values rather than generic pocket or button labels.',
          'Ignore the wearer, face, body shape, pose, and background.',
          'Return uncertain whenever jointly visible discriminative evidence is insufficient.',
          'Use high confidence only when the structured evidence supports it.',
        ].join('\n'),
      },
      { type: 'input_text', text: 'CURRENT GARMENT' },
      { type: 'input_image', image_url: await assetDataUrl(input.currentAppearance) },
      { type: 'input_text', text: `REFERENCE GARMENT: ${input.candidate.closetItem.id}` },
    ];
    for (const reference of references) {
      content.push({ type: 'input_image', image_url: await assetDataUrl(reference) });
    }
    try {
      const response = await this.create({
        model: this.options.model,
        store: false,
        input: [{ role: 'user', content }],
        text: {
          format: {
            type: 'json_schema',
            name: 'pairwise_garment_verification',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                verdict: { type: 'string', enum: ['same', 'different', 'uncertain'] },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
                currentColor: { type: 'string', enum: [...CANONICAL_COLORS] },
                currentSleeve: { type: 'string', enum: [...CANONICAL_SLEEVES] },
                currentNeckline: { type: 'string', enum: [...CANONICAL_NECKLINES] },
                featureComparisons: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      feature: { type: 'string', enum: GARMENT_IDENTITY_FEATURES },
                      currentVisibility: { type: 'string', enum: ['visible', 'partial', 'not_visible'] },
                      referenceVisibility: { type: 'string', enum: ['visible', 'partial', 'not_visible'] },
                      relation: { type: 'string', enum: ['same', 'different', 'unknown'] },
                      discriminativeStrength: { type: 'string', enum: ['weak', 'medium', 'strong'] },
                      note: { type: 'string' },
                    },
                    required: ['feature', 'currentVisibility', 'referenceVisibility', 'relation', 'discriminativeStrength', 'note'],
                  },
                },
                occlusions: { type: 'array', items: { type: 'string' } },
                jointlyVisibleEvidence: { type: 'array', items: { type: 'string' } },
              },
              required: [
                'verdict', 'confidence', 'currentColor', 'currentSleeve', 'currentNeckline',
                'featureComparisons', 'occlusions', 'jointlyVisibleEvidence',
              ],
            },
          },
        },
      });
      return parsePairwiseVerification(parseOutputJson(response), this.options.model);
    } catch {
      return uncertainGarmentVerification('VISUAL_VERIFIER_INVALID_OUTPUT', this.options.model);
    }
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

export class DisabledGarmentVisualVerifier implements GarmentPairwiseVerifier {
  readonly ready = false;
  async verifyPair(): Promise<PairwiseGarmentVerification> {
    return uncertainGarmentVerification('VISUAL_VERIFIER_DISABLED', 'disabled');
  }
}

export class DisabledProductImageVerifier implements ProductImageVerifier {
  readonly ready = false;
  async verify(): Promise<ProductImageVerification> {
    return uncertainProductVerification('PRODUCT_IMAGE_VERIFIER_DISABLED');
  }
}

async function assetDataUrl(asset: GarmentImageAsset): Promise<string> {
  if (!asset.storagePath && /^https?:\/\//i.test(asset.imageUrl)) return asset.imageUrl;
  if (!asset.storagePath) throw new Error(`Asset ${asset.assetId} has no readable source.`);
  const bytes = await fs.readFile(asset.storagePath);
  return `data:${asset.mimeType};base64,${bytes.toString('base64')}`;
}

function parseOutputJson(response: unknown): unknown {
  const value = response as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
  const text = value.output_text ?? value.output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? '').join('');
  if (!text) throw new Error('Visual verifier returned no structured output.');
  return JSON.parse(text);
}

const GARMENT_IDENTITY_FEATURES = [
  'color',
  'pattern_family',
  'category',
  'sleeve_length',
  'neckline_family',
  'texture_family',
  'length',
  'silhouette',
  'fit',
  'general_shape',
  'pattern_placement',
  'print_placement',
  'logo_placement',
  'pocket_geometry',
  'drawstring_construction',
  'closure_layout',
  'button_layout',
  'zipper_details',
  'unique_decoration',
  'stitching_layout',
  'waistband_construction',
  'hem_construction',
  'cuff_construction',
  'unique_texture_detail',
  'distinctive_hardware',
] as const satisfies readonly GarmentIdentityFeature[];

function parsePairwiseVerification(value: unknown, model: string): PairwiseGarmentVerification {
  if (!value || typeof value !== 'object') throw new Error('Pairwise verifier returned a non-object.');
  const record = value as Record<string, unknown>;
  if (!['same', 'different', 'uncertain'].includes(String(record.verdict))) {
    throw new Error('Pairwise verifier returned an invalid verdict.');
  }
  if (!CANONICAL_COLORS.includes(record.currentColor as (typeof CANONICAL_COLORS)[number]) ||
      !CANONICAL_SLEEVES.includes(record.currentSleeve as (typeof CANONICAL_SLEEVES)[number]) ||
      !CANONICAL_NECKLINES.includes(record.currentNeckline as (typeof CANONICAL_NECKLINES)[number])) {
    throw new Error('Pairwise verifier omitted its current-garment reading.');
  }
  if (!Array.isArray(record.featureComparisons)) {
    throw new Error('Pairwise verifier omitted feature comparisons.');
  }
  const featureComparisons = record.featureComparisons.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid feature comparison.');
    const comparison = entry as Record<string, unknown>;
    if (!GARMENT_IDENTITY_FEATURES.includes(comparison.feature as GarmentIdentityFeature)) {
      throw new Error('Unknown garment identity feature.');
    }
    if (!['visible', 'partial', 'not_visible'].includes(String(comparison.currentVisibility)) ||
        !['visible', 'partial', 'not_visible'].includes(String(comparison.referenceVisibility)) ||
        !['same', 'different', 'unknown'].includes(String(comparison.relation)) ||
        !['weak', 'medium', 'strong'].includes(String(comparison.discriminativeStrength)) ||
        typeof comparison.note !== 'string') {
      throw new Error('Invalid garment feature evidence.');
    }
    return {
      feature: comparison.feature as GarmentIdentityFeature,
      currentVisibility: comparison.currentVisibility as 'visible' | 'partial' | 'not_visible',
      referenceVisibility: comparison.referenceVisibility as 'visible' | 'partial' | 'not_visible',
      relation: comparison.relation as 'same' | 'different' | 'unknown',
      discriminativeStrength: comparison.discriminativeStrength as 'weak' | 'medium' | 'strong',
      note: comparison.note,
    };
  });
  return {
    verdict: record.verdict as PairwiseGarmentVerification['verdict'],
    confidence: clamp(Number(record.confidence)),
    currentColor: canonicalizeColor(String(record.currentColor ?? 'unknown')),
    currentSleeve: canonicalizeSleeve(String(record.currentSleeve ?? 'unknown')),
    currentNeckline: canonicalizeNeckline(String(record.currentNeckline ?? 'unknown')),
    featureComparisons,
    occlusions: safeStrings(record.occlusions),
    jointlyVisibleEvidence: safeStrings(record.jointlyVisibleEvidence),
    model,
  };
}

function uncertainGarmentVerification(reason: string, model: string): PairwiseGarmentVerification {
  return {
    verdict: 'uncertain', confidence: 0,
    currentColor: 'unknown', currentSleeve: 'unknown', currentNeckline: 'unknown', featureComparisons: [],
    occlusions: [reason], jointlyVisibleEvidence: [], model,
  };
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

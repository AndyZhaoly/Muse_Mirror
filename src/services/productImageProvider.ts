import fs from 'node:fs/promises';
import OpenAI, { toFile } from 'openai';
import type { AmbientGarmentSlot, GarmentImageAsset } from '../domain/ambientCapture.js';
import type { GarmentImageAssetService } from './garmentImageAssetService.js';

export interface ProductImageGenerationInput {
  userId: string;
  closetItemId: string;
  sourceAppearance: GarmentImageAsset;
  item: {
    category: string;
    color: string;
    slot: AmbientGarmentSlot;
    description: string;
  };
}

export interface ProductImageGenerationResult {
  asset: GarmentImageAsset;
  provider: string;
  model: string;
}

export interface ProductImageProvider {
  readonly ready: boolean;
  createCanonicalProductImage(input: ProductImageGenerationInput): Promise<ProductImageGenerationResult>;
}

export class OpenAIProductImageProvider implements ProductImageProvider {
  readonly ready: boolean;

  constructor(
    private readonly options: {
      model: string;
      quality: 'low' | 'medium' | 'high';
      size: string;
      assetService: GarmentImageAssetService;
      apiKey?: string;
      imageEdit?: (request: unknown) => Promise<unknown>;
    },
  ) {
    this.ready = Boolean(options.imageEdit || options.apiKey);
  }

  async createCanonicalProductImage(input: ProductImageGenerationInput): Promise<ProductImageGenerationResult> {
    if (!this.ready || !input.sourceAppearance.storagePath) throw new Error('PRODUCT_IMAGE_PROVIDER_UNAVAILABLE');
    const bytes = await fs.readFile(input.sourceAppearance.storagePath);
    const image = await toFile(bytes, `source.${extensionForMime(input.sourceAppearance.mimeType)}`, {
      type: input.sourceAppearance.mimeType,
    });
    const request = {
      model: this.options.model,
      image,
      prompt: productEditPrompt(input),
      size: this.options.size,
      quality: this.options.quality,
      output_format: 'webp',
    };
    const response = this.options.imageEdit
      ? await this.options.imageEdit(request)
      : await new OpenAI({ apiKey: this.options.apiKey }).images.edit(request as never);
    const outputBytes = await responseImageBytes(response);
    const asset = await this.options.assetService.storeProductImage({
      userId: input.userId,
      closetItemId: input.closetItemId,
      sourceAsset: input.sourceAppearance,
      bytes: outputBytes,
      mimeType: 'image/webp',
    });
    return { asset, provider: 'openai', model: this.options.model };
  }
}

export class DisabledProductImageProvider implements ProductImageProvider {
  readonly ready = false;
  async createCanonicalProductImage(): Promise<ProductImageGenerationResult> {
    throw new Error('PRODUCT_IMAGE_PROVIDER_DISABLED');
  }
}

export function productEditPrompt(input: ProductImageGenerationInput): string {
  return [
    'Create a clean catalog product photograph of the exact same garment shown in the source image.',
    `The source is a real ${input.item.color} ${input.item.category} garment crop.`,
    `Observed description: ${input.item.description}.`,
    'Remove the wearer, skin, hands, hair, and original background.',
    'Preserve the same garment identity and every visible identity detail.',
    'Do not change the main color, pattern placement, neckline, sleeve length, pockets, closures, buttons, zippers, garment length, silhouette, stitching, or visible texture.',
    'Do not add a logo. Do not remove a real visible logo. Do not invent complex details in occluded areas.',
    'Show one complete garment, centered, front-facing, on a neutral light studio background.',
    'No person, body part, mannequin, hanger, accessory, text, label, watermark, brand, or price.',
  ].join('\n');
}

async function responseImageBytes(response: unknown): Promise<Buffer> {
  const first = (response as { data?: Array<{ b64_json?: string; url?: string }> }).data?.[0];
  if (first?.b64_json) return Buffer.from(first.b64_json, 'base64');
  if (first?.url) {
    const fetched = await fetch(first.url);
    if (!fetched.ok) throw new Error(`PRODUCT_IMAGE_DOWNLOAD_HTTP_${fetched.status}`);
    return Buffer.from(await fetched.arrayBuffer());
  }
  throw new Error('PRODUCT_IMAGE_PROVIDER_EMPTY_OUTPUT');
}

function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

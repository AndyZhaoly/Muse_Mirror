import OpenAI, { toFile } from 'openai';
import type { StoredImage } from '../types.js';
import { ImageStore } from './imageStore.js';
import type { GeneratedImagePayload } from './geminiImageService.js';

type ImageQuality = 'low' | 'medium' | 'high';

const SIZE_BY_ASPECT_RATIO: Record<string, string> = {
  '1:1': '1024x1024',
  '3:4': '960x1280',
  '4:5': '1024x1280',
  '9:16': '1024x1824',
  '16:9': '1824x1024',
};

export class OpenAIImageService {
  constructor(
    private readonly options: {
      model: string;
      imageStore: ImageStore;
      defaultQuality?: ImageQuality;
    },
  ) {}

  async generate(
    prompt: string,
    aspectRatio: string,
    sourceImage?: StoredImage,
    options: { quality?: ImageQuality; referenceImages?: StoredImage[] } = {},
  ): Promise<GeneratedImagePayload> {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required for OpenAI image generation.');
    }
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const size = SIZE_BY_ASPECT_RATIO[aspectRatio] ?? '1024x1280';
    const quality = options.quality ?? this.options.defaultQuality ?? 'low';

    if (sourceImage) {
      const images = [sourceImage, ...(options.referenceImages ?? [])].slice(0, 8);
      const files = await Promise.all(
        images.map(async (image, index) => {
          const bytes = await this.options.imageStore.readImageBytes(image);
          return toFile(bytes, `source_${index}.${extensionForMime(image.mimeType)}`, {
            type: image.mimeType,
          });
        }),
      );
      const primary = files[0];
      if (!primary) throw new Error('OpenAI image edit requires at least one source image.');
      const response = await client.images.edit({
        model: this.options.model,
        image: files.length === 1 ? primary : files,
        prompt,
        size: editSizeForAspectRatio(aspectRatio, size),
        quality,
      } as any);
      return imagePayloadFromResponse(response);
    }

    const response = await client.images.generate({
      model: this.options.model,
      prompt,
      size,
      quality,
    } as any);
    return imagePayloadFromResponse(response);
  }
}

async function imagePayloadFromResponse(response: any): Promise<GeneratedImagePayload> {
  const first = response?.data?.[0];
  const base64 = first?.b64_json;
  if (base64) {
    return {
      bytes: Buffer.from(base64, 'base64'),
      mimeType: mimeTypeForOutputFormat(first?.output_format),
      providerText: first?.revised_prompt,
    };
  }
  if (typeof first?.url === 'string' && first.url) {
    const fetched = await fetch(first.url);
    if (!fetched.ok) {
      throw new Error(`OpenAI image URL fetch failed with HTTP ${fetched.status}.`);
    }
    return {
      bytes: Buffer.from(await fetched.arrayBuffer()),
      mimeType: fetched.headers.get('content-type') ?? 'image/png',
      providerText: first?.revised_prompt,
    };
  }
  throw new Error('OpenAI image response did not contain image data.');
}

function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

function editSizeForAspectRatio(aspectRatio: string, generatedSize: string): string {
  if (aspectRatio === '16:9') return '1536x1024';
  if (aspectRatio === '1:1') return '1024x1024';
  if (generatedSize === '1024x1024' || generatedSize === '1536x1024') return generatedSize;
  return '1024x1536';
}

function mimeTypeForOutputFormat(value: unknown): string {
  if (value === 'jpeg') return 'image/jpeg';
  if (value === 'webp') return 'image/webp';
  return 'image/png';
}

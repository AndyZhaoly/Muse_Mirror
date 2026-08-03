import OpenAI from 'openai';
import type { FashionAgentContext, ImageKind, StoredImage } from '../types.js';
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

export interface VisualGenerationPartial {
  imageId: string;
  url: string;
  mimeType: string;
  partialIndex: number;
}

export interface VisualGenerationRequest {
  context: FashionAgentContext;
  prompt: string;
  aspectRatio: string;
  sourceImages: StoredImage[];
  outputKind: Extract<ImageKind, 'ai_concept_item' | 'ai_outfit_visual' | 'ai_try_on'>;
  label: string;
  quality?: ImageQuality;
  partialImages?: number;
  onPartial?: (partial: VisualGenerationPartial) => void;
}

export class OpenAIVisualGenerationService {
  constructor(
    private readonly options: {
      hostModel: string;
      imageStore: ImageStore;
      defaultQuality?: ImageQuality;
      responseCreate?: (request: any) => Promise<any>;
    },
  ) {}

  async generate(request: VisualGenerationRequest): Promise<GeneratedImagePayload> {
    if (!process.env.OPENAI_API_KEY && !this.options.responseCreate) {
      throw new Error('OPENAI_API_KEY is required for OpenAI visual generation.');
    }

    const content: any[] = [{ type: 'input_text', text: request.prompt }];
    for (const image of request.sourceImages.slice(0, 8)) {
      content.push({
        type: 'input_image',
        image_url: await this.dataUrlForImage(image),
      });
    }

    const openaiRequest = {
      model: this.options.hostModel,
      input: [
        {
          role: 'user',
          content,
        },
      ],
      tools: [
        {
          type: 'image_generation',
          partial_images: Math.max(0, Math.min(request.partialImages ?? 1, 3)),
          size: SIZE_BY_ASPECT_RATIO[request.aspectRatio] ?? '1024x1280',
          quality: request.quality ?? this.options.defaultQuality ?? 'low',
        },
      ],
      stream: true,
      store: false,
    };

    const stream = await this.createResponse(openaiRequest);
    return this.consumeImageStream(stream, request);
  }

  private async createResponse(request: any): Promise<any> {
    if (this.options.responseCreate) return this.options.responseCreate(request);
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return client.responses.create(request);
  }

  private async consumeImageStream(
    streamOrResponse: any,
    request: VisualGenerationRequest,
  ): Promise<GeneratedImagePayload> {
    if (!streamOrResponse || typeof streamOrResponse[Symbol.asyncIterator] !== 'function') {
      const finalBase64 = extractImageBase64(streamOrResponse);
      if (!finalBase64) throw new Error('OpenAI image generation response did not contain image data.');
      return {
        bytes: Buffer.from(finalBase64, 'base64'),
        mimeType: 'image/png',
        providerText: streamOrResponse?.output_text,
      };
    }

    let finalResponse: any;
    let fallbackText = '';
    for await (const event of streamOrResponse) {
      if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') {
        fallbackText += event.delta;
      }
      if (event?.type === 'response.image_generation_call.partial_image') {
        const partialBase64 = event.partial_image_b64;
        if (typeof partialBase64 === 'string' && partialBase64) {
          await this.emitPartial(request, partialBase64, Number(event.partial_image_index ?? 0));
        }
      }
      if (
        event?.type === 'response.completed' ||
        event?.type === 'response.incomplete' ||
        event?.type === 'response.failed'
      ) {
        finalResponse = event.response;
      }
    }
    if (!finalResponse && typeof streamOrResponse.finalResponse === 'function') {
      finalResponse = await streamOrResponse.finalResponse();
    }
    const finalBase64 = extractImageBase64(finalResponse);
    if (!finalBase64) {
      throw new Error(fallbackText || 'OpenAI image generation response did not contain image data.');
    }
    return {
      bytes: Buffer.from(finalBase64, 'base64'),
      mimeType: 'image/png',
      providerText: finalResponse?.output_text,
    };
  }

  private async emitPartial(
    request: VisualGenerationRequest,
    partialBase64: string,
    partialIndex: number,
  ): Promise<void> {
    if (!request.onPartial) return;
    const image = await this.options.imageStore.saveTemporary(request.context, {
      kind: request.outputKind,
      bytes: Buffer.from(partialBase64, 'base64'),
      mimeType: 'image/png',
      label: `${request.label} 生成中`,
    });
    request.onPartial({
      imageId: image.id,
      url: image.url ?? image.localPath ?? '',
      mimeType: image.mimeType,
      partialIndex,
    });
  }

  private async dataUrlForImage(image: StoredImage): Promise<string> {
    if (image.url?.startsWith('data:')) return image.url;
    const bytes = await this.options.imageStore.readImageBytes(image);
    return `data:${image.mimeType};base64,${bytes.toString('base64')}`;
  }
}

function extractImageBase64(response: any): string | undefined {
  const output = Array.isArray(response?.output) ? response.output : [];
  const imageCall = output.find((item: any) => item?.type === 'image_generation_call');
  if (typeof imageCall?.result === 'string') return imageCall.result;
  const firstData = response?.data?.[0];
  if (typeof firstData?.b64_json === 'string') return firstData.b64_json;
  return undefined;
}

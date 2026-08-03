import { GoogleGenAI } from '@google/genai';
import type { StoredImage } from '../types.js';
import { ImageStore } from './imageStore.js';

export interface GeneratedImagePayload {
  bytes: Buffer;
  mimeType: string;
  providerText?: string;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export class GeminiImageService {
  constructor(
    private readonly mockTools: boolean,
    private readonly model: string,
    private readonly imageStore: ImageStore,
  ) {}

  async generate(
    prompt: string,
    aspectRatio: string,
    sourceImage?: StoredImage,
  ): Promise<GeneratedImagePayload> {
    if (this.mockTools) return this.mockImage(prompt, aspectRatio, sourceImage);
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is required for real image generation.');
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const parts: Array<
      | { text: string }
      | { inlineData: { mimeType: string; data: string } }
    > = [{ text: prompt }];

    if (sourceImage) {
      const bytes = await this.imageStore.readImageBytes(sourceImage);
      parts.push({
        inlineData: {
          mimeType: sourceImage.mimeType,
          data: bytes.toString('base64'),
        },
      });
    }

    const response = await ai.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts }],
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          aspectRatio,
          imageSize: '1K',
        },
      },
    });

    const responseParts = response.candidates?.[0]?.content?.parts ?? [];
    const imagePart = responseParts.find((part) => part.inlineData?.data);
    if (!imagePart?.inlineData?.data) {
      throw new Error('Gemini response did not contain image data.');
    }
    const providerText = responseParts
      .map((part) => part.text)
      .filter((text): text is string => Boolean(text))
      .join('\n');

    return {
      bytes: Buffer.from(imagePart.inlineData.data, 'base64'),
      mimeType: imagePart.inlineData.mimeType ?? 'image/png',
      providerText: providerText || undefined,
    };
  }

  private mockImage(
    prompt: string,
    aspectRatio: string,
    sourceImage?: StoredImage,
  ): GeneratedImagePayload {
    const summary = prompt.replace(/\s+/g, ' ').slice(0, 260);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ece7df"/><stop offset="1" stop-color="#c9d7e3"/></linearGradient></defs>
<rect width="900" height="1200" fill="url(#g)"/>
<rect x="70" y="80" width="760" height="1040" rx="48" fill="#ffffff" fill-opacity="0.72"/>
<text x="450" y="190" text-anchor="middle" font-family="Arial, sans-serif" font-size="42" fill="#222">AI fashion preview (mock)</text>
<text x="450" y="245" text-anchor="middle" font-family="Arial, sans-serif" font-size="24" fill="#555">aspect ratio: ${escapeXml(aspectRatio)}</text>
<text x="450" y="300" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" fill="#555">source image: ${escapeXml(sourceImage?.id ?? 'none')}</text>
<foreignObject x="130" y="360" width="640" height="600"><div xmlns="http://www.w3.org/1999/xhtml" style="font: 26px Arial; color:#222; line-height:1.5; overflow-wrap:anywhere;">${escapeXml(summary)}</div></foreignObject>
<text x="450" y="1060" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" fill="#555">Mock output — replace with Gemini API</text>
</svg>`;
    return {
      bytes: Buffer.from(svg, 'utf8'),
      mimeType: 'image/svg+xml',
      providerText: 'mock image generated',
    };
  }
}

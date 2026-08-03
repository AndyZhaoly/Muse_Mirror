import fs from 'node:fs/promises';
import OpenAI from 'openai';
import type { VisionProvider } from '../config.js';
import type { StoredImage, VisualObservation } from '../types.js';
import { extractJsonObject } from '../utils/json.js';

export class VisionService {
  constructor(
    private readonly options: {
      provider: VisionProvider;
      openaiModel: string;
      ollamaEndpoint: string;
      ollamaModel: string;
    },
  ) {}

  async analyze(
    image: StoredImage,
    focus: 'overall_outfit' | 'color' | 'silhouette' | 'fit' | 'comparison',
    options: {
      model?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<VisualObservation> {
    if (this.options.provider === 'mock') return this.mockObservation(focus);
    if (this.options.provider === 'ollama') {
      return this.analyzeWithOllama(image, focus, options);
    }
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required for real visual analysis.');
    }
    if (!image.localPath) {
      throw new Error('Real vision MVP currently expects a local image path.');
    }

    const bytes = await fs.readFile(image.localPath);
    const dataUrl = `data:${image.mimeType};base64,${bytes.toString('base64')}`;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.responses.create({
      model: this.options.openaiModel,
      store: false,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `Analyze this outfit image for a fashion styling assistant. Focus: ${focus}.
Return only JSON with this exact shape:
{
  "visibleItems": [{"category":"","description":"","color":"","fit":""}],
  "mainColors": [""],
  "silhouette": "",
  "proportionNotes": [""],
  "formality": "",
  "strengths": [""],
  "issues": [""],
  "uncertainties": [""]
}
Only describe visible clothing and styling relationships. Do not judge the person's body, attractiveness, age, ethnicity, or health. State uncertainty when framing, lighting, occlusion, or angle limits the analysis.`,
            },
            { type: 'input_image', image_url: dataUrl, detail: 'high' },
          ],
        },
      ],
    });

    return extractJsonObject<VisualObservation>(response.output_text);
  }

  private async analyzeWithOllama(
    image: StoredImage,
    focus: 'overall_outfit' | 'color' | 'silhouette' | 'fit' | 'comparison',
    options: {
      model?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<VisualObservation> {
    if (!image.localPath) {
      throw new Error('Ollama vision analysis expects a local image path.');
    }
    const bytes = await fs.readFile(image.localPath);
    const payload = {
      model: options.model ?? this.options.ollamaModel,
      messages: [
        {
          role: 'user',
          content: `Analyze this mirror camera frame for a fashion styling assistant. Focus: ${focus}.
Return only JSON with this exact shape:
{
  "visibleItems": [{"category":"","description":"","color":"","fit":""}],
  "mainColors": [""],
  "silhouette": "",
  "proportionNotes": [""],
  "formality": "",
  "strengths": [""],
  "issues": [""],
  "uncertainties": [""]
}
Only describe visible clothing and styling relationships. Do not judge the person's body, attractiveness, age, ethnicity, or health. If the frame only shows face/upper chest or is blurry/low-light, say that in uncertainties and keep clothing claims conservative.`,
          images: [bytes.toString('base64')],
        },
      ],
      stream: false,
      format: 'json',
      think: false,
      options: {
        temperature: 0,
        num_ctx: 4096,
        num_predict: 700,
      },
    };

    const response = await fetch(
      `${this.options.ollamaEndpoint.replace(/\/+$/, '')}/api/chat`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(options.timeoutMs ?? 180000),
      },
    );
    if (!response.ok) {
      throw new Error(`Ollama vision request failed with HTTP ${response.status}.`);
    }
    const body = (await response.json()) as { message?: { content?: string } };
    return extractJsonObject<VisualObservation>(body.message?.content ?? '');
  }

  private mockObservation(
    focus: 'overall_outfit' | 'color' | 'silhouette' | 'fit' | 'comparison',
  ): VisualObservation {
    return {
      visibleItems: [
        {
          category: 'top',
          description: '白色宽松圆领短袖 T 恤',
          color: 'white',
          fit: 'relaxed',
        },
        {
          category: 'bottom',
          description: '浅蓝直筒牛仔裤',
          color: 'light blue',
          fit: 'straight',
        },
        {
          category: 'shoes',
          description: '白色简洁运动鞋',
          color: 'white',
          fit: 'regular',
        },
      ],
      mainColors: ['white', 'light blue'],
      silhouette: '上身宽松、下身直筒，整体量感较平衡',
      proportionNotes: ['上衣衣长略长，腰线目前不够清晰'],
      formality: 'casual',
      strengths: ['配色干净', '鞋与上衣有颜色呼应'],
      issues:
        focus === 'color'
          ? ['整体颜色安全，但缺少一个小面积完成点']
          : ['视觉重心略低，可通过轻塞前摆或短外套改善'],
      uncertainties: ['mock 观察结果，不代表真实图片分析'],
    };
  }
}

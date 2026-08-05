import type { AppConfig } from '../config.js';
import { ClosetService } from '../services/closetService.js';
import { GeminiImageService } from '../services/geminiImageService.js';
import type { GeneratedImagePayload } from '../services/geminiImageService.js';
import { ImageStore } from '../services/imageStore.js';
import { OpenAIImageService } from '../services/openAiImageService.js';
import {
  OpenAIVisualGenerationService,
  type VisualGenerationRequest,
} from '../services/openAiVisualGenerationService.js';
import { OutfitEvaluatorService } from '../services/outfitEvaluatorService.js';
import { ProductService } from '../services/productService.js';
import { FashionSkillRegistry } from '../services/skillRegistry.js';
import { VisionService } from '../services/visionService.js';
import { WeatherService } from '../services/weatherService.js';
import { JsonUserWardrobeRepository } from '../services/userWardrobeRepository.js';
import type { StoredImage } from '../types.js';

export interface ImageGenerationService {
  generate(
    prompt: string,
    aspectRatio: string,
    sourceImage?: StoredImage,
    options?: { quality?: 'low' | 'medium' | 'high'; referenceImages?: StoredImage[] },
  ): Promise<GeneratedImagePayload>;
}

export interface VisualGenerationService {
  generate(request: VisualGenerationRequest): Promise<GeneratedImagePayload>;
}

export interface ServiceContainer {
  skills: FashionSkillRegistry;
  closet: ClosetService;
  weather: WeatherService;
  products: ProductService;
  evaluator: OutfitEvaluatorService;
  imageStore: ImageStore;
  vision: VisionService;
  imageGeneration: ImageGenerationService;
  visualGeneration: VisualGenerationService;
  wardrobeRepository?: JsonUserWardrobeRepository;
}

export function createServiceContainer(config: AppConfig): ServiceContainer {
  const imageStore = new ImageStore(config.inputDir, config.outputDir);
  return {
    skills: new FashionSkillRegistry(config.skillsDir),
    closet: new ClosetService(config.closetDataPath, config.closetPresentationMetadataPath),
    weather: new WeatherService(config.mockTools),
    products: new ProductService(),
    evaluator: new OutfitEvaluatorService(),
    imageStore,
    vision: new VisionService({
      provider: config.visionProvider,
      openaiModel: config.openaiVisionModel,
      ollamaEndpoint: config.gemma4OllamaEndpoint,
      ollamaModel: config.ollamaVisionModel,
    }),
    imageGeneration:
      config.imageProvider === 'openai'
        ? new OpenAIImageService({
            model: config.openaiImageModel,
            imageStore,
            defaultQuality: 'low',
          })
        : new GeminiImageService(
            config.imageProvider === 'mock' || config.mockTools,
            config.geminiImageModel,
            imageStore,
          ),
    visualGeneration:
      config.imageProvider === 'openai'
        ? new OpenAIVisualGenerationService({
            hostModel: config.openaiImageToolHostModel,
            imageStore,
            defaultQuality: 'low',
          })
        : new GeminiVisualGenerationAdapter(
            new GeminiImageService(
              config.imageProvider === 'mock' || config.mockTools,
              config.geminiImageModel,
              imageStore,
            ),
          ),
    wardrobeRepository: new JsonUserWardrobeRepository(config.ambientWardrobeDataPath),
  };
}

class GeminiVisualGenerationAdapter implements VisualGenerationService {
  constructor(private readonly fallback: ImageGenerationService) {}

  generate(request: VisualGenerationRequest): Promise<GeneratedImagePayload> {
    const [sourceImage, ...referenceImages] = request.sourceImages;
    return this.fallback.generate(request.prompt, request.aspectRatio, sourceImage, {
      quality: request.quality,
      referenceImages,
    });
  }
}

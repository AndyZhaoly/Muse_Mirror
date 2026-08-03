import OpenAI from 'openai';
import type { AppConfig } from '../config.js';

export interface CapabilityReadiness {
  provider: string;
  model?: string;
  configured: boolean;
  verified: boolean;
  ready: boolean;
  lastCheckedAt?: string;
  errorCode?: 'auth' | 'model_access' | 'rate_limit' | 'org_verification' | 'unavailable';
}

export interface ImageCapabilityReadiness {
  provider: string;
  model?: string;
  configured: boolean;
  verified: boolean;
  generationReady: boolean;
  editReady: boolean;
  tryOnAdapterReady: boolean;
  lastCheckedAt?: string;
  errorCode?: CapabilityReadiness['errorCode'];
}

export interface ProviderReadinessStatus {
  runtime: string;
  brain: CapabilityReadiness;
  vision: CapabilityReadiness;
  imageToolHost: CapabilityReadiness;
  image: ImageCapabilityReadiness;
  weather: CapabilityReadiness;
  products: CapabilityReadiness;
}

export class ProviderReadinessCache {
  private cached: ProviderReadinessStatus;
  private inFlight?: Promise<void>;

  constructor(private readonly config: AppConfig) {
    this.cached = initialStatus(config);
  }

  get(): ProviderReadinessStatus {
    return this.cached;
  }

  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refreshInternal().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async refreshInternal(): Promise<void> {
    const next = initialStatus(this.config);
    if (this.config.agentProvider !== 'openai') {
      this.cached = next;
      return;
    }
    if (!process.env.OPENAI_API_KEY) {
      this.cached = next;
      return;
    }
    const checkedAt = new Date().toISOString();
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    next.brain = await verifyModel(client, {
      provider: 'openai',
      model: this.config.openaiAgentModel,
      configured: true,
      checkedAt,
    });
    next.vision = await verifyModel(client, {
      provider: 'openai',
      model: this.config.openaiVisionModel,
      configured: true,
      checkedAt,
    });
    next.imageToolHost = await verifyModel(client, {
      provider: 'openai',
      model: this.config.openaiImageToolHostModel,
      configured: this.config.imageProvider === 'openai',
      checkedAt,
    });
    const image = await verifyModel(client, {
      provider: this.config.imageProvider,
      model: this.config.openaiImageModel,
      configured: this.config.imageProvider === 'openai',
      checkedAt,
    });
    next.image = {
      provider: this.config.imageProvider,
      model: this.config.openaiImageModel,
      configured: this.config.imageProvider === 'openai',
      verified: image.verified,
      generationReady: image.ready,
      editReady: image.ready,
      tryOnAdapterReady: image.ready,
      lastCheckedAt: checkedAt,
      errorCode: image.errorCode,
    };
    this.cached = next;
  }
}

function initialStatus(config: AppConfig): ProviderReadinessStatus {
  const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);
  const now = new Date().toISOString();
  return {
    runtime: config.runtimeProvider,
    brain: {
      provider: config.agentProvider,
      model: config.agentModel,
      configured: config.agentProvider === 'gemma4' || openaiConfigured,
      verified: config.agentProvider === 'gemma4',
      ready: config.agentProvider === 'gemma4' || false,
      lastCheckedAt: now,
      errorCode: config.agentProvider === 'openai' && !openaiConfigured ? 'auth' : undefined,
    },
    vision: {
      provider: config.visionProvider,
      model: config.visionProvider === 'openai' ? config.openaiVisionModel : config.quickVisionModel,
      configured: config.visionProvider !== 'openai' || openaiConfigured,
      verified: config.visionProvider !== 'openai',
      ready: config.visionProvider !== 'openai',
      lastCheckedAt: now,
      errorCode: config.visionProvider === 'openai' && !openaiConfigured ? 'auth' : undefined,
    },
    imageToolHost: {
      provider: config.imageProvider === 'openai' ? 'openai' : config.imageProvider,
      model:
        config.imageProvider === 'openai'
          ? config.openaiImageToolHostModel
          : config.imageProvider === 'gemini'
            ? config.geminiImageModel
            : undefined,
      configured: config.imageProvider !== 'openai' || openaiConfigured,
      verified: config.imageProvider !== 'openai',
      ready: config.imageProvider !== 'openai',
      lastCheckedAt: now,
      errorCode: config.imageProvider === 'openai' && !openaiConfigured ? 'auth' : undefined,
    },
    image: {
      provider: config.imageProvider,
      model: config.imageProvider === 'openai' ? config.openaiImageModel : config.geminiImageModel,
      configured:
        config.imageProvider === 'openai'
          ? openaiConfigured
          : config.imageProvider === 'gemini'
            ? Boolean(process.env.GEMINI_API_KEY)
            : false,
      verified: false,
      generationReady: false,
      editReady: false,
      tryOnAdapterReady: false,
      lastCheckedAt: now,
      errorCode:
        config.imageProvider === 'openai' && !openaiConfigured
          ? 'auth'
          : config.imageProvider === 'gemini' && !process.env.GEMINI_API_KEY
            ? 'auth'
            : undefined,
    },
    weather: {
      provider: config.weatherProvider,
      configured: config.weatherProvider !== 'disabled',
      verified: config.weatherProvider === 'mock' || config.weatherProvider === 'local',
      ready: config.weatherProvider !== 'disabled',
      lastCheckedAt: now,
    },
    products: {
      provider: config.productProvider,
      configured: config.productProvider !== 'disabled',
      verified: false,
      ready: false,
      lastCheckedAt: now,
    },
  };
}

async function verifyModel(
  client: OpenAI,
  args: {
    provider: string;
    model: string;
    configured: boolean;
    checkedAt: string;
  },
): Promise<CapabilityReadiness> {
  if (!args.configured) {
    return {
      provider: args.provider,
      model: args.model,
      configured: false,
      verified: false,
      ready: false,
      lastCheckedAt: args.checkedAt,
      errorCode: 'auth',
    };
  }
  try {
    await client.models.retrieve(args.model);
    return {
      provider: args.provider,
      model: args.model,
      configured: true,
      verified: true,
      ready: true,
      lastCheckedAt: args.checkedAt,
    };
  } catch (error) {
    return {
      provider: args.provider,
      model: args.model,
      configured: true,
      verified: false,
      ready: false,
      lastCheckedAt: args.checkedAt,
      errorCode: readinessErrorCode(error),
    };
  }
}

function readinessErrorCode(error: unknown): CapabilityReadiness['errorCode'] {
  const status = typeof (error as any)?.status === 'number' ? (error as any).status : undefined;
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'model_access';
  if (status === 429) return 'rate_limit';
  return 'unavailable';
}

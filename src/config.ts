import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });
dotenv.config({ path: path.resolve(process.cwd(), '.env.local'), quiet: true });

export type AgentLlmProvider = 'openai' | 'gemma4';
export type VisionProvider = 'mock' | 'openai' | 'ollama';
export type FashionAgentRuntimeProvider = 'muse' | 'legacy';
export type ImageProvider = 'mock' | 'openai' | 'gemini';
export type CapabilityProvider = 'local' | 'mock' | 'disabled';
export type OpenAIReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';
export type SpeechProvider = 'volcengine' | 'disabled';

export interface VoiceConfig {
  asrProvider: SpeechProvider;
  ttsProvider: SpeechProvider;
  volcSpeechAppId: string;
  volcSpeechAppKey: string;
  volcSpeechAccessKey: string;
  volcAsrEndpoint: string;
  volcAsrResourceId: string;
  volcAsrSampleRate: number;
  volcAsrEndWindowMs: number;
  volcTtsEndpoint: string;
  volcTtsResourceId: string;
  volcTtsModel: string;
  volcTtsSpeakerId: string;
  volcTtsSampleRate: number;
}

export interface AppConfig {
  runtimeProvider: FashionAgentRuntimeProvider;
  agentProvider: AgentLlmProvider;
  agentModel: string;
  openaiAgentModel: string;
  openaiVisionModel: string;
  openaiImageToolHostModel: string;
  openaiImageModel: string;
  openaiReasoningEffort: OpenAIReasoningEffort;
  openaiVoiceReasoningEffort: OpenAIReasoningEffort;
  openaiMaxOutputTokens?: number;
  gemma4OllamaEndpoint: string;
  gemma4OllamaModel: string;
  routerModel: string;
  gemma4AutoTunnel: boolean;
  gemma4TunnelLocalPort: number;
  closetDataPath: string;
  closetPresentationMetadataPath: string;
  demo2ProductImageDir: string;
  visionProvider: VisionProvider;
  ollamaVisionModel: string;
  quickVisionModel: string;
  deepVisionModel: string;
  imageProvider: ImageProvider;
  closetProvider: CapabilityProvider;
  weatherProvider: CapabilityProvider;
  productProvider: CapabilityProvider;
  geminiImageModel: string;
  visualCacheTtlMs: number;
  mirrorFrameIntervalMs: number;
  deepVisionReview: boolean;
  mockTools: boolean;
  inputDir: string;
  outputDir: string;
  memoryDataPath: string;
  ambientWardrobeDataPath: string;
  emptySceneThreshold: number;
  emptySceneConfirmations: number;
  emptySceneForceProbeMs: number;
  productImageProvider: 'openai' | 'disabled';
  openaiProductImageModel: string;
  openaiProductImageQuality: 'low' | 'medium' | 'high';
  openaiProductImageSize: string;
  productImageVerifyConfidence: number;
  identityTopK: number;
  identityPairMatchConfidence: number;
  identitySafeSameMinPrior: number;
  identityVetoMinPrior: number;
  identityMultipleSafeMatchMargin: number;
  identityMaxVisualCandidates: number;
  identityBaseNewConfidence: number;
  identityStrongPriorVeto: number;
  identityNewConfidenceCeiling: number;
  identityTraceLimit: number;
  identityStrongContinuityWindowMs: number;
  identityWeakContinuityWindowMs: number;
  identityStrongContinuityWeight: number;
  identityWeakContinuityWeight: number;
  ambientCaptureRetainDiagnostics: boolean;
  ambientCaptureDiagnosticLimit: number;
  skillsDir: string;
  trace: boolean;
  visualQcEnabled: boolean;
  voice: VoiceConfig;
}

export interface EmptySceneConfig {
  threshold: number;
  confirmations: number;
  forceProbeMs: number;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumberEnv(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function loadEmptySceneConfig(env: NodeJS.ProcessEnv = process.env): EmptySceneConfig {
  return {
    threshold: Math.min(1, Math.max(0.001, numberFromEnv(env, 'FASHION_AGENT_EMPTY_SCENE_THRESHOLD', 0.03))),
    confirmations: Math.max(2, Math.round(numberFromEnv(env, 'FASHION_AGENT_EMPTY_SCENE_CONFIRMATIONS', 2))),
    forceProbeMs: Math.max(10_000, Math.round(numberFromEnv(env, 'FASHION_AGENT_EMPTY_SCENE_FORCE_PROBE_MS', 90_000))),
  };
}

function portFromEndpoint(endpoint: string): number | undefined {
  try {
    const url = new URL(endpoint);
    if (!url.port) return undefined;
    const parsed = Number(url.port);
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function providerEnv(value: string | undefined): AgentLlmProvider {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'openai') return 'openai';
  if (normalized === 'gemma' || normalized === 'gemma4' || normalized === 'ollama') {
    return 'gemma4';
  }
  const hasGemmaConfig = Boolean(
    process.env.GEMMA4_OLLAMA_ENDPOINT || process.env.GEMMA4_SSH_HOST,
  );
  return hasGemmaConfig ? 'gemma4' : 'openai';
}

function runtimeProviderEnv(value: string | undefined): FashionAgentRuntimeProvider {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'legacy') return 'legacy';
  return 'muse';
}

function visionProviderEnv(
  value: string | undefined,
  agentProvider: AgentLlmProvider,
  mockTools: boolean,
): VisionProvider {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'openai') return 'openai';
  if (normalized === 'ollama' || normalized === 'qwen' || normalized === 'qwen-vl') {
    return 'ollama';
  }
  if (normalized === 'mock') return 'mock';
  if (agentProvider === 'gemma4') return 'ollama';
  return mockTools ? 'mock' : 'openai';
}

function imageProviderEnv(value: string | undefined, mockTools: boolean): ImageProvider {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'openai') return 'openai';
  if (normalized === 'gemini' || normalized === 'nano-banana') return 'gemini';
  if (normalized === 'mock') return 'mock';
  return mockTools ? 'mock' : 'openai';
}

function capabilityProviderEnv(
  value: string | undefined,
  fallback: CapabilityProvider,
): CapabilityProvider {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'local') return 'local';
  if (normalized === 'mock') return 'mock';
  if (normalized === 'disabled') return 'disabled';
  return fallback;
}

function reasoningEffortEnv(value: string | undefined): OpenAIReasoningEffort {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === 'minimal' ||
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high'
  ) {
    return normalized;
  }
  return 'low';
}

export function modelSupportsMinimalReasoning(model: string): boolean {
  return /^gpt-5(?:-(?:mini|nano))?(?:-\d{4}-\d{2}-\d{2})?$/.test(model.trim());
}

export function resolveOpenAIReasoningEffort(
  model: string,
  requested: OpenAIReasoningEffort,
  fallback: OpenAIReasoningEffort,
): OpenAIReasoningEffort {
  if (requested !== 'minimal' || modelSupportsMinimalReasoning(model)) return requested;
  if (fallback !== 'minimal') return fallback;
  return 'low';
}

function speechProviderEnv(value: string | undefined): SpeechProvider {
  return value?.trim().toLowerCase() === 'volcengine' ? 'volcengine' : 'disabled';
}

function numberFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const value = env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedNumberFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = env[name];
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

export function loadVoiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  return {
    asrProvider: speechProviderEnv(env.FASHION_AGENT_ASR_PROVIDER),
    ttsProvider: speechProviderEnv(env.FASHION_AGENT_TTS_PROVIDER),
    volcSpeechAppId: env.VOLC_SPEECH_APP_ID?.trim() ?? '',
    volcSpeechAppKey: env.VOLC_SPEECH_APP_KEY?.trim() ?? '',
    volcSpeechAccessKey: env.VOLC_SPEECH_ACCESS_KEY?.trim() ?? '',
    volcAsrEndpoint:
      env.VOLC_ASR_ENDPOINT?.trim() ??
      'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel',
    volcAsrResourceId:
      env.VOLC_ASR_RESOURCE_ID?.trim() ?? 'volc.seedasr.sauc.duration',
    volcAsrSampleRate: numberFromEnv(env, 'VOLC_ASR_SAMPLE_RATE', 16000),
    volcAsrEndWindowMs: boundedNumberFromEnv(
      env,
      'VOLC_ASR_END_WINDOW_MS',
      500,
      200,
      2000,
    ),
    volcTtsEndpoint:
      env.VOLC_TTS_ENDPOINT?.trim() ??
      'wss://openspeech.bytedance.com/api/v3/tts/unidirectional/stream',
    volcTtsResourceId: env.VOLC_TTS_RESOURCE_ID?.trim() ?? 'seed-tts-2.0',
    volcTtsModel: env.VOLC_TTS_MODEL?.trim() ?? 'seed-tts-2.0-standard',
    volcTtsSpeakerId: env.VOLC_TTS_SPEAKER_ID?.trim() ?? '',
    volcTtsSampleRate: numberFromEnv(env, 'VOLC_TTS_SAMPLE_RATE', 24000),
  };
}

function firstExistingPath(paths: string[]): string {
  return paths.find((candidate) => fs.existsSync(candidate)) ?? paths[paths.length - 1]!;
}

export function loadConfig(): AppConfig {
  const gemma4OllamaEndpoint =
    process.env.GEMMA4_OLLAMA_ENDPOINT ?? 'http://127.0.0.1:18034';
  const gemma4OllamaModel = process.env.GEMMA4_OLLAMA_MODEL ?? 'gemma4:26b';
  const openaiAgentModel = process.env.OPENAI_AGENT_MODEL ?? 'gpt-5.4';
  const agentProvider = providerEnv(process.env.FASHION_AGENT_LLM_PROVIDER);
  // Real providers are the product default. Mock behavior must always be
  // explicitly enabled so a missing deployment setting cannot fabricate
  // camera observations or generated images.
  const mockTools = boolEnv('FASHION_AGENT_MOCK_TOOLS', false);
  const demo2ProductImageDir = path.resolve(
    process.env.FASHION_AGENT_DEMO2_PRODUCT_IMAGE_DIR ??
      './data/demo2-product-images',
  );
  const closetDataPath = path.resolve(
    process.env.FASHION_AGENT_CLOSET_DATA ??
      firstExistingPath([
        path.resolve('./data/demo2-wardrobe/wardrobe.json'),
        path.resolve('./data/mock-closet.json'),
      ]),
  );
  const closetPresentationMetadataPath = path.resolve(
    process.env.FASHION_AGENT_CLOSET_PRESENTATION_METADATA ??
      firstExistingPath([
        path.resolve('./data/demo2-presentation-metadata.json'),
        path.resolve('./data/mock-presentation-metadata.json'),
      ]),
  );
  const emptyScene = loadEmptySceneConfig();
  const trace = boolEnv('FASHION_AGENT_TRACE', false);

  return {
    runtimeProvider: runtimeProviderEnv(process.env.FASHION_AGENT_RUNTIME),
    agentProvider,
    agentModel: agentProvider === 'gemma4' ? gemma4OllamaModel : openaiAgentModel,
    openaiAgentModel,
    openaiVisionModel: process.env.OPENAI_VISION_MODEL ?? 'gpt-5.4-mini',
    openaiImageToolHostModel:
      process.env.OPENAI_IMAGE_TOOL_HOST_MODEL ?? 'gpt-5.4-mini',
    openaiImageModel: process.env.OPENAI_IMAGE_MODEL ?? 'gpt-image-2',
    openaiReasoningEffort: reasoningEffortEnv(process.env.OPENAI_REASONING_EFFORT),
    openaiVoiceReasoningEffort: reasoningEffortEnv(
      process.env.OPENAI_VOICE_REASONING_EFFORT ?? 'minimal',
    ),
    openaiMaxOutputTokens: optionalNumberEnv('OPENAI_MAX_OUTPUT_TOKENS'),
    gemma4OllamaEndpoint,
    gemma4OllamaModel,
    routerModel: process.env.FASHION_AGENT_ROUTER_MODEL ?? 'gemma3:latest',
    gemma4AutoTunnel: boolEnv('FASHION_AGENT_GEMMA4_AUTO_TUNNEL', true),
    gemma4TunnelLocalPort: numberEnv(
      'GEMMA4_TUNNEL_LOCAL_PORT',
      portFromEndpoint(gemma4OllamaEndpoint) ?? 18034,
    ),
    closetDataPath,
    closetPresentationMetadataPath,
    demo2ProductImageDir,
    visionProvider: visionProviderEnv(
      process.env.FASHION_AGENT_VISION_PROVIDER,
      agentProvider,
      mockTools,
    ),
    ollamaVisionModel:
      process.env.OLLAMA_VISION_MODEL ??
      process.env.GEMMA4_VISION_MODEL ??
      gemma4OllamaModel,
    quickVisionModel:
      process.env.FASHION_AGENT_QUICK_VISION_MODEL ??
      process.env.OLLAMA_QUICK_VISION_MODEL ??
      process.env.GEMMA4_VISION_MODEL ??
      gemma4OllamaModel,
    deepVisionModel:
      process.env.FASHION_AGENT_DEEP_VISION_MODEL ??
      process.env.OLLAMA_DEEP_VISION_MODEL ??
      process.env.OLLAMA_VISION_MODEL ??
      process.env.GEMMA4_VISION_MODEL ??
      gemma4OllamaModel,
    imageProvider: imageProviderEnv(process.env.FASHION_AGENT_IMAGE_PROVIDER, mockTools),
    closetProvider: capabilityProviderEnv(process.env.FASHION_AGENT_CLOSET_PROVIDER, 'local'),
    weatherProvider: capabilityProviderEnv(
      process.env.FASHION_AGENT_WEATHER_PROVIDER,
      mockTools ? 'mock' : 'local',
    ),
    productProvider: capabilityProviderEnv(process.env.FASHION_AGENT_PRODUCT_PROVIDER, 'disabled'),
    geminiImageModel:
      process.env.GEMINI_IMAGE_MODEL ?? 'gemini-3.1-flash-image',
    visualCacheTtlMs: numberEnv('FASHION_AGENT_VISUAL_CACHE_TTL_MS', 10000),
    mirrorFrameIntervalMs: numberEnv('FASHION_AGENT_MIRROR_FRAME_INTERVAL_MS', 6000),
    deepVisionReview: boolEnv('FASHION_AGENT_DEEP_VISION_REVIEW', false),
    mockTools,
    inputDir: path.resolve(process.env.FASHION_AGENT_INPUT_DIR ?? './examples'),
    outputDir: path.resolve(process.env.FASHION_AGENT_OUTPUT_DIR ?? './out'),
    memoryDataPath: path.resolve(process.env.FASHION_AGENT_MEMORY_DATA ?? './out/muse-memory-v1.json'),
    ambientWardrobeDataPath: path.resolve(
      process.env.FASHION_AGENT_AMBIENT_WARDROBE_DATA ?? './out/ambient-wardrobe-v1.json',
    ),
    emptySceneThreshold: emptyScene.threshold,
    emptySceneConfirmations: emptyScene.confirmations,
    emptySceneForceProbeMs: emptyScene.forceProbeMs,
    productImageProvider: process.env.FASHION_AGENT_PRODUCT_IMAGE_PROVIDER === 'openai' ? 'openai' : 'disabled',
    openaiProductImageModel: process.env.OPENAI_PRODUCT_IMAGE_MODEL ?? 'gpt-image-2',
    openaiProductImageQuality: ['low', 'medium', 'high'].includes(process.env.OPENAI_PRODUCT_IMAGE_QUALITY ?? '')
      ? process.env.OPENAI_PRODUCT_IMAGE_QUALITY as 'low' | 'medium' | 'high'
      : 'medium',
    openaiProductImageSize: process.env.OPENAI_PRODUCT_IMAGE_SIZE ?? '1024x1024',
    productImageVerifyConfidence: numberEnv('FASHION_AGENT_PRODUCT_IMAGE_VERIFY_CONFIDENCE', 0.84),
    identityTopK: Math.max(1, Math.round(numberEnv('FASHION_AGENT_IDENTITY_TOP_K', 4))),
    identityPairMatchConfidence: numberEnv('FASHION_AGENT_IDENTITY_PAIR_MATCH_CONFIDENCE', 0.88),
    identitySafeSameMinPrior: numberEnv('FASHION_AGENT_IDENTITY_SAFE_SAME_MIN_PRIOR', 0.55),
    identityVetoMinPrior: numberEnv('FASHION_AGENT_IDENTITY_VETO_MIN_PRIOR', 0.6),
    identityMultipleSafeMatchMargin: numberEnv('FASHION_AGENT_IDENTITY_MULTIPLE_SAFE_MATCH_MARGIN', 0.15),
    identityMaxVisualCandidates: Math.max(1, Math.round(numberEnv('FASHION_AGENT_IDENTITY_MAX_VISUAL_CANDIDATES', 3))),
    identityBaseNewConfidence: numberEnv('FASHION_AGENT_IDENTITY_BASE_NEW_CONFIDENCE', 0.78),
    identityStrongPriorVeto: numberEnv('FASHION_AGENT_IDENTITY_STRONG_PRIOR_VETO', 0.85),
    identityNewConfidenceCeiling: Math.min(
      0.99,
      Math.max(0, numberEnv('FASHION_AGENT_IDENTITY_NEW_CONFIDENCE_CEILING', 0.9)),
    ),
    identityTraceLimit: Math.max(1, Math.round(numberEnv('FASHION_AGENT_IDENTITY_TRACE_LIMIT', 200))),
    identityStrongContinuityWindowMs: numberEnv('FASHION_AGENT_IDENTITY_STRONG_CONTINUITY_WINDOW_MS', 60 * 60 * 1000),
    identityWeakContinuityWindowMs: numberEnv('FASHION_AGENT_IDENTITY_WEAK_CONTINUITY_WINDOW_MS', 12 * 60 * 60 * 1000),
    identityStrongContinuityWeight: numberEnv('FASHION_AGENT_IDENTITY_STRONG_CONTINUITY_WEIGHT', 0.08),
    identityWeakContinuityWeight: numberEnv('FASHION_AGENT_IDENTITY_WEAK_CONTINUITY_WEIGHT', 0.02),
    ambientCaptureRetainDiagnostics: boolEnv('FASHION_AGENT_AMBIENT_CAPTURE_RETAIN_DIAGNOSTICS', trace),
    ambientCaptureDiagnosticLimit: Math.max(1, Math.round(numberEnv('FASHION_AGENT_AMBIENT_CAPTURE_DIAGNOSTIC_LIMIT', 100))),
    skillsDir: path.resolve(process.env.FASHION_AGENT_SKILLS_DIR ?? './skills'),
    trace,
    visualQcEnabled: boolEnv('FASHION_AGENT_VISUAL_QC', true),
    voice: loadVoiceConfig(),
  };
}

export const defaultPermissions = {
  allowVisualAnalysis: false,
  allowAiImageGeneration: false,
  allowPhotoUseForTryOn: false,
  allowPersistentMemory: false,
} as const;

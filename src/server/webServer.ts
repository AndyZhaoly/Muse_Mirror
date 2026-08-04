import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { FashionAgentRuntime } from '../agent/runtime.js';
import { GemmaFashionRuntime } from './gemmaFashionRuntime.js';
import { OpenAIMuseRuntime } from './openAiMuseRuntime.js';
import {
  closeGemma4Tunnel,
  ensureGemma4Endpoint,
} from './gemma4Tunnel.js';
import { ProviderReadinessCache } from './providerReadiness.js';
import { attachVoiceGateway } from './voiceGateway.js';
import { writeSse } from './sse.js';
import { makeId } from '../utils/ids.js';
import { extractPreferenceIntents } from '../runtime/memoryExtractor.js';
import {
  defaultMemoryPolicy,
  JsonMuseMemoryStore,
  memoryFromPreferenceEvent,
} from '../runtime/memoryStore.js';
import type {
  AgentActivity,
  AttachmentInput,
  ContextOverride,
  Conversation,
  ConversationMessage,
  ExplicitPreferenceEvent,
  FashionTurnInput,
  FashionTurnResult,
  MemoryPolicy,
  MemoryUsageDisclosure,
  MemoryValue,
  MirrorFrameInput,
  MirrorFrameResult,
  PerceptionState,
  ResumeFashionTurnInput,
  StylingProfile,
  UiArtifact,
  UserMemory,
} from '../types.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const webDistDir = path.join(rootDir, 'web/dist');
const publicDir = path.join(rootDir, 'public');
const config = loadConfig();
let gemma4EndpointStatus = await ensureGemma4Endpoint(config);
const providerReadiness = new ProviderReadinessCache(config);
const memoryStore = new JsonMuseMemoryStore(config.memoryDataPath);
void providerReadiness.refresh();
const runtime =
  config.agentProvider === 'gemma4'
    ? new GemmaFashionRuntime({ config })
    : config.runtimeProvider === 'legacy'
      ? new FashionAgentRuntime({ config })
      : new OpenAIMuseRuntime({ config });

const port = Number(process.env.PORT ?? process.env.FASHION_AGENT_WEB_PORT ?? 8787);
let voiceGateway: ReturnType<typeof attachVoiceGateway> | undefined;

interface WebTurnRequest extends Omit<FashionTurnInput, 'attachments'> {
  attachments?: AttachmentInput[];
  capturedImageDataUrl?: string;
}

interface WebMirrorFrameRequest extends Omit<MirrorFrameInput, 'attachments'> {
  attachments?: AttachmentInput[];
  capturedImageDataUrl?: string;
}

function jsonResponse(
  res: http.ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sseHeaders(res: http.ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();
}

function textResponse(
  res: http.ServerResponse,
  statusCode: number,
  body: string,
): void {
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > 12 * 1024 * 1024) {
      throw new Error('Request body is too large.');
    }
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function parseDataUrl(dataUrl: string): { bytes: Buffer; mimeType: string } {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) throw new Error('capturedImageDataUrl must be a base64 data URL.');
  const mimeType = match[1] ?? 'image/jpeg';
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
    throw new Error(`Unsupported captured image MIME type: ${mimeType}`);
  }
  return { bytes: Buffer.from(match[2] ?? '', 'base64'), mimeType };
}

function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

async function saveCapturedImage(
  input: { sessionId: string; capturedImageDataUrl?: string | null },
): Promise<AttachmentInput | undefined> {
  if (!input.capturedImageDataUrl) return undefined;
  const { bytes, mimeType } = parseDataUrl(input.capturedImageDataUrl);
  await fs.mkdir(path.join(config.inputDir, 'captured'), { recursive: true });
  const safeSession = input.sessionId.replace(/[^a-z0-9_-]/gi, '_');
  const id = `capture_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const filename = `${safeSession}_${id}.${extensionForMime(mimeType)}`;
  const localPath = path.join(config.inputDir, 'captured', filename);
  await fs.writeFile(localPath, bytes);
  void cleanupCapturedImages(safeSession);
  return {
    id,
    kind: 'user_photo',
    localPath,
    mimeType,
    makeCurrent: true,
    label: 'Captured mirror still',
  };
}

async function cleanupCapturedImages(safeSession: string): Promise<void> {
  try {
    const dir = path.join(config.inputDir, 'captured');
    const entries = await fs.readdir(dir);
    const now = Date.now();
    await Promise.all(
      entries
        .filter((entry) => entry.startsWith(`${safeSession}_capture_`))
        .map(async (entry) => {
          const filePath = path.join(dir, entry);
          const stat = await fs.stat(filePath);
          if (now - stat.mtimeMs > 5 * 60 * 1000) await fs.unlink(filePath);
        }),
    );
  } catch {
    // Temporary mirror frame cleanup is best-effort.
  }
}

function isWithin(baseDir: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(baseDir), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function artifactUrlToWeb(url: string): string {
  if (!url) return url;
  if (url.startsWith('./public/')) return `/agent-assets/${url.slice('./public/'.length)}`;
  if (url.startsWith('public/')) return `/agent-assets/${url.slice('public/'.length)}`;
  if (url.startsWith('./out/')) return `/generated/${path.basename(url)}`;
  if (path.isAbsolute(url) && isWithin(config.outputDir, url)) {
    return `/generated/${path.basename(url)}`;
  }
  if (path.isAbsolute(url) && isWithin(config.demo2ProductImageDir, url)) {
    return `/demo2-product-images/${path.basename(url)}`;
  }
  return url;
}

function normalizeArtifact(artifact: UiArtifact): UiArtifact {
  if (artifact.type === 'image') {
    return { ...artifact, url: artifactUrlToWeb(artifact.url) };
  }
  if (artifact.type === 'item_grid') {
    return {
      ...artifact,
      items: artifact.items.map((item) => ({
        ...item,
        imageUrl: artifactUrlToWeb(item.imageUrl),
      })),
    };
  }
  if (artifact.type === 'product_cards') {
    return {
      ...artifact,
      products: artifact.products.map((product) => ({
        ...product,
        imageUrl: artifactUrlToWeb(product.imageUrl),
      })),
    };
  }
  if (artifact.type === 'item_visual') {
    return {
      ...artifact,
      imageUrl: artifactUrlToWeb(artifact.imageUrl),
    };
  }
  if (artifact.type === 'item_collection') {
    return {
      ...artifact,
      items: artifact.items.map((item) => ({
        ...item,
        imageUrl: artifactUrlToWeb(item.imageUrl),
      })),
    };
  }
  if (artifact.type === 'look_board') {
    return {
      ...artifact,
      hero: {
        ...artifact.hero,
        imageUrl: artifactUrlToWeb(artifact.hero.imageUrl),
      },
      items: artifact.items.map((item) => ({
        ...item,
        imageUrl: artifactUrlToWeb(item.imageUrl),
      })),
    };
  }
  return artifact;
}

function normalizeResult(result: FashionTurnResult): FashionTurnResult {
  return {
    ...result,
    artifacts: result.artifacts.map(normalizeArtifact),
  } as FashionTurnResult;
}

function normalizeMemoryPolicy(input?: Partial<MemoryPolicy>, temporary?: boolean): MemoryPolicy {
  if (temporary) {
    return {
      usePersistentMemories: false,
      referencePastChats: false,
      allowExplicitMemoryWrites: false,
    };
  }
  return {
    ...defaultMemoryPolicy(),
    ...input,
  };
}

function stylingOverrideFromOverrides(
  overrides: ContextOverride[],
): FashionTurnInput['stylingProfileOverride'] | undefined {
  const next: FashionTurnInput['stylingProfileOverride'] = { scope: 'session' };
  for (const override of overrides) {
    const value = override.value as any;
    if (!value || typeof value !== 'object') continue;
    if (value.namespace === 'style_preference' && value.key === 'recommendation_scope') {
      const scope = Array.isArray(value.values) ? value.values[0] : undefined;
      if (scope === 'neutral_core' || scope === 'menswear_inclusive' || scope === 'womenswear_inclusive' || scope === 'all') {
        next.recommendationScope = scope;
        next.scope = override.scope === 'turn' ? 'turn' : 'session';
      }
    }
    if (value.namespace === 'style_preference' && value.key === 'expression_intensity') {
      const intensity = Array.isArray(value.values) ? value.values[0] : undefined;
      if (intensity === 'restrained' || intensity === 'balanced' || intensity === 'bold') {
        next.expressionIntensity = intensity;
        next.scope = override.scope === 'turn' ? 'turn' : 'session';
      }
    }
    if (value.namespace === 'style_preference' && value.key === 'style_tone') {
      const tone = Array.isArray(value.values) ? value.values[0] : undefined;
      if (tone === 'crisp' || tone === 'soft' || tone === 'relaxed' || tone === 'minimal' || tone === 'dramatic') {
        next.styleTone = tone;
        next.scope = override.scope === 'turn' ? 'turn' : 'session';
      }
    }
  }
  return next.recommendationScope || next.expressionIntensity || next.styleTone ? next : undefined;
}

function mergeStylingOverrides(
  fromMemory: FashionTurnInput['stylingProfileOverride'] | undefined,
  fromInput: FashionTurnInput['stylingProfileOverride'] | undefined,
): FashionTurnInput['stylingProfileOverride'] | undefined {
  if (!fromMemory) return fromInput;
  if (!fromInput) return fromMemory;
  return {
    ...fromMemory,
    ...fromInput,
    scope: fromInput.scope ?? fromMemory.scope,
  };
}

function isTemporaryConversation(input: WebTurnRequest): boolean {
  return Boolean(input.temporary || input.conversationId?.startsWith('temp_'));
}

async function prepareTurnInput(input: WebTurnRequest): Promise<{
  input: WebTurnRequest;
  conversation?: Conversation;
  userMessage?: ConversationMessage;
  memoryPolicy: MemoryPolicy;
}> {
  const temporary = isTemporaryConversation(input);
  const memoryPolicy = normalizeMemoryPolicy(input.memoryPolicy, temporary);
  const conversation = await memoryStore.ensureConversation({
    userId: input.userId,
    conversationId: input.conversationId,
    temporary,
  });
  const userMessage = await memoryStore.appendMessage({
    userId: input.userId,
    conversationId: conversation.id,
    role: 'user',
    content: input.message,
    temporary,
  });
  const personalization = await memoryStore.buildPersonalizationContext(
    input.userId,
    conversation.id,
    memoryPolicy,
  );
  const memoryStylingOverride = stylingOverrideFromOverrides(personalization.overrides);
  return {
    conversation,
    userMessage,
    memoryPolicy,
    input: {
      ...input,
      conversationId: conversation.id,
      temporary,
      memoryPolicy,
      personalizationContext: personalization.context,
      memoryUsage: personalization.usage,
      stylingProfileOverride: mergeStylingOverrides(memoryStylingOverride, input.stylingProfileOverride),
    },
  };
}

async function finalizeTurnMemory(args: {
  input: WebTurnRequest;
  result: FashionTurnResult;
  conversation?: Conversation;
  userMessage?: ConversationMessage;
  memoryPolicy: MemoryPolicy;
}): Promise<FashionTurnResult> {
  const { input, result, conversation, userMessage, memoryPolicy } = args;
  if (!conversation || !userMessage || conversation.temporary || input.temporary) return result;
  const assistantText = result.status === 'completed'
    ? result.text
    : '这个操作需要你的确认。';
  await memoryStore.appendMessage({
    userId: input.userId,
    conversationId: conversation.id,
    role: 'assistant',
    content: assistantText,
  });
  const extraction = extractPreferenceIntents({
    userId: input.userId,
    conversationId: conversation.id,
    messageId: userMessage.id,
    userMessage: input.message,
    trustedUiEvents: input.preferenceUiEvents,
  });
  await memoryStore.addContextOverrides(extraction.overrides);
  const pendingEvents: ExplicitPreferenceEvent[] = [];
  if (memoryPolicy.allowExplicitMemoryWrites) {
    for (const event of extraction.events) {
      if (event.intent.operation === 'do_not_remember') continue;
      if (event.intent.durabilityIntent !== 'persistent') continue;
      if (event.intent.memoryAuthorization === 'explicit') {
        await memoryStore.createMemory({
          userId: input.userId,
          memory: memoryFromPreferenceEvent(event),
          actor: 'extractor',
        });
        event.status = 'applied';
      } else if (event.intent.memoryAuthorization === 'implicit_durable_statement') {
        pendingEvents.push(event);
      }
    }
  }
  await memoryStore.addPreferenceEvents(extraction.events);
  if (result.status !== 'completed') return result;
  return {
    ...result,
    state: {
      ...result.state,
      memoryUsage: input.memoryUsage as MemoryUsageDisclosure[] | undefined,
      pendingMemoryCandidates: pendingEvents,
    },
  };
}

async function handleTurn(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  await ensureRuntimeReady();
  const input = (await readJson(req)) as WebTurnRequest;
  const prepared = await prepareTurnInput(input);
  const captured = await saveCapturedImage(input);
  const attachments = [...(input.attachments ?? []), ...(captured ? [captured] : [])];
  const result = await runtime.runTurn({ ...prepared.input, attachments });
  const finalized = await finalizeTurnMemory({
    input: prepared.input,
    result,
    conversation: prepared.conversation,
    userMessage: prepared.userMessage,
    memoryPolicy: prepared.memoryPolicy,
  });
  jsonResponse(res, 200, normalizeResult(finalized));
}

async function handleTurnStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const requestId = makeId('stream');
  const startedAt = performance.now();
  sseHeaders(res);
  try {
    const input = (await readJson(req)) as WebTurnRequest;
    await ensureRuntimeReady();
    const prepared = await prepareTurnInput(input);
    const captured = await saveCapturedImage(input);
    const attachments = [...(input.attachments ?? []), ...(captured ? [captured] : [])];
    const result = await runtime.runTurn({
      ...prepared.input,
      attachments,
      onActivity: (activity: AgentActivity) => {
        writeSse(res, 'activity', activity);
      },
      onDelta: (text: string) => {
        writeSse(res, 'delta', { text });
      },
      onCommentary: (text: string) => {
        writeSse(res, 'commentary', { text });
      },
      onArtifact: (artifact: UiArtifact) => {
        writeSse(res, 'artifact', normalizeArtifact(artifact));
      },
    });
    const memoryStartedAt = performance.now();
    const finalized = await finalizeTurnMemory({
      input: prepared.input,
      result,
      conversation: prepared.conversation,
      userMessage: prepared.userMessage,
      memoryPolicy: prepared.memoryPolicy,
    });
    traceWebTiming(requestId, 'memory_finalize_completed', startedAt, {
      memoryElapsedMs: Math.round(performance.now() - memoryStartedAt),
    });
    writeSse(res, 'result', normalizeResult(finalized));
    res.end();
    traceWebTiming(requestId, 'turn_completed', startedAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected server error.';
    writeSse(res, 'error', { error: message });
    res.end();
  }
}

function traceWebTiming(
  requestId: string,
  event: string,
  startedAt: number,
  detail: Record<string, unknown> = {},
): void {
  if (!config.trace) return;
  console.info(
    `[MuseTiming] ${JSON.stringify({
      requestId,
      event,
      elapsedMs: Math.round(performance.now() - startedAt),
      ...detail,
    })}`,
  );
}

async function handleConversations(
  req: http.IncomingMessage,
  url: URL,
  res: http.ServerResponse,
): Promise<void> {
  const userId = url.searchParams.get('userId') ?? 'investor_demo_user';
  const parts = url.pathname.split('/').filter(Boolean);
  const conversationId = parts[2];
  if (req.method === 'GET' && !conversationId) {
    const conversations = await memoryStore.listConversations(userId, {
      includeArchived: url.searchParams.get('includeArchived') === '1',
      query: url.searchParams.get('q') ?? undefined,
    });
    jsonResponse(res, 200, { conversations });
    return;
  }
  if (req.method === 'POST' && !conversationId) {
    const body = (await readJson(req)) as { title?: string; temporary?: boolean; userId?: string };
    const conversation = await memoryStore.ensureConversation({
      userId: body.userId ?? userId,
      title: body.title,
      temporary: body.temporary,
    });
    jsonResponse(res, 200, { conversation });
    return;
  }
  if (req.method === 'GET' && parts[3] === 'messages' && conversationId) {
    const messages = await memoryStore.getMessages(userId, conversationId);
    jsonResponse(res, 200, { messages });
    return;
  }
  if (req.method === 'DELETE' && conversationId) {
    const memoryAction = url.searchParams.get('memoryAction') === 'delete' ? 'delete' : 'keep';
    const result = await memoryStore.deleteConversation({ userId, conversationId, memoryAction });
    jsonResponse(res, 200, result);
    return;
  }
  textResponse(res, 404, 'Not found');
}

async function handleMemories(
  req: http.IncomingMessage,
  url: URL,
  res: http.ServerResponse,
): Promise<void> {
  const userId = url.searchParams.get('userId') ?? 'investor_demo_user';
  const parts = url.pathname.split('/').filter(Boolean);
  const memoryId = parts[2];
  const action = parts[3];
  if (req.method === 'GET' && !memoryId) {
    jsonResponse(res, 200, { memories: await memoryStore.listMemories(userId, true) });
    return;
  }
  if (req.method === 'POST' && !memoryId) {
    const body = (await readJson(req)) as {
      userId?: string;
      value?: MemoryValue;
      validUntil?: string;
    };
    if (!body.value) {
      jsonResponse(res, 400, { error: 'value is required.' });
      return;
    }
    const memory = await memoryStore.createMemory({
      userId: body.userId ?? userId,
      memory: {
        userId: body.userId ?? userId,
        value: body.value,
        explicitness: 'user_requested',
        authorization: 'explicit',
        confidence: 1,
        validUntil: body.validUntil,
        source: { type: 'settings', settingsVersion: 'muse_memory_v1' },
      },
      actor: 'user',
    });
    jsonResponse(res, 200, { memory });
    return;
  }
  if (req.method === 'PATCH' && memoryId) {
    const body = await readJson(req);
    const memory = await memoryStore.updateMemory(userId, memoryId, body, 'user');
    jsonResponse(res, memory ? 200 : 404, memory ? { memory } : { error: 'Memory not found.' });
    return;
  }
  if (req.method === 'DELETE' && memoryId) {
    const memory = await memoryStore.updateMemory(userId, memoryId, { status: 'deleted' }, 'user');
    jsonResponse(res, memory ? 200 : 404, memory ? { memory } : { error: 'Memory not found.' });
    return;
  }
  if (req.method === 'POST' && memoryId && action === 'pause') {
    const memory = await memoryStore.updateMemory(userId, memoryId, { status: 'paused' }, 'user');
    jsonResponse(res, memory ? 200 : 404, memory ? { memory } : { error: 'Memory not found.' });
    return;
  }
  if (req.method === 'POST' && memoryId && action === 'restore') {
    const memory = await memoryStore.updateMemory(userId, memoryId, { status: 'active' }, 'user');
    jsonResponse(res, memory ? 200 : 404, memory ? { memory } : { error: 'Memory not found.' });
    return;
  }
  textResponse(res, 404, 'Not found');
}

async function handleMemoryCandidates(
  req: http.IncomingMessage,
  url: URL,
  res: http.ServerResponse,
): Promise<void> {
  const userId = url.searchParams.get('userId') ?? 'investor_demo_user';
  const parts = url.pathname.split('/').filter(Boolean);
  const candidateId = parts[2];
  const action = parts[3];
  if (req.method === 'GET') {
    jsonResponse(res, 200, { candidates: await memoryStore.listPreferenceEvents(userId, 'needs_confirmation') });
    return;
  }
  if (req.method === 'POST' && candidateId && action === 'confirm') {
    const event = await memoryStore.updatePreferenceEvent(userId, candidateId, 'applied');
    if (!event) {
      jsonResponse(res, 404, { error: 'Candidate not found.' });
      return;
    }
    const memory = await memoryStore.createMemory({
      userId,
      memory: memoryFromPreferenceEvent(event),
      actor: 'user',
    });
    jsonResponse(res, 200, { event, memory });
    return;
  }
  if (req.method === 'POST' && candidateId && action === 'dismiss') {
    const event = await memoryStore.updatePreferenceEvent(userId, candidateId, 'dismissed');
    jsonResponse(res, event ? 200 : 404, event ? { event } : { error: 'Candidate not found.' });
    return;
  }
  textResponse(res, 404, 'Not found');
}

async function handleContextOverrides(
  req: http.IncomingMessage,
  url: URL,
  res: http.ServerResponse,
): Promise<void> {
  const userId = url.searchParams.get('userId') ?? 'investor_demo_user';
  if (req.method === 'GET') {
    const conversationId = url.searchParams.get('conversationId') ?? undefined;
    jsonResponse(res, 200, { overrides: await memoryStore.listContextOverrides(userId, conversationId) });
    return;
  }
  if (req.method === 'POST') {
    const body = await readJson(req);
    const overrides = await memoryStore.addContextOverrides([body]);
    jsonResponse(res, 200, { override: overrides[0] });
    return;
  }
  if (req.method === 'PATCH') {
    const parts = url.pathname.split('/').filter(Boolean);
    const overrideId = parts[2];
    if (!overrideId) {
      jsonResponse(res, 400, { error: 'overrideId is required.' });
      return;
    }
    const override = await memoryStore.updateContextOverride(userId, overrideId, await readJson(req));
    jsonResponse(res, override ? 200 : 404, override ? { override } : { error: 'Override not found.' });
    return;
  }
  if (req.method === 'DELETE') {
    const parts = url.pathname.split('/').filter(Boolean);
    const overrideId = parts[2];
    if (!overrideId) {
      jsonResponse(res, 400, { error: 'overrideId is required.' });
      return;
    }
    jsonResponse(res, 200, { deleted: await memoryStore.deleteContextOverride(userId, overrideId) });
    return;
  }
  textResponse(res, 404, 'Not found');
}

async function handleMirrorFrame(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const input = (await readJson(req)) as WebMirrorFrameRequest;
  const captured = await saveCapturedImage(input);
  const attachments = [...(input.attachments ?? []), ...(captured ? [captured] : [])];
  if ('cacheMirrorFrame' in runtime && typeof runtime.cacheMirrorFrame === 'function') {
    const result = runtime.cacheMirrorFrame({ ...input, attachments }) as MirrorFrameResult;
    jsonResponse(res, 200, result);
    return;
  }
  jsonResponse(res, 200, { ok: true, status: 'skipped' } satisfies MirrorFrameResult);
}

function handlePerceptionStatus(
  url: URL,
  res: http.ServerResponse,
): void {
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) {
    jsonResponse(res, 400, { error: 'sessionId is required.' });
    return;
  }
  if ('getPerceptionStatus' in runtime && typeof runtime.getPerceptionStatus === 'function') {
    const perception = runtime.getPerceptionStatus(sessionId) as PerceptionState;
    jsonResponse(res, 200, { ok: true, perception });
    return;
  }
  jsonResponse(res, 200, {
    ok: true,
    perception: {
      cameraActive: false,
      status: 'no_camera',
      failureReason: 'no_frame',
    } satisfies PerceptionState,
  });
}

async function ensureRuntimeReady(): Promise<void> {
  if (config.agentProvider !== 'gemma4') return;
  gemma4EndpointStatus = await ensureGemma4Endpoint(config);
  if (!gemma4EndpointStatus.ready) {
    throw new Error('Muse 暂时不可用，请稍后重试。');
  }
}

async function handleResume(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const input = (await readJson(req)) as ResumeFashionTurnInput;
  const result = await runtime.resumeTurn(input);
  jsonResponse(res, 200, normalizeResult(result));
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

async function serveFile(
  res: http.ServerResponse,
  baseDir: string,
  requestPath: string,
  fallbackToIndex = false,
  headOnly = false,
): Promise<void> {
  const cleanPath = decodeURIComponent(requestPath.replace(/^\/+/, ''));
  let filePath = path.resolve(baseDir, cleanPath || 'index.html');
  if (!isWithin(baseDir, filePath) && filePath !== path.resolve(baseDir)) {
    textResponse(res, 403, 'Forbidden');
    return;
  }

  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    if (!fallbackToIndex) {
      textResponse(res, 404, 'Not found');
      return;
    }
    filePath = path.join(baseDir, 'index.html');
  }

  res.writeHead(200, {
    'content-type': contentTypeFor(filePath),
    'cache-control': filePath.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
  });
  if (headOnly) {
    res.end();
    return;
  }
  createReadStream(filePath).pipe(res);
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/fashion/status') {
      if (config.agentProvider === 'gemma4') {
        gemma4EndpointStatus = await ensureGemma4Endpoint(config);
      } else if (url.searchParams.get('refresh') === '1') {
        await providerReadiness.refresh();
      }
      const capabilities = providerReadiness.get();
      jsonResponse(res, 200, {
        ok: true,
        runtime: config.runtimeProvider,
        provider: config.agentProvider,
        model: config.agentModel,
        mockTools: config.mockTools,
        visionProvider: config.visionProvider,
        visionModel:
          config.visionProvider === 'openai'
            ? config.openaiVisionModel
            : config.ollamaVisionModel,
        quickVisionModel: config.quickVisionModel,
        deepVisionModel: config.deepVisionModel,
        mirrorFrameIntervalMs: config.mirrorFrameIntervalMs,
        closetDataPath: config.closetDataPath,
        closetPresentationMetadataPath: config.closetPresentationMetadataPath,
        agentReady:
          config.agentProvider === 'gemma4'
            ? gemma4EndpointStatus.ready
            : capabilities.brain.ready,
        capabilities,
        transport: gemma4EndpointStatus.transport,
        message: gemma4EndpointStatus.message,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/voice/status') {
      jsonResponse(res, 200, { ok: true, ...voiceGateway?.getStatus() });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/fashion/perception/status') {
      handlePerceptionStatus(url, res);
      return;
    }
    if (url.pathname === '/api/conversations' || url.pathname.startsWith('/api/conversations/')) {
      await handleConversations(req, url, res);
      return;
    }
    if (url.pathname === '/api/memories' || url.pathname.startsWith('/api/memories/')) {
      await handleMemories(req, url, res);
      return;
    }
    if (url.pathname === '/api/memory-candidates' || url.pathname.startsWith('/api/memory-candidates/')) {
      await handleMemoryCandidates(req, url, res);
      return;
    }
    if (url.pathname === '/api/context-overrides' || url.pathname.startsWith('/api/context-overrides/')) {
      await handleContextOverrides(req, url, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/fashion/turn') {
      await handleTurn(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/fashion/turn/stream') {
      await handleTurnStream(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/fashion/mirror/frame') {
      await handleMirrorFrame(req, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/fashion/resume') {
      await handleResume(req, res);
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/agent-assets/')) {
      await serveFile(res, publicDir, url.pathname.slice('/agent-assets/'.length), false, req.method === 'HEAD');
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/generated/')) {
      await serveFile(res, config.outputDir, url.pathname.slice('/generated/'.length), false, req.method === 'HEAD');
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/demo2-product-images/')) {
      await serveFile(res, config.demo2ProductImageDir, url.pathname.slice('/demo2-product-images/'.length), false, req.method === 'HEAD');
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveFile(res, webDistDir, url.pathname, true, req.method === 'HEAD');
      return;
    }
    textResponse(res, 405, 'Method not allowed');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected server error.';
    jsonResponse(res, 500, { error: message });
  }
}

const server = http.createServer((req, res) => {
  void route(req, res);
});
voiceGateway = attachVoiceGateway(server, { config: config.voice });

server.listen(port, () => {
  console.log(
    `Fashion Agent demo server listening on http://localhost:${port} (${config.agentProvider}:${config.agentModel})`,
  );
});

function shutdown(): void {
  voiceGateway?.close();
  closeGemma4Tunnel();
  void runtime.close();
  void memoryStore.close();
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 750).unref();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

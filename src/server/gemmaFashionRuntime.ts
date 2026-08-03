import type { AppConfig } from '../config.js';
import { defaultPermissions, loadConfig } from '../config.js';
import { createServiceContainer, type ServiceContainer } from '../runtime/serviceContainer.js';
import {
  InMemorySessionStateStore,
  type SessionStateStore,
} from '../runtime/stateStore.js';
import type {
  AgentActivity,
  AgentGrounding,
  ClosetRecommendationResult,
  ClosetItem,
  FashionAgentContext,
  FashionTurnInput,
  FashionTurnResult,
  MirrorFrameInput,
  MirrorFrameResult,
  MuseDecisionSummary,
  OutfitItem,
  OutfitCandidate,
  PerceptionState,
	  ProductItem,
	  ExpressionIntensity,
	  PreferenceMemoryScope,
	  RecommendationScope,
	  ResumeFashionTurnInput,
	  PresentationPreference,
	  StylingProfile,
  StyleTone,
  TurnPermissions,
  UiArtifact,
  VisualObservation,
  WeatherResult,
} from '../types.js';
import { makeId } from '../utils/ids.js';
import { extractJsonObject } from '../utils/json.js';
import {
  extractPartialJsonStringField,
  StreamingJsonTextExtractor,
} from '../utils/streamingJsonText.js';
import { buildSystemInstructions } from '../agent/systemInstructions.js';
import { buildOutfitVisualPrompt } from '../services/imagePrompts.js';
import type { ClosetLookCandidate } from '../services/closetService.js';
import {
  PRESENTATION_POLICY_VERSION,
  stylingProfileSnapshotId,
} from '../domain/presentationCompatibility.js';
import {
  runtimeFashionSkillNames,
  type LoadedFashionSkill,
  type RuntimeFashionSkillName,
} from '../services/skillRegistry.js';

type ChatRole = 'user' | 'assistant';

interface ChatMessage {
  role: ChatRole;
  content: string;
}

type ActivityEmitter = (activity: AgentActivity) => void;

interface GemmaStructuredResponse {
  message?: unknown;
  text?: unknown;
  selectedItemIds?: unknown;
  selectedProductIds?: unknown;
  suggestedOutfit?: unknown;
  visualRequest?: unknown;
  skillRequests?: unknown;
  toolCalls?: unknown;
  grounding?: unknown;
  artifacts?: unknown;
  artifactTitle?: unknown;
  outfitName?: unknown;
  occasion?: unknown;
  stylingActions?: unknown;
  rationale?: unknown;
}

interface GemmaVisualRequest {
  type: 'outfit_visual' | 'try_on';
  mode?: 'flatlay' | 'moodboard' | 'mannequin';
  aspectRatio?: '1:1' | '3:4' | '4:5' | '9:16' | '16:9';
  extraInstruction?: string;
}

interface GemmaSkillRequest {
  skill: RuntimeFashionSkillName;
  reference?: string;
}

type HarnessBrainMode = 'plan' | 'synthesis';

interface HarnessBrainInput {
  context: FashionAgentContext;
  closetItems: ClosetItem[];
  visualObservation?: VisualObservation;
  history: ChatMessage[];
  userMessage: string;
  loadedSkills?: LoadedFashionSkill[];
  currentImageBase64?: string;
  weather?: WeatherResult;
  emit?: ActivityEmitter;
  onTextDelta?: (delta: string) => void;
  purpose: string;
  mode: HarnessBrainMode;
  toolResults?: HarnessToolResult[];
  closetLooks?: ClosetLookCandidate[];
}

type HarnessBrain = (input: HarnessBrainInput) => Promise<string>;

interface HarnessClosetQuery {
  query: string;
  categories?: string[];
  colors?: string[];
  formality?: string;
  limit?: number;
  mustUseItemIds?: string[];
  keepItemIds?: string[];
  presentationPreference?: PresentationPreference;
  presentationOpenness?: StylingProfile['presentationOpenness'];
  recommendationScope?: RecommendationScope;
  expressionIntensity?: ExpressionIntensity;
  preferenceMemoryScope?: PreferenceMemoryScope;
  styleTone?: StyleTone;
  profileScope?: 'turn' | 'session' | 'persistent';
  constraints?: string[];
}

interface HarnessWeatherRequest {
  location?: string;
}

interface HarnessProductQuery {
  query: string;
  category?: string;
  color?: string;
  maxPrice?: number;
  limit?: number;
}

export interface HarnessPlan {
  answerDraft?: string;
  needsVision: boolean;
  needsPerceptionStatus: boolean;
  closetQuery?: HarnessClosetQuery;
  weatherRequest?: HarnessWeatherRequest;
  productQuery?: HarnessProductQuery;
  skillRequests: GemmaSkillRequest[];
  visualRequest?: GemmaVisualRequest;
  saveOutfit?: OutfitCandidate;
  confidence: number;
}

export interface HarnessToolResult {
  toolName:
    | 'observe_current_frame'
    | 'get_perception_status'
    | 'recommend_from_closet'
    | 'get_item_images'
    | 'get_weather'
    | 'search_products'
    | 'retrieve_style_strategy'
    | 'commit_outfit'
    | 'commit_outfit_selection'
    | 'create_style_visual'
    | 'update_style_visual'
    | 'edit_style_visual'
    | 'restore_visual_version'
    | 'generate_outfit_visual'
    | 'generate_try_on_preview'
    | 'edit_try_on_preview';
  status: 'ok' | 'warning' | 'error';
  summary: string;
  data?: unknown;
  elapsedMs: number;
}

export interface HarnessTrace {
  turnId: string;
  startedAt: string;
  completedAt?: string;
  fastPath: boolean;
  toolResults: HarnessToolResult[];
  routerElapsedMs?: number;
  planElapsedMs?: number;
  finalElapsedMs?: number;
  ttftMs?: number;
  totalElapsedMs?: number;
  streamedText?: boolean;
}

const aiDisclaimer =
  'AI 生成，仅供颜色、层次和风格参考；实际尺码、剪裁和面料垂坠以真实试穿为准。';

export function mergePermissions(
  supplied?: Partial<TurnPermissions>,
): TurnPermissions {
  return { ...defaultPermissions, ...supplied };
}

export class FashionTurnHarness {
  constructor(private readonly options: {
    config: AppConfig;
    services: ServiceContainer;
    stateStore: SessionStateStore;
    histories: Map<string, ChatMessage[]>;
    brain: HarnessBrain;
  }) {}

  async runTurn(input: FashionTurnInput): Promise<FashionTurnResult> {
    const state = this.options.stateStore.get(input.sessionId);
    const activity: AgentActivity[] = [];
    let currentTurnId = '';
    const emit: ActivityEmitter = (item) => {
      const normalized = normalizeActivityForTurn(item, currentTurnId);
      const existingIndex = activity.findIndex((activityItem) => activityItem.id === normalized.id);
      if (existingIndex >= 0) {
        activity[existingIndex] = normalized;
      } else {
        activity.push(normalized);
      }
      input.onActivity?.(normalized);
    };

    const context: FashionAgentContext = {
      sessionId: input.sessionId,
      userId: input.userId,
      turnId: makeId('turn'),
      locale: input.locale ?? 'zh-CN',
      nowIso: new Date().toISOString(),
      permissions: mergePermissions(input.permissions),
      state,
    };
    currentTurnId = context.turnId;
    context.state.activeTurnId = context.turnId;

    for (const attachment of input.attachments ?? []) {
      this.options.services.imageStore.registerAttachment(context, attachment);
    }
    updatePerceptionFromTurnInput(context, input);
    applyStatefulStylingOverride(context, input.stylingProfileOverride);

    const trace: HarnessTrace = {
      turnId: context.turnId,
      startedAt: new Date().toISOString(),
      fastPath: false,
      toolResults: [],
    };
    const history = this.options.histories.get(input.sessionId) ?? [];
    if (!normalizeUserText(input.message)) {
      const text = '我在。你可以直接告诉我场合、想要的风格，或者问我现在这身可不可以。';
      input.onDelta?.(text);
      return this.completedTurn(input, context, text, [], [], { ...trace, streamedText: true });
    }
    const planStarted = performance.now();
    const plan = await this.resolvePlan(context, history, input.message, emit, trace);
    trace.planElapsedMs = elapsedMs(planStarted);
    trace.fastPath = this.canReturnFromPlan(plan);
    if (trace.fastPath && plan.answerDraft?.trim()) {
      const text = plan.answerDraft.trim();
      if (plan.saveOutfit) {
        context.state.activeOutfit = normalizeSuggestedComplements(plan.saveOutfit);
        emit(activityItem('state', 'ok', '保存自由构思方案', context.state.activeOutfit.name ?? '已保存为当前方案。'));
      }
      input.onDelta?.(text);
      return this.completedTurn(input, context, text, [], activity, { ...trace, streamedText: true });
    }

    const toolState = trace.fastPath
      ? {
          closetItems: [] as ClosetItem[],
          closetLooks: [] as ClosetLookCandidate[],
          closetRecommendation: undefined as ClosetRecommendationResult | undefined,
          weather: undefined as WeatherResult | undefined,
          products: [] as ProductItem[],
          loadedSkills: [] as LoadedFashionSkill[],
          toolResults: [] as HarnessToolResult[],
          visualObservation: undefined as VisualObservation | undefined,
        }
      : await this.executePlannedTools(plan, context, input.message, emit, input.stylingProfileOverride);
    trace.toolResults = toolState.toolResults;
    const finalStarted = performance.now();
    const rawContent = await this.options.brain({
      context,
      closetItems: toolState.closetItems,
      closetLooks: toolState.closetLooks,
      visualObservation: toolState.visualObservation,
      weather: toolState.weather,
      history,
      loadedSkills: toolState.loadedSkills,
      userMessage: buildSynthesisMessage(input.message, plan, toolState.toolResults),
      emit,
      onTextDelta: (delta) => {
        if (!trace.ttftMs) trace.ttftMs = Date.now() - Date.parse(trace.startedAt);
        trace.streamedText = true;
        input.onDelta?.(delta);
      },
      purpose: '整理最终建议',
      mode: 'synthesis',
      toolResults: toolState.toolResults,
    });
    trace.finalElapsedMs = elapsedMs(finalStarted);

    const parsed = parseGemmaResponse(rawContent);
    const selectedIds = parseSelectedItemIds(parsed.selectedItemIds);
    const candidateIds = new Set(toolState.closetItems.map((item) => item.id));
    const invalidSelectedIds = selectedIds.filter((id) => !candidateIds.has(id));
    let selectedItems = this.selectedClosetItems(selectedIds, toolState.closetItems);
    selectedItems = filterItemsAllowedByRecommendation(selectedItems, toolState.closetRecommendation);
    let closetGapNote: string | undefined;
    if (selectedItems.length && !isCompleteOutfit(selectedItems)) {
      const missingPieces = missingOutfitPieces(selectedItems);
      closetGapNote = `我会把衣柜里可用的真实单品放进方案，但它们还不够组成完整一套，主要缺 ${missingPieces.join('、')}。我可以用柜外建议补完整；不会把不存在的衣柜单品显示成真实卡片。`;
      emit(
        activityItem(
          'policy',
          'warning',
          '衣柜里有可用单品，也有缺口',
          `缺 ${missingPieces.join('、')}，小助手会在回复里说明。`,
        ),
      );
    }
    const suggestedOutfit = parseSuggestedOutfit(parsed.suggestedOutfit) ?? plan.saveOutfit;
    const activeOutfit = selectedItems.length
      ? buildActiveOutfit(parsed, selectedItems, suggestedOutfit, toolState.closetRecommendation)
      : suggestedOutfit ?? context.state.activeOutfit;
    if (selectedItems.length || suggestedOutfit) {
      context.state.activeOutfit = activeOutfit;
      emit(
        selectedItems.length
          ? activityItem('tool', 'ok', '找到衣柜里的搭配单品', `已选择 ${selectedItems.length} 件真实单品。`)
          : activityItem('state', 'ok', '保存自由构思方案', suggestedOutfit?.name ?? '已保存为当前方案。'),
      );
    }

    const artifacts: UiArtifact[] = selectedItems.length
      ? [buildItemGrid(parsed, selectedItems, closetGapNote ? '衣柜里可用的真实单品' : undefined)]
      : [];
    const productArtifact = buildProductArtifact(parsed, toolState.products);
    if (productArtifact) artifacts.push(productArtifact);
    const visualArtifact = await this.buildVisualArtifact(
      context,
      parseVisualRequest(parsed.visualRequest) ?? plan.visualRequest,
      activeOutfit,
      emit,
    );
    if (visualArtifact) artifacts.push(visualArtifact);
    const grounding = validateGroundingEnvelope(context, parsed, artifacts, selectedItems, toolState.products, toolState.closetRecommendation);
    const decisionSummary = buildDecisionSummary({
      context,
      plan,
      toolResults: toolState.toolResults,
      grounding,
      selectedItems,
      products: toolState.products,
      recommendation: toolState.closetRecommendation,
      visualObservation: toolState.visualObservation,
      visualArtifact,
    });
    const text = groundResponseText(appendFitUncertaintyNote(appendClosetGapNote(
      responseText(parsed, rawContent, selectedItems, suggestedOutfit, visualArtifact),
      closetGapNote,
    ), selectedItems, toolState.closetRecommendation), selectedItems, invalidSelectedIds);
    return this.completedTurn(input, context, text, artifacts, activity, trace, grounding, decisionSummary);
  }

  private canReturnFromPlan(plan: HarnessPlan): boolean {
    return (
      plan.confidence >= 0.72 &&
      !plan.needsVision &&
      !plan.needsPerceptionStatus &&
      !plan.closetQuery &&
      !plan.weatherRequest &&
      !plan.productQuery &&
      !plan.visualRequest &&
      !plan.skillRequests.length
    );
  }

  private async resolvePlan(
    context: FashionAgentContext,
    history: ChatMessage[],
    userMessage: string,
    emit: ActivityEmitter,
    trace: HarnessTrace,
  ): Promise<HarnessPlan> {
    const activityId = makeId('activity');
    emit(activityItem('thinking', 'pending', 'Muse 正在理解你的需求', '判断是否直接回答，或需要看镜子、查衣柜。', activityId));
    try {
      const rawPlan = await this.options.brain({
        context,
        closetItems: [],
        history,
        userMessage,
        emit,
        purpose: '理解本轮需求',
        mode: 'plan',
      });
      const parsedPlan = sanitizeHarnessPlan(parseHarnessPlan(parseGemmaResponse(rawPlan), userMessage), userMessage);
      const plan = enforcePlanningInvariants(context, parsedPlan);
      const publicPlan = buildPublicPlanSummary(plan);
      if (publicPlan) emit(activityItem('state', 'ok', 'Muse 的计划', publicPlan));
      emit(activityItem('thinking', 'ok', 'Muse 已理解本轮需求', plan.closetQuery || plan.needsVision || plan.needsPerceptionStatus ? '继续执行需要的能力。' : '可以直接回复。', activityId));
      return plan;
    } catch (error) {
      emit(activityItem('thinking', 'error', 'Muse 暂时没有完成理解', '小助手暂时不可用，请稍后重试。', activityId));
      throw error;
    }
  }

  private async executePlannedTools(
    plan: HarnessPlan,
    context: FashionAgentContext,
    userMessage: string,
    emit: ActivityEmitter,
    inputStylingOverride?: FashionTurnInput['stylingProfileOverride'],
  ): Promise<{
    closetItems: ClosetItem[];
    closetLooks: ClosetLookCandidate[];
    closetRecommendation?: ClosetRecommendationResult;
    visualObservation?: VisualObservation;
    weather?: WeatherResult;
    products: ProductItem[];
    loadedSkills: LoadedFashionSkill[];
    toolResults: HarnessToolResult[];
  }> {
    const toolResults: HarnessToolResult[] = [];
    const [perceptionStatusResult, visualObservation, closetResult, weather, products, loadedSkills] = await Promise.all([
      plan.needsPerceptionStatus
        ? Promise.resolve(this.getPerceptionStatusTool(context, emit)).then(({ result }) => {
            toolResults.push(result);
            return result;
          })
        : Promise.resolve(undefined),
      plan.needsVision
        ? this.analyzeCurrentView(context, userMessage, emit).then(({ value, result }) => {
            toolResults.push(result);
            return value;
          })
        : Promise.resolve(undefined),
      plan.closetQuery
        ? this.searchCloset(plan.closetQuery, userMessage, emit, context, inputStylingOverride).then(({ value, result }) => {
            toolResults.push(result);
            return value;
          })
        : Promise.resolve({ items: [] as ClosetItem[], looks: [] as ClosetLookCandidate[], recommendation: undefined as ClosetRecommendationResult | undefined }),
      plan.weatherRequest
        ? this.getWeather(plan.weatherRequest, emit).then(({ value, result }) => {
            toolResults.push(result);
            return value;
          })
        : Promise.resolve(undefined),
      plan.productQuery
        ? this.searchProducts(plan.productQuery, emit).then(({ value, result }) => {
            toolResults.push(result);
            return value;
          })
        : Promise.resolve([] as ProductItem[]),
      plan.skillRequests.length
        ? this.loadFashionSkills(plan.skillRequests, emit).then(({ value, result }) => {
            toolResults.push(result);
            return value;
          })
        : Promise.resolve([] as LoadedFashionSkill[]),
    ]);
    return {
      closetItems: closetResult.items,
      closetLooks: closetResult.looks,
      closetRecommendation: closetResult.recommendation,
      visualObservation,
      weather,
      products,
      loadedSkills,
      toolResults: toolResults.sort((a, b) => a.toolName.localeCompare(b.toolName)),
    };
  }

  private getPerceptionStatusTool(
    context: FashionAgentContext,
    emit: ActivityEmitter,
  ): { result: HarnessToolResult } {
    const started = performance.now();
    const perception = ensurePerceptionState(context.state);
    emit(
      activityItem(
        'vision',
        perception.status === 'observed' ? 'ok' : 'warning',
        perception.status === 'observed' ? '读取镜子状态' : '镜子状态暂未清晰',
        perception.summary ?? '已读取当前可用的镜子状态。',
      ),
    );
    return {
      result: {
        toolName: 'get_perception_status',
        status: perception.status === 'observed' ? 'ok' : 'warning',
        summary: `Perception status: ${perception.status}.`,
        data: perception,
        elapsedMs: elapsedMs(started),
      },
    };
  }

  private async analyzeCurrentView(
    context: FashionAgentContext,
    userMessage: string,
    emit: ActivityEmitter,
  ): Promise<{ value?: VisualObservation; result: HarnessToolResult }> {
    const started = performance.now();
    const activityId = makeId('activity');
    if (!context.permissions.allowVisualAnalysis) {
      emit(
        activityItem(
          'vision',
          'warning',
          '现在没有可看的画面',
          '我会先根据对话继续。',
          activityId,
        ),
      );
      updatePerceptionFailure(context, context.permissions.allowVisualAnalysis ? 'no_frame' : 'permission');
      return {
        result: {
          toolName: 'observe_current_frame',
          status: 'warning',
          summary: 'No authorized current image was available.',
          elapsedMs: elapsedMs(started),
        },
      };
    }

    const cached = freshVisualCache(context, this.options.config.visualCacheTtlMs);
    if (cached && canUseCachedObservationForCurrentFrame(context, cached)) {
      applyCachedPerceptionObservation(context, cached);
      emit(activityItem('vision', 'ok', '读取刚才的画面观察', '继续生成穿搭建议。', activityId));
      return {
        value: cached.observation,
        result: {
          toolName: 'observe_current_frame',
          status: 'ok',
          summary: `Used cached mirror observation from ${cached.source} vision.`,
          data: cached.observation,
          elapsedMs: elapsedMs(started),
        },
      };
    }

    if (!context.state.currentUserImageId) {
      emit(
        activityItem(
          'vision',
          'warning',
          '现在没有可看的画面',
          '我会先根据对话继续。',
          activityId,
        ),
      );
      updatePerceptionFailure(context, 'no_frame');
      return {
        result: {
          toolName: 'observe_current_frame',
          status: 'warning',
          summary: 'No authorized current image was available.',
          elapsedMs: elapsedMs(started),
        },
      };
    }
    const image = context.state.images[context.state.currentUserImageId];
    if (!image) {
      updatePerceptionFailure(context, 'no_frame');
      return {
        result: {
          toolName: 'observe_current_frame',
          status: 'warning',
          summary: 'Current image id did not resolve.',
          elapsedMs: elapsedMs(started),
        },
      };
    }
    emit(
      activityItem('vision', 'pending', '正在看当前画面', '结合你刚发的问题一起判断。', activityId),
    );
    try {
      const quick = await withTimeout(
        this.options.services.vision.analyze(image, 'overall_outfit', {
          model: this.options.config.quickVisionModel,
          timeoutMs: 9000,
        }),
        9000,
      );
      let value = quick;
      let source: 'quick' | 'deep' = 'quick';
      if (
        this.options.config.deepVisionReview &&
        this.options.config.deepVisionModel !== this.options.config.quickVisionModel &&
        shouldUseDeepVision(userMessage, quick)
      ) {
        value = await withTimeout(
          this.options.services.vision.analyze(image, 'overall_outfit', {
            model: this.options.config.deepVisionModel,
            timeoutMs: 14000,
          }),
          14000,
        );
        source = 'deep';
      }
      context.state.visualCache = {
        observation: value,
        cachedAt: new Date().toISOString(),
        imageId: image.id,
        source,
      };
      updatePerceptionObservation(context, value, source, this.options.config.visualCacheTtlMs);
      emit(activityItem('vision', 'ok', '看完当前画面', '继续生成穿搭建议。', activityId));
      return {
        value,
        result: {
          toolName: 'observe_current_frame',
          status: 'ok',
          summary: `Observed ${value.visibleItems.length} visible items with ${source} vision.`,
          data: value,
          elapsedMs: elapsedMs(started),
        },
      };
    } catch {
      updatePerceptionFailure(context, 'model');
      emit(activityItem('vision', 'warning', '当前画面暂时没看清', '我会先根据对话继续。', activityId));
      return {
        result: {
          toolName: 'observe_current_frame',
          status: 'warning',
          summary: 'Vision analysis was unavailable.',
          elapsedMs: elapsedMs(started),
        },
      };
    }
  }

  private async searchCloset(
    query: HarnessClosetQuery,
    userMessage: string,
    emit: ActivityEmitter,
    context: FashionAgentContext,
    inputStylingOverride?: FashionTurnInput['stylingProfileOverride'],
  ): Promise<{ value: { items: ClosetItem[]; looks: ClosetLookCandidate[]; recommendation?: ClosetRecommendationResult }; result: HarnessToolResult }> {
    const started = performance.now();
    const activityId = makeId('activity');
    emit(
      activityItem(
        'tool',
        'pending',
        '正在找衣柜里的合适单品',
        '只会使用你的真实衣柜。',
        activityId,
      ),
    );
    try {
      const searchInput = {
        query: query.query || userMessage,
        categories: query.categories,
        colors: query.colors,
        formality: query.formality,
        limit: Math.min(query.limit ?? 12, 12),
      };
      const profile = resolveEffectiveStylingProfile(context, query, inputStylingOverride);
      const recommendation = this.options.services.closet.recommend({
        ...searchInput,
        profile,
        mustUseItemIds: uniqueStrings([...(query.mustUseItemIds ?? []), ...(query.keepItemIds ?? [])]),
      });
      const { items, looks, result: recommendationResult } = recommendation;
      context.state.activeClosetRecommendation = recommendationResult;
      emit(
        activityItem(
          'tool',
          'ok',
          '找到衣柜候选单品',
          items.length
            ? `找到 ${items.length} 件可用单品。`
            : '当前衣柜里没有足够匹配这个方向的单品。',
          activityId,
        ),
      );
      return {
        value: { items, looks, recommendation: recommendationResult },
        result: {
          toolName: 'recommend_from_closet',
          status: recommendationResult.status === 'success' ? 'ok' : 'warning',
          summary: `Found ${items.length} compatible closet items; recommendation status ${recommendationResult.status}.`,
          data: {
            recommendationId: recommendationResult.recommendationId,
            profileSnapshotId: recommendationResult.profileSnapshotId,
            policyVersion: recommendationResult.policyVersion,
            closetVersion: recommendationResult.closetVersion,
            status: recommendationResult.status,
            coverage: recommendationResult.coverage,
            candidates: recommendationResult.candidates.map((candidate) => ({
              id: candidate.id,
              itemIds: candidate.itemIds,
              completeness: candidate.completeness,
              score: candidate.score,
              reasonCodes: candidate.reasonCodes,
              fitStatus: candidate.fitStatus,
              provenance: candidate.provenance,
            })),
            suggestedComplements: recommendationResult.suggestedComplements,
            clarification: recommendationResult.clarification,
            looks,
            items: items.map(({ id, name, category, color, presentationMetadata, fitCompatibilityTags }) => ({
              id,
              name,
              category,
              color,
              presentationIntensity: presentationMetadata?.intensity,
              presentationReasonCodes: presentationMetadata?.reasonCodes,
              fitCompatibilityTags,
            })),
          },
          elapsedMs: elapsedMs(started),
        },
      };
    } catch {
      emit(activityItem('tool', 'warning', '衣柜暂时没取到', '我会先根据对话继续。', activityId));
      return {
        value: { items: [], looks: [], recommendation: undefined },
        result: {
          toolName: 'recommend_from_closet',
          status: 'warning',
          summary: 'Closet search was unavailable.',
          elapsedMs: elapsedMs(started),
        },
      };
    }
  }

  private async loadFashionSkills(
    requests: GemmaSkillRequest[],
    emit: ActivityEmitter,
  ): Promise<{ value: LoadedFashionSkill[]; result: HarnessToolResult }> {
    const started = performance.now();
    const activityId = makeId('activity');
    emit(activityItem('skill', 'pending', '正在参考穿搭方法', '用于检查场合、比例和完整度。', activityId));
    const loaded: LoadedFashionSkill[] = [];
    const seen = new Set<string>();
    for (const request of requests.slice(0, 3)) {
      const key = `${request.skill}:${request.reference ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        loaded.push(this.options.services.skills.load(request.skill, request.reference));
      } catch {
        // Keep the user-facing activity compact; the harness trace records the warning.
      }
    }
    emit(
      activityItem(
        'skill',
        loaded.length ? 'ok' : 'warning',
        loaded.length ? '参考完穿搭方法' : '穿搭方法暂时没取到',
        loaded.length ? '继续整理建议。' : '我会先根据常识继续。',
        activityId,
      ),
    );
    return {
      value: loaded,
      result: {
        toolName: 'retrieve_style_strategy',
        status: loaded.length ? 'ok' : 'warning',
        summary: loaded.length
          ? `Loaded skills: ${loaded.map((skill) => skill.name).join(', ')}.`
          : 'No requested skills could be loaded.',
        data: loaded.map((skill) => ({ name: skill.name, reference: skill.reference?.name })),
        elapsedMs: elapsedMs(started),
      },
    };
  }

  private async getWeather(
    request: HarnessWeatherRequest,
    emit: ActivityEmitter,
  ): Promise<{ value?: WeatherResult; result: HarnessToolResult }> {
    const started = performance.now();
    const activityId = makeId('activity');
    emit(activityItem('weather', 'pending', '正在查看天气', '只在天气会影响穿搭时使用。', activityId));
    try {
      const value = await this.options.services.weather.getCurrent(request.location ?? 'default');
      emit(activityItem('weather', 'ok', '已查看天气', `${value.temperatureC}°C · ${value.condition}`, activityId));
      return {
        value,
        result: {
          toolName: 'get_weather',
          status: 'ok',
          summary: `${value.temperatureC}C, ${value.condition}, rain ${value.precipitationChance}%.`,
          data: value,
          elapsedMs: elapsedMs(started),
        },
      };
    } catch {
      emit(activityItem('weather', 'warning', '天气暂时没取到', '我会先根据你提供的信息继续。', activityId));
      return {
        result: {
          toolName: 'get_weather',
          status: 'warning',
          summary: 'Weather was unavailable.',
          elapsedMs: elapsedMs(started),
        },
      };
    }
  }

  private async searchProducts(
    query: HarnessProductQuery,
    emit: ActivityEmitter,
  ): Promise<{ value: ProductItem[]; result: HarnessToolResult }> {
    const started = performance.now();
    const activityId = makeId('activity');
    emit(activityItem('tool', 'pending', '正在找可补充的商品', '柜外补充会单独标记，不会冒充衣柜。', activityId));
    try {
      const value = await this.options.services.products.search({
        query: query.query,
        category: query.category,
        color: query.color,
        maxPrice: query.maxPrice,
        limit: Math.min(query.limit ?? 6, 8),
      });
      emit(
        activityItem(
          'tool',
          value.length ? 'ok' : 'warning',
          value.length ? '找到可补充商品' : '暂时没有合适商品',
          value.length ? `找到 ${value.length} 个候选。` : '本轮不展示模拟商品。',
          activityId,
        ),
      );
      return {
        value,
        result: {
          toolName: 'search_products',
          status: value.length ? 'ok' : 'warning',
          summary: `Found ${value.length} product candidates.`,
          data: value.map(({ id, title, category, color, price }) => ({ id, title, category, color, price })),
          elapsedMs: elapsedMs(started),
        },
      };
    } catch {
      emit(activityItem('tool', 'warning', '商品暂时没取到', '我会先根据现有信息继续。', activityId));
      return {
        value: [],
        result: {
          toolName: 'search_products',
          status: 'warning',
          summary: 'Product search was unavailable.',
          elapsedMs: elapsedMs(started),
        },
      };
    }
  }

  private selectedClosetItems(value: unknown, allowedItems: ClosetItem[]): ClosetItem[] {
    const ids = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
    if (!ids.length || !allowedItems.length) return [];
    const allowedIds = new Set(allowedItems.map((item) => item.id));
    return this.options.services.closet
      .getByIds(ids.filter((id) => allowedIds.has(id)))
      .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  }

  private async buildVisualArtifact(
    context: FashionAgentContext,
    request: GemmaVisualRequest | undefined,
    outfit: OutfitCandidate | undefined,
    emit: ActivityEmitter,
  ): Promise<UiArtifact | undefined> {
    if (!request) return undefined;
    emit(
      activityItem(
        'tool',
        'ok',
        request.type === 'try_on' ? '请求上身预览' : '请求搭配图生成',
        request.type === 'try_on' ? '涉及本人照片，需要授权。' : '准备生成这套的视觉参考。',
      ),
    );
    if (!outfit) {
      return {
        type: 'notice',
        id: makeId('artifact'),
        level: 'warning',
        text: '我还没有一套明确的搭配可以生成图；你可以先让我构思一套，再说“想看看”。',
      };
    }
    const provenanceIssue = validateOutfitProvenance(
      context,
      outfit,
      this.options.services.closet.closetVersion,
    );
    if (provenanceIssue) {
      emit(activityItem('policy', 'warning', '搭配需要重新确认', provenanceIssue));
      return {
        type: 'notice',
        id: makeId('artifact'),
        level: 'warning',
        text: provenanceIssue,
      };
    }
    if (request.type === 'try_on') {
      emit(activityItem('policy', 'warning', '照片生成需要授权', '本轮不直接使用本人照片生成上身图。'));
      return {
        type: 'notice',
        id: makeId('artifact'),
        level: 'info',
        text: '上身预览需要照片授权和真实图片服务。现在可以先生成不使用本人照片的搭配概念图。',
      };
    }
    if (this.options.config.mockTools || !process.env.GEMINI_API_KEY) {
      emit(activityItem('tool', 'warning', '图片生成未执行', '真实图片生成服务还没有配置。'));
      return {
        type: 'notice',
        id: makeId('artifact'),
        level: 'warning',
        text: '真实图片生成服务还没有配置，所以这轮没有展示模拟图。配置图片服务后，就可以把这套生成成图。',
      };
    }

    const mode = request.mode ?? 'flatlay';
    const aspectRatio = request.aspectRatio ?? '4:5';
    const prompt = [
      buildOutfitVisualPrompt({ outfit, mode }),
      request.extraInstruction ? `Extra instruction: ${request.extraInstruction}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const generated = await this.options.services.imageGeneration.generate(prompt, aspectRatio);
    emit(activityItem('tool', 'ok', '图片生成完成', '已生成这套的视觉参考。'));
    const image = await this.options.services.imageStore.saveGenerated(context, {
      kind: 'ai_outfit_visual',
      bytes: generated.bytes,
      mimeType: generated.mimeType,
      label: outfit.name ?? 'AI 搭配示意图',
    });
    return {
      type: 'image',
      id: makeId('artifact'),
      label: image.label ?? 'AI 搭配示意图',
      source: 'ai_outfit_visual',
      url: image.url ?? image.localPath ?? '',
      mimeType: image.mimeType,
      aiGenerated: true,
      disclaimer: aiDisclaimer,
    };
  }

  private completedTurn(
    input: FashionTurnInput,
    context: FashionAgentContext,
    text: string,
    artifacts: UiArtifact[],
    activity: AgentActivity[],
    trace: HarnessTrace,
    grounding: AgentGrounding = validateGroundingEnvelope(context, {}, artifacts, [], []),
    decisionSummary?: MuseDecisionSummary,
  ): FashionTurnResult {
    trace.completedAt = new Date().toISOString();
    trace.totalElapsedMs = Date.now() - Date.parse(trace.startedAt);
    this.options.stateStore.set(input.sessionId, context.state);
    this.appendHistory(input.sessionId, input.message, text);
    if (!trace.streamedText) input.onDelta?.(text);
    for (const artifact of artifacts) input.onArtifact?.(artifact);
    return {
      status: 'completed',
      text,
      artifacts,
      activity,
      grounding,
      decisionSummary,
      state: {
        activeOutfitId: context.state.activeOutfit?.id,
        lastGeneratedImageId: context.state.lastGeneratedImageId,
        currentUserImageId: context.state.currentUserImageId,
        perception: context.state.perception,
        stylingProfile: ensureStylingProfile(context).profile,
        grounding,
      },
    };
  }

  private appendHistory(sessionId: string, userMessage: string, assistantText: string): void {
    const history = this.options.histories.get(sessionId) ?? [];
    history.push({ role: 'user', content: userMessage });
    history.push({ role: 'assistant', content: assistantText });
    this.options.histories.set(sessionId, history.slice(-12));
  }
}

export class GemmaFashionRuntime {
  readonly config: AppConfig;
  readonly services: ServiceContainer;
  readonly stateStore: SessionStateStore;
  private readonly histories = new Map<string, ChatMessage[]>();
  private readonly mirrorFrameJobs = new Map<string, Promise<void>>();

  constructor(options?: {
    config?: AppConfig;
    services?: ServiceContainer;
    stateStore?: SessionStateStore;
  }) {
    this.config = options?.config ?? loadConfig();
    this.services = options?.services ?? createServiceContainer(this.config);
    this.stateStore = options?.stateStore ?? new InMemorySessionStateStore();
  }

  async runTurn(input: FashionTurnInput): Promise<FashionTurnResult> {
    const harness = new FashionTurnHarness({
      config: this.config,
      services: this.services,
      stateStore: this.stateStore,
      histories: this.histories,
      brain: (args) => this.callGemma(args),
    });
    return harness.runTurn(input);
  }

  cacheMirrorFrame(input: MirrorFrameInput): MirrorFrameResult {
    const state = this.stateStore.get(input.sessionId);
    const context: FashionAgentContext = {
      sessionId: input.sessionId,
      userId: input.userId,
      turnId: makeId('turn'),
      locale: input.locale ?? 'zh-CN',
      nowIso: new Date().toISOString(),
      permissions: mergePermissions(input.permissions),
      state,
    };

    for (const attachment of input.attachments ?? []) {
      this.services.imageStore.registerAttachment(context, attachment);
    }
    updatePerceptionFromMirrorFrame(context, input);
    this.stateStore.set(input.sessionId, context.state);

    if (!context.permissions.allowVisualAnalysis || !context.state.currentUserImageId) {
      updatePerceptionFailure(context, context.permissions.allowVisualAnalysis ? 'no_frame' : 'permission');
      return {
        ok: true,
        status: 'skipped',
        cachedAt: context.state.visualCache?.cachedAt,
        perception: context.state.perception,
      };
    }
    if (this.mirrorFrameJobs.has(input.sessionId)) {
      return {
        ok: true,
        status: 'accepted',
        cachedAt: context.state.visualCache?.cachedAt,
        perception: context.state.perception,
      };
    }

    const image = context.state.images[context.state.currentUserImageId];
    if (!image) {
      updatePerceptionFailure(context, 'no_frame');
      return {
        ok: true,
        status: 'skipped',
        cachedAt: context.state.visualCache?.cachedAt,
        perception: context.state.perception,
      };
    }

    const job = this.services.vision
      .analyze(image, 'overall_outfit', {
        model: this.config.quickVisionModel,
        timeoutMs: 9000,
      })
      .then((observation) => {
        const latest = this.stateStore.get(input.sessionId);
        if (latest.currentUserImageId !== image.id) return;
        latest.visualCache = {
          observation,
          cachedAt: new Date().toISOString(),
          imageId: image.id,
          source: 'quick',
        };
        updatePerceptionObservation(
          { ...context, state: latest },
          observation,
          'quick',
          this.config.visualCacheTtlMs,
        );
        this.stateStore.set(input.sessionId, latest);
      })
      .catch(() => {
        const latest = this.stateStore.get(input.sessionId);
        updatePerceptionFailure({ ...context, state: latest }, 'model');
        this.stateStore.set(input.sessionId, latest);
      })
      .finally(() => {
        this.mirrorFrameJobs.delete(input.sessionId);
      });
    this.mirrorFrameJobs.set(input.sessionId, job);
    return {
      ok: true,
      status: 'accepted',
      cachedAt: context.state.visualCache?.cachedAt,
      perception: context.state.perception,
    };
  }

  getPerceptionStatus(sessionId: string): PerceptionState {
    return ensurePerceptionState(this.stateStore.get(sessionId));
  }

  async resumeTurn(input: ResumeFashionTurnInput): Promise<FashionTurnResult> {
    const approved = input.decisions.some((decision) => decision.approved);
    const text = approved
      ? '我收到确认了。当前 demo 已优先处理聊天和衣柜推荐；涉及本人上身生成的动作仍建议接入专门的图片服务后再执行。'
      : '好的，我不会执行这个需要确认的动作。我们可以继续用文字和衣柜单品来调整方案。';
    this.appendHistory(input.sessionId, approved ? '用户已确认。' : '用户没有确认。', text);
    return {
      status: 'completed',
      text,
      artifacts: [],
      activity: [
        activityItem('policy', approved ? 'ok' : 'warning', approved ? '确认照片动作' : '取消照片动作'),
      ],
      state: {},
    };
  }

  async close(): Promise<void> {
    return undefined;
  }

  private async callGemma(args: HarnessBrainInput): Promise<string> {
    const userMessage: { role: 'user'; content: string; images?: string[] } = {
      role: 'user',
      content: args.userMessage,
    };
    if (args.currentImageBase64) {
      userMessage.images = [args.currentImageBase64];
    }
    const shouldStream = args.mode !== 'plan' && Boolean(args.onTextDelta);
    const payload = {
      model: this.config.gemma4OllamaModel,
      messages: [
        { role: 'system', content: this.systemPrompt(args) },
        ...args.history.slice(-8),
        userMessage,
      ],
      stream: shouldStream,
      format: 'json',
      think: false,
      options: {
        temperature: 0.22,
        num_ctx: 8192,
        num_predict: args.mode === 'plan' ? 320 : 720,
      },
    };

    const activityId = makeId('activity');
    const shouldShowModelActivity = args.mode !== 'plan';
    if (shouldShowModelActivity) {
      args.emit?.(
        activityItem(
          'model',
          'pending',
          `Muse 正在${args.purpose}`,
          '正在组织这一轮回复。',
          activityId,
        ),
      );
    }

    try {
      const response = await fetch(
        `${this.config.gemma4OllamaEndpoint.replace(/\/+$/, '')}/api/chat`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(180000),
        },
      );

      if (!response.ok) {
        if (shouldShowModelActivity) {
          args.emit?.(
            activityItem(
              'model',
              'error',
              `Muse 暂时没有返回：${args.purpose}`,
              'Muse 暂时不可用，请稍后重试。',
              activityId,
            ),
          );
        }
        throw new Error('小助手暂时不可用，请稍后重试。');
      }

      let content = shouldStream
        ? await readOllamaChatStream(response, args.onTextDelta)
        : ((await response.json()) as { message?: { content?: string } }).message?.content ?? '';
      if (shouldStream && !isUsableStructuredContent(content)) {
        const retryResponse = await fetch(
          `${this.config.gemma4OllamaEndpoint.replace(/\/+$/, '')}/api/chat`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...payload, stream: false }),
            signal: AbortSignal.timeout(180000),
          },
        );
        if (!retryResponse.ok) {
          throw new Error('小助手暂时不可用，请稍后重试。');
        }
        content =
          ((await retryResponse.json()) as { message?: { content?: string } }).message?.content ?? content;
      }
      if (shouldShowModelActivity) {
        args.emit?.(
          activityItem(
            'model',
            'ok',
            `Muse 已${args.purpose}`,
            '继续完成本轮回复。',
            activityId,
          ),
        );
      }
      return content;
    } catch (error) {
      if (shouldShowModelActivity) {
        args.emit?.(
          activityItem(
            'model',
            'error',
            `Muse 暂时没有返回：${args.purpose}`,
            'Muse 暂时不可用，请稍后重试。',
            activityId,
          ),
        );
      }
      throw new Error('小助手暂时不可用，请稍后重试。');
    }
  }

  private systemPrompt(args: {
    context: FashionAgentContext;
    closetItems: ClosetItem[];
    closetLooks?: ClosetLookCandidate[];
    visualObservation?: VisualObservation;
    weather?: WeatherResult;
    loadedSkills?: LoadedFashionSkill[];
    currentImageBase64?: string;
    mode?: HarnessBrainMode;
    toolResults?: HarnessToolResult[];
  }): string {
    const closet = args.closetItems.map((item) => ({
      id: item.id,
      name: item.name,
      category: item.category,
      color: item.color,
      fit: item.fit,
      formality: item.formality,
      styleTags: item.styleTags,
      marketedFor: item.marketedFor,
      presentationIntensity: item.presentationMetadata?.intensity,
      presentationReasonCodes: item.presentationMetadata?.reasonCodes,
      fitCompatibilityTags: item.fitCompatibilityTags,
    }));
    const closetLooks = (args.closetLooks ?? []).map((look) => ({
      id: look.id,
      title: look.title,
      completeness: look.completeness,
      itemIds: look.itemIds,
      categories: look.categories,
    }));

    const modeContract = args.mode === 'synthesis'
      ? synthesisContract()
      : planningContract();
    const stylingProfile = ensureStylingProfile(args.context);

    return `${buildSystemInstructions(args.context, this.services.skills.catalog())}

## Muse Mirror harness contract
你运行在一个轻量 agent harness 中。你要自主判断是否需要当前画面、真实衣柜、专业穿搭方法或图片生成；代码只负责权限、数据边界和格式校验。

必须只输出 JSON，不要 Markdown，不要解释 JSON 协议。

${modeContract}

通用规则：
- 回复 text/answerDraft 要像真人造型师，直接、具体、自然；不要说“根据 JSON/协议/工具”。
- 不展示内部模型名、接口名、fallback、端口、截图上传等工程细节。
- selectedItemIds 只能使用候选真实衣柜单品里的 id；不确定就留空，不要发明 id。
- 不要根据用户的脸、身体、声音、姓名、肤色、国籍或民族推断性别身份或长期穿衣偏好。
- 进行衣柜推荐时，依据系统提供的 StylingProfile、用户本轮明确要求、单品实际剪裁、尺码、场合、天气和舒适度；不要仅因 marketedFor=womens/mens 就自动排除，也不要因为衣服存在于衣柜就默认用户愿意穿。
- 没有真实试穿或尺寸证据时，不要说“肯定合身”；只能说从剪裁和风格上更适配，实际肩线、腰围、裤长仍需试穿确认。
- 可用 skill：style-diagnosis、occasion-styling、outfit-review、try-on-preparation。
- 如果视觉观察为空，不要假装看到了照片。
- 不评价用户身体好坏；把“显腿长、梨形”等说成中性的造型目标和穿法。

## 候选真实衣柜单品
${JSON.stringify(closet, null, 2)}

## 候选真实衣柜搭配组
${JSON.stringify(closetLooks, null, 2)}

## 视觉助手当前帧观察
${JSON.stringify(args.visualObservation ?? null, null, 2)}

## 天气结果
${JSON.stringify(args.weather ?? null, null, 2)}

## 当前 StylingProfile
${JSON.stringify(stylingProfile, null, 2)}

## Harness 工具结果
${JSON.stringify(compactToolResults(args.toolResults ?? []), null, 2)}

## 已加载专业穿搭知识
${JSON.stringify(
      (args.loadedSkills ?? []).map((skill) => ({
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        reference: skill.reference,
      })),
      null,
      2,
    )}`;
  }

  private selectedClosetItems(value: unknown): ClosetItem[] {
    const ids = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
    if (!ids.length) return [];
    return this.services.closet.getByIds(ids).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  }

  private async getVisualObservation(
    context: FashionAgentContext,
    emit: ActivityEmitter,
  ): Promise<VisualObservation | undefined> {
    if (!context.permissions.allowVisualAnalysis || !context.state.currentUserImageId) {
      return undefined;
    }
    const image = context.state.images[context.state.currentUserImageId];
    if (!image) return undefined;
    const activityId = makeId('activity');
    emit(
      activityItem(
        'vision',
        'pending',
        '正在看当前画面',
        '结合你刚发的问题一起判断。',
        activityId,
      ),
    );
    try {
      const result = await this.services.vision.analyze(image, 'overall_outfit');
      emit(
        activityItem(
          'vision',
          'ok',
          '看完当前画面',
          '继续生成穿搭建议。',
          activityId,
        ),
      );
      return result;
    } catch (error) {
      emit(
        activityItem(
          'vision',
          'warning',
          '当前画面暂时没看清',
          '我会先根据对话继续。',
          activityId,
        ),
      );
      return undefined;
    }
  }

  private async getCurrentGemmaImage(
    context: FashionAgentContext,
    emit: ActivityEmitter,
  ): Promise<string | undefined> {
    if (!context.permissions.allowVisualAnalysis || !context.state.currentUserImageId) {
      return undefined;
    }
    const image = context.state.images[context.state.currentUserImageId];
    if (!image) return undefined;
    try {
      const bytes = await this.services.imageStore.readImageBytes(image);
      return bytes.toString('base64');
    } catch {
      emit(
        activityItem('vision', 'warning', '当前帧分析失败', '继续用文字和已有上下文回答。'),
      );
      return undefined;
    }
  }

  private loadRequestedSkills(
    value: unknown,
    emit: ActivityEmitter,
  ): LoadedFashionSkill[] {
    const requests = parseSkillRequests(value);
    if (!requests.length) return [];
    const loaded: LoadedFashionSkill[] = [];
    const seen = new Set<string>();
    for (const request of requests.slice(0, 3)) {
      const key = `${request.skill}:${request.reference ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const skill = this.services.skills.load(request.skill, request.reference);
        loaded.push(skill);
        emit(
          activityItem(
            'skill',
            'ok',
            `读取穿搭方法：${skill.name}`,
            skill.reference ? `加载参考 ${skill.reference.name}` : skill.description,
          ),
        );
      } catch (error) {
        emit(
          activityItem(
            'skill',
            'warning',
            `穿搭方法加载失败：${request.skill}`,
            '暂时无法读取这条穿搭方法。',
          ),
        );
      }
    }
    return loaded;
  }

  private appendHistory(sessionId: string, userMessage: string, assistantText: string): void {
    const history = this.histories.get(sessionId) ?? [];
    history.push({ role: 'user', content: userMessage });
    history.push({ role: 'assistant', content: assistantText });
    this.histories.set(sessionId, history.slice(-12));
  }

  private async buildVisualArtifact(
    context: FashionAgentContext,
    request: GemmaVisualRequest | undefined,
    outfit: OutfitCandidate | undefined,
    emit: ActivityEmitter,
  ): Promise<UiArtifact | undefined> {
    if (!request) return undefined;
    emit(
      activityItem(
        'tool',
        'ok',
        request.type === 'try_on' ? '请求上身预览' : '请求搭配图生成',
        request.type === 'try_on' ? '涉及本人照片，进入权限边界。' : '基于当前 active outfit 准备生成概念图。',
      ),
    );
    if (!outfit) {
      return {
        type: 'notice',
        id: makeId('artifact'),
        level: 'warning',
        text: '我还没有一套明确的搭配可以生成图；你可以先让我构思一套，再说“想看看”。',
      };
    }
    if (request.type === 'try_on') {
      emit(
        activityItem('policy', 'warning', '照片生成需要授权', '本轮不直接使用本人照片生成上身图。'),
      );
      return {
        type: 'notice',
        id: makeId('artifact'),
        level: 'info',
        text: '上身预览需要照片授权和真实图片服务。现在可以先生成不使用本人照片的搭配概念图。',
      };
    }
    if (this.config.mockTools || !process.env.GEMINI_API_KEY) {
      emit(
        activityItem('tool', 'warning', '图片生成未执行', '未配置真实图片生成服务；不展示模拟图。'),
      );
      return {
        type: 'notice',
        id: makeId('artifact'),
        level: 'warning',
        text: '真实图片生成能力还没有开启，所以这轮没有展示模拟图。开启后，就可以把这套生成成图。',
      };
    }

    const mode = request.mode ?? 'flatlay';
    const aspectRatio = request.aspectRatio ?? '4:5';
    const prompt = [
      buildOutfitVisualPrompt({ outfit, mode }),
      request.extraInstruction ? `Extra instruction: ${request.extraInstruction}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const generated = await this.services.imageGeneration.generate(prompt, aspectRatio);
    emit(
      activityItem('tool', 'ok', '真实图片生成完成', `已返回 ${generated.mimeType} 视觉结果。`),
    );
    const image = await this.services.imageStore.saveGenerated(context, {
      kind: 'ai_outfit_visual',
      bytes: generated.bytes,
      mimeType: generated.mimeType,
      label: outfit.name ?? 'AI 搭配示意图',
    });
    return {
      type: 'image',
      id: makeId('artifact'),
      label: image.label ?? 'AI 搭配示意图',
      source: 'ai_outfit_visual',
      url: image.url ?? image.localPath ?? '',
      mimeType: image.mimeType,
      aiGenerated: true,
      disclaimer: aiDisclaimer,
    };
  }
}

function parseGemmaResponse(content: string): GemmaStructuredResponse {
  try {
    return extractJsonObject<GemmaStructuredResponse>(content);
  } catch {
    if (content.trim().startsWith('{')) {
      const partialText = extractPartialJsonStringField(content, 'text');
      return partialText ? { text: partialText } : {};
    }
    return { text: content };
  }
}

function isUsableStructuredContent(content: string): boolean {
  try {
    const parsed = extractJsonObject<Record<string, unknown>>(content);
    return Boolean(
      stringValue(parsed.message) ||
      stringValue(parsed.text) ||
      parsed.selectedItemIds ||
      parsed.selectedProductIds ||
      parsed.suggestedOutfit ||
      parsed.visualRequest ||
      parsed.artifactTitle,
    );
  } catch {
    return Boolean(content.trim() && !content.trim().startsWith('{'));
  }
}

async function readOllamaChatStream(
  response: Response,
  onTextDelta?: (delta: string) => void,
): Promise<string> {
  if (!response.body) {
    const body = (await response.json()) as { message?: { content?: string } };
    return body.message?.content ?? '';
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const textExtractor = new StreamingJsonTextExtractor();
  let buffer = '';
  let content = '';

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const parsed = JSON.parse(line) as { message?: { content?: string } };
        const chunk = parsed.message?.content ?? '';
        if (chunk) {
          content += chunk;
          const delta = textExtractor.next(content);
          if (delta) onTextDelta?.(delta);
        }
      }
      newline = buffer.indexOf('\n');
    }
    if (done) break;
  }
  if (buffer.trim()) {
    const parsed = JSON.parse(buffer.trim()) as { message?: { content?: string } };
    const chunk = parsed.message?.content ?? '';
    if (chunk) {
      content += chunk;
      const delta = textExtractor.next(content);
      if (delta) onTextDelta?.(delta);
    }
  }
  return content;
}

function normalizeUserText(message: string): string {
  return message.trim().replace(/\s+/g, ' ');
}

export function ensurePerceptionState(state: { perception?: PerceptionState; visualCache?: { observation: VisualObservation; cachedAt: string; observationId?: string; analyzedAt?: number; expiresAt?: number; sourceFrameId?: string; imageId?: string } }): PerceptionState {
  if (!state.perception) {
    const analyzedAt = state.visualCache?.analyzedAt ?? (state.visualCache ? Date.parse(state.visualCache.cachedAt) : undefined);
    const confidence = state.visualCache ? confidenceForObservation(state.visualCache.observation) : undefined;
    state.perception = {
      cameraActive: false,
      latestFrameId: state.visualCache?.imageId,
      frameReceivedAt: analyzedAt,
      observationId: state.visualCache?.observationId,
      sourceFrameId: state.visualCache?.sourceFrameId ?? state.visualCache?.imageId,
      analyzedAt,
      expiresAt: state.visualCache?.expiresAt,
      status: state.visualCache ? (confidence && confidence >= 0.5 ? 'observed' : 'unclear') : 'no_camera',
      visibleRegion: state.visualCache ? visibleRegionForObservation(state.visualCache.observation) : undefined,
      confidence,
      summary: state.visualCache ? summarizeObservation(state.visualCache.observation) : undefined,
    };
  }
  expirePerceptionIfNeeded(state.perception);
  return state.perception;
}

export function updatePerceptionFromTurnInput(context: FashionAgentContext, input: FashionTurnInput): void {
  const perception = ensurePerceptionState(context.state);
  if (typeof input.cameraLocalActive === 'boolean') perception.cameraActive = input.cameraLocalActive;
  if (context.state.currentUserImageId) {
    perception.latestFrameId = context.state.currentUserImageId;
    perception.frameReceivedAt = Date.parse(context.nowIso);
    const hasFreshObservation = perception.status === 'observed' &&
      (!perception.expiresAt || Date.now() <= perception.expiresAt);
    if (!hasFreshObservation && (perception.status !== 'observed' || perception.sourceFrameId !== context.state.currentUserImageId)) {
      perception.status = 'frame_received';
    }
    perception.failureReason = undefined;
  } else if (perception.cameraActive && perception.status === 'no_camera') {
    perception.status = 'preview_only';
  }
}

export function updatePerceptionFromMirrorFrame(context: FashionAgentContext, input: MirrorFrameInput): void {
  const perception = ensurePerceptionState(context.state);
  if (typeof input.cameraLocalActive === 'boolean') perception.cameraActive = input.cameraLocalActive;
  if (context.state.currentUserImageId) {
    perception.latestFrameId = context.state.currentUserImageId;
    perception.frameReceivedAt = Date.parse(context.nowIso);
    const hasFreshObservation = perception.status === 'observed' &&
      (!perception.expiresAt || Date.now() <= perception.expiresAt);
    if (!hasFreshObservation) perception.status = 'frame_received';
    perception.failureReason = undefined;
  } else if (perception.cameraActive) {
    perception.status = 'preview_only';
  }
}

export function updatePerceptionObservation(
  context: FashionAgentContext,
  observation: VisualObservation,
  _source: 'quick' | 'deep',
  ttlMs = 10_000,
): void {
  const perception = ensurePerceptionState(context.state);
  const analyzedAt = Date.now();
  const sourceFrameId = context.state.currentUserImageId ?? perception.latestFrameId;
  const observationId = makeId('observation');
  const confidence = confidenceForObservation(observation);
  perception.observationId = observationId;
  perception.sourceFrameId = sourceFrameId;
  perception.analyzedAt = analyzedAt;
  perception.expiresAt = analyzedAt + ttlMs;
  perception.status = confidence >= 0.5 ? 'observed' : 'unclear';
  perception.visibleRegion = visibleRegionForObservation(observation);
  perception.confidence = confidence;
  perception.summary = summarizeObservation(observation);
  perception.failureReason = confidence < 0.5 ? 'unclear_frame' : undefined;
  if (context.state.visualCache) {
    context.state.visualCache.observationId = observationId;
    context.state.visualCache.sourceFrameId = sourceFrameId;
    context.state.visualCache.analyzedAt = analyzedAt;
    context.state.visualCache.expiresAt = perception.expiresAt;
  }
}

export function applyCachedPerceptionObservation(
  context: FashionAgentContext,
  cached: NonNullable<FashionAgentContext['state']['visualCache']>,
): void {
  const perception = ensurePerceptionState(context.state);
  const analyzedAt = cached.analyzedAt ?? Date.parse(cached.cachedAt);
  const observationId = cached.observationId ?? makeId('observation');
  const sourceFrameId = cached.sourceFrameId ?? cached.imageId ?? perception.latestFrameId;
  const confidence = confidenceForObservation(cached.observation);
  cached.observationId = observationId;
  cached.sourceFrameId = sourceFrameId;
  cached.analyzedAt = analyzedAt;
  cached.expiresAt = cached.expiresAt ?? analyzedAt + 10_000;
  perception.observationId = observationId;
  perception.sourceFrameId = sourceFrameId;
  perception.analyzedAt = analyzedAt;
  perception.expiresAt = cached.expiresAt;
  perception.status = confidence >= 0.5 ? 'observed' : 'unclear';
  perception.visibleRegion = visibleRegionForObservation(cached.observation);
  perception.confidence = confidence;
  perception.summary = summarizeObservation(cached.observation);
  perception.failureReason = confidence < 0.5 ? 'unclear_frame' : undefined;
}

function expirePerceptionIfNeeded(perception: PerceptionState): void {
  if (perception.status !== 'observed' || !perception.expiresAt || Date.now() <= perception.expiresAt) return;
  perception.status = perception.cameraActive ? 'preview_only' : 'no_camera';
  perception.confidence = undefined;
  perception.failureReason = perception.cameraActive ? 'unclear_frame' : 'no_frame';
}

export function updatePerceptionFailure(
  context: FashionAgentContext,
  reason: NonNullable<PerceptionState['failureReason']>,
): void {
  const perception = ensurePerceptionState(context.state);
  perception.failureReason = reason;
  if (reason === 'no_frame' || reason === 'permission') {
    perception.status = reason === 'permission' ? 'failed' : (perception.cameraActive ? 'preview_only' : 'no_camera');
    perception.confidence = undefined;
  } else {
    perception.status = 'failed';
    perception.confidence = Math.min(perception.confidence ?? 0.25, 0.25);
  }
}

function confidenceForObservation(observation: VisualObservation): number {
  const visibleCount = observation.visibleItems.length;
  const uncertaintyText = observation.uncertainties.join(' ');
  if (!visibleCount) return 0.2;
  if (/看不清|模糊|低光|遮挡|只.*脸|上半身|不完整|uncertain|blurry/i.test(uncertaintyText)) {
    return visibleCount >= 2 ? 0.55 : 0.35;
  }
  return visibleCount >= 2 ? 0.85 : 0.65;
}

function visibleRegionForObservation(observation: VisualObservation): PerceptionState['visibleRegion'] {
  const categories = new Set(observation.visibleItems.map((item) => item.category));
  if (categories.has('shoes') && (categories.has('bottom') || categories.has('dress') || categories.has('jumpsuit'))) {
    return 'full_body';
  }
  if (categories.has('top') || categories.has('outerwear')) return 'upper_body';
  return 'partial';
}

function summarizeObservation(observation: VisualObservation): string {
  const items = observation.visibleItems
    .slice(0, 3)
    .map((item) => `${item.color}${item.description || item.category}`)
    .join('、');
  const uncertainty = observation.uncertainties[0];
  if (!items) return uncertainty ? `画面还不够清楚：${uncertainty}` : '画面里没有稳定识别到衣着单品。';
  return uncertainty ? `看到 ${items}，但${uncertainty}` : `看到 ${items}`;
}

function mirrorStatusReply(
  perception: PerceptionState,
  observation?: VisualObservation,
): string {
  if (observation && perception.status === 'observed') {
    return `能看到一部分。${perception.summary ?? '我已经拿到当前画面的衣着观察'}；如果你想让我认真判断这身，我可以继续看比例、颜色和场合适配。`;
  }
  if (observation) {
    return `我这边拿到画面了，但还没看得很清楚。${perception.summary ?? '可能是角度、距离或光线影响'}；你可以稍微退后一点，让上衣、下装和鞋都进画面。`;
  }
  if (perception.cameraActive || perception.status === 'frame_received' || perception.status === 'preview_only') {
    return '左侧是你的本地镜子预览，但我这边还没拿到清晰的视觉分析结果。你可以稍微退后一点，或者重新发一句“现在看我这身可以吗”。';
  }
  return '我现在还没有可分析的镜子画面。你可以先开启左侧镜子，或者直接发一张全身照给我看。';
}

const DEMO_STYLING_PROFILE: StylingProfile = {
  presentationPreference: 'unknown',
  presentationOpenness: 'open',
  recommendationScope: 'neutral_core',
  expressionIntensity: 'balanced',
  preferenceMemoryScope: 'turn',
  fitPreference: 'regular',
  source: 'unknown',
};

type StylingOverride = NonNullable<FashionTurnInput['stylingProfileOverride']>;

export function ensureStylingProfile(context: FashionAgentContext): { profile: StylingProfile; snapshotId: string } {
  if (!context.state.stylingProfile) {
    context.state.stylingProfile = {
      ...(validatedPersistentStylingProfile(context) ?? DEMO_STYLING_PROFILE),
      updatedAt: context.nowIso,
    };
  }
  return {
    profile: context.state.stylingProfile,
    snapshotId: stylingProfileSnapshotId(context.state.stylingProfile),
  };
}

export function applyStatefulStylingOverride(
  context: FashionAgentContext,
  override: FashionTurnInput['stylingProfileOverride'],
): void {
  const parsed = normalizeStylingOverride(override);
  if (!parsed || parsed.scope === 'turn') return;
  const base = ensureStylingProfile(context).profile;
  const next = mergeStylingOverride(base, parsed, parsed.scope === 'persistent' ? 'explicit_user' : 'session_override', context.nowIso);
  if (parsed.scope === 'persistent' && !context.permissions.allowPersistentMemory) return;
  context.state.stylingProfile = next;
  if (parsed.scope === 'persistent') {
    context.state.persistentPreferences.stylingProfile = next as unknown as Record<string, unknown>;
  }
}

export function resolveEffectiveStylingProfile(
  context: FashionAgentContext,
  query: HarnessClosetQuery,
  inputOverride?: FashionTurnInput['stylingProfileOverride'],
): StylingProfile {
  const base = ensureStylingProfile(context).profile;
  const toolOverride = normalizeStylingOverride({
    presentationPreference: query.presentationPreference,
    presentationOpenness: query.presentationOpenness,
    recommendationScope: query.recommendationScope,
    expressionIntensity: query.expressionIntensity,
    preferenceMemoryScope: query.preferenceMemoryScope ?? query.profileScope,
    styleTone: query.styleTone,
    scope: query.profileScope ?? 'turn',
  });
  const explicitOverride = normalizeStylingOverride(inputOverride);
  const chosenOverride = toolOverride ?? explicitOverride;
  if (!chosenOverride) return base;
  if (chosenOverride.scope !== 'turn') {
    applyStatefulStylingOverride(context, chosenOverride);
    return ensureStylingProfile(context).profile;
  }
  return mergeStylingOverride(base, chosenOverride, 'session_override', context.nowIso);
}

function normalizeStylingOverride(
  override: FashionTurnInput['stylingProfileOverride'] | undefined,
): StylingOverride | undefined {
  if (!override) return undefined;
  const presentationPreference = parsePresentationPreference(override.presentationPreference);
  const presentationOpenness = parsePresentationOpenness(override.presentationOpenness);
  const recommendationScope = parseRecommendationScope(override.recommendationScope);
  const expressionIntensity = parseExpressionIntensity(override.expressionIntensity);
  const preferenceMemoryScope = parseProfileScope(override.preferenceMemoryScope);
  const styleTone = parseStyleTone(override.styleTone);
  const scope = parseProfileScope(override.scope) ?? preferenceMemoryScope ?? 'turn';
  if (!presentationPreference && !presentationOpenness && !recommendationScope && !expressionIntensity && !styleTone) return undefined;
  return {
    presentationPreference,
    presentationOpenness,
    recommendationScope,
    expressionIntensity,
    preferenceMemoryScope: preferenceMemoryScope ?? scope,
    styleTone,
    scope,
  };
}

function mergeStylingOverride(
  base: StylingProfile,
  override: StylingOverride,
  source: StylingProfile['source'],
  updatedAt: string,
): StylingProfile {
  return {
    ...base,
    presentationPreference: override.presentationPreference ?? presentationPreferenceForScope(override.recommendationScope) ?? base.presentationPreference,
    presentationOpenness: override.presentationOpenness ?? presentationOpennessForScope(override.recommendationScope) ?? base.presentationOpenness,
    recommendationScope: override.recommendationScope ?? base.recommendationScope ?? 'neutral_core',
    expressionIntensity: override.expressionIntensity ?? base.expressionIntensity ?? 'balanced',
    preferenceMemoryScope: override.preferenceMemoryScope ?? override.scope ?? base.preferenceMemoryScope ?? 'turn',
    styleTone: override.styleTone ?? base.styleTone,
    source,
    updatedAt,
  };
}

function validatedPersistentStylingProfile(context: FashionAgentContext): StylingProfile | undefined {
  const value = context.state.persistentPreferences.stylingProfile;
  if (!value || typeof value !== 'object') return undefined;
  const record = value as unknown as Partial<StylingProfile>;
  const presentationPreference = parsePresentationPreference(record.presentationPreference);
  const presentationOpenness = parsePresentationOpenness(record.presentationOpenness);
  if (!presentationPreference || !presentationOpenness) return undefined;
  return {
    presentationPreference,
    presentationOpenness,
    recommendationScope: parseRecommendationScope(record.recommendationScope) ?? recommendationScopeForPresentation(presentationPreference),
    expressionIntensity: parseExpressionIntensity(record.expressionIntensity) ?? 'balanced',
    preferenceMemoryScope: parseProfileScope(record.preferenceMemoryScope) ?? 'persistent',
    styleTone: parseStyleTone(record.styleTone),
    fitPreference: record.fitPreference,
    source: record.source === 'explicit_user' ? 'explicit_user' : 'unknown',
    updatedAt: record.updatedAt,
  };
}

function planningContract(): string {
  return `## 当前阶段：Muse agent planning
你是唯一的 Muse 主 Agent。你可以选择零个、一个或多个工具；代码不会替你判断“这句话是不是衣柜/摄像头/天气”。
如果不需要工具，直接给 answerDraft。需要工具时输出 toolCalls。不要为了展示能力而调用工具。

JSON shape:
{
  "answerDraft": "如果不需要外部工具，可直接给用户看的自然回复",
  "confidence": 0.0,
	  "toolCalls": [
	    { "name": "observe_current_frame", "arguments": {} },
	    { "name": "recommend_from_closet", "arguments": { "query": "聚餐", "limit": 12, "mustUseItemIds": [], "recommendationScope": "neutral_core", "expressionIntensity": "balanced", "profileScope": "turn" } },
	    { "name": "get_item_images", "arguments": { "itemIds": [] } },
	    { "name": "get_weather", "arguments": { "location": "default" } },
	    { "name": "create_style_visual", "arguments": { "visualType": "outfit_visual", "mode": "flatlay", "aspectRatio": "4:5" } },
	    { "name": "edit_style_visual", "arguments": { "changeRequest": "把外套换成黑色" } },
	    { "name": "restore_visual_version", "arguments": { "versionRef": "previous" } }
	  ],
  "skillRequests": [
    { "skill": "occasion-styling", "reference": "occasion-guide.md" }
  ],
  "saveOutfit": {
    "id": "short_stable_id",
    "name": "搭配名称",
    "occasion": "场合",
    "items": [
      { "category": "top", "name": "单品描述", "color": "颜色", "fit": "版型", "source": "suggested" }
    ],
    "stylingActions": ["具体穿法动作"],
    "rationale": "为什么这样搭"
  }
}

规划规则：
- toolCalls 只能包含上面列出的工具名。
- 允许同一轮调用多个工具，例如视觉 + 衣柜 + 天气。
- 你自己判断是否需要工具；不确定时可以少量澄清，也可以先用已有上下文回答。
- answerDraft 只适用于完全不依赖外部状态的轻对话。只要回复会涉及当前画面、镜子预览、照片、是否看清、当前穿着或视觉状态，就必须调用 observe_current_frame 或 get_perception_status，不能直接凭空回答。
- 当前应用状态里的 currentUserImageAvailable/perception 只表示“有可取证据”，不等于你已经看过；看图或判断看没看清都要先调用视觉/状态工具。
- 需要专业方法时可设置 skillRequests；普通轻对话不要加载 skill。
- recommend_from_closet 的 presentationPreference/profileScope/styleTone 只能表达用户本轮或显式 UI 的要求；不要伪造长期 profile、profile source 或 size profile。
- 用户明确指定一件衣服时，把它放进 mustUseItemIds；这只代表本轮 must-use，不代表永久偏好。
- 如果输出 generate_try_on_preview 或 edit_try_on_preview，runtime 仍会检查照片授权。`;
}

function synthesisContract(): string {
  return `## 当前阶段：synthesis_call
你已经拿到本轮实际执行过的工具结果。请输出 grounding envelope；不要再请求新的工具计划。

JSON shape:
{
  "message": "给用户看的自然中文回复",
  "grounding": {
    "perceptionObservationIds": [],
    "closetItemIds": [],
    "productIds": [],
    "closetRecommendationIds": [],
    "selectedLookCandidateIds": [],
    "stylingProfileSnapshotId": ""
  },
  "selectedItemIds": ["closet item id"],
  "selectedProductIds": ["product id"],
  "suggestedOutfit": {
    "id": "short_stable_id",
    "name": "搭配名称",
    "occasion": "场合",
    "items": [
      { "category": "top", "name": "单品描述", "color": "颜色", "fit": "版型", "source": "suggested" }
    ],
    "stylingActions": ["具体穿法动作"],
    "rationale": "为什么这样搭"
  },
  "visualRequest": {
    "type": "outfit_visual",
    "mode": "flatlay",
    "aspectRatio": "4:5",
    "extraInstruction": "可选补充"
  },
  "artifactTitle": "展示给用户看的单品卡片标题",
  "outfitName": "本套搭配名称",
  "occasion": "场合",
  "stylingActions": ["具体穿法动作"],
  "rationale": "内部简短理由"
}

综合规则：
- message 控制在 80-140 个中文字，像镜子前的造型师快速建议；不要写长段背景解释。
- 如果工具结果里没有可用视觉观察，要诚实说当前画面没看清或只能先按文字判断。
- selectedItemIds 只能包含候选里真实存在、且你确实要用的衣柜单品。
- selectedProductIds 只能包含 search_products 返回的商品 id。
- 如果候选不够完整或不够适合，不要硬凑。selectedItemIds 可以只放 1-3 件最合适的真实衣柜单品；message 必须自然说明缺什么，并用 suggestedOutfit.items 只补充柜外建议单品，source 写 "suggested"。
- 如果 selectedItemIds 已经组成完整衣柜穿搭，不要输出 suggestedOutfit.items；只用 outfitName、occasion、stylingActions 表达名称和穿法，避免重复长 JSON。
- 如果工具结果显示 fitStatus 为 unknown，不要声称肯定合身；可以提醒从剪裁和风格上适配，实际尺寸需试穿确认。
- grounding 只能引用本轮工具结果里真实存在的 observation/item/product id；后端会重新校验，不要编造。`;
}

function parseHarnessPlan(parsed: GemmaStructuredResponse, userMessage: string): HarnessPlan {
  const record = parsed as Record<string, unknown>;
  const toolCalls = parseToolCalls(record.toolCalls ?? record.toolPlan);
  const closetQuery = parseClosetQuery(record.closetQuery, userMessage);
  const productQuery = parseProductQuery(record.productQuery, userMessage);
  const weatherRequest = parseWeatherRequest(record.weatherRequest);
  const skillRequests = parseSkillRequests(record.skillRequests);
  const visualRequest = parseVisualRequest(record.visualRequest);
  const answerDraft = stringValue(record.answerDraft) ?? stringValue(record.text);
  const saveOutfit = parseSuggestedOutfit(record.saveOutfit) ?? parseSuggestedOutfit(record.suggestedOutfit);
  const confidence = numberValue(record.confidence, answerDraft ? 0.8 : 0.45);
  const toolNames = new Set(toolCalls.map((call) => call.name));
  return {
    answerDraft,
    needsPerceptionStatus:
      booleanValue(record.needsPerceptionStatus) ||
      toolNames.has('get_perception_status'),
    needsVision:
      booleanValue(record.needsVision) ||
      toolNames.has('observe_current_frame'),
    closetQuery:
      closetQuery ??
      (toolNames.has('recommend_from_closet') || toolNames.has('get_item_images')
        ? parseClosetQuery(toolCalls.find((call) => call.name === 'recommend_from_closet')?.arguments, userMessage) ?? { query: userMessage, limit: 12 }
        : undefined),
    weatherRequest:
      weatherRequest ??
      (toolNames.has('get_weather')
        ? parseWeatherRequest(toolCalls.find((call) => call.name === 'get_weather')?.arguments) ?? {}
        : undefined),
    productQuery:
      productQuery ??
      (toolNames.has('search_products')
        ? parseProductQuery(toolCalls.find((call) => call.name === 'search_products')?.arguments, userMessage) ?? { query: userMessage, limit: 6 }
        : undefined),
    skillRequests,
    visualRequest:
      visualRequest ??
      (toolNames.has('generate_outfit_visual') ||
      toolNames.has('generate_try_on_preview') ||
      toolNames.has('edit_try_on_preview')
        ? parseVisualRequest(toolCalls.find((call) =>
            call.name === 'generate_outfit_visual' ||
            call.name === 'generate_try_on_preview' ||
            call.name === 'edit_try_on_preview',
          )?.arguments) ?? { type: toolNames.has('generate_outfit_visual') ? 'outfit_visual' : 'try_on' }
        : undefined),
    saveOutfit,
    confidence,
  };
}

function sanitizeHarnessPlan(plan: HarnessPlan, _userMessage: string): HarnessPlan {
  return plan;
}

function enforcePlanningInvariants(context: FashionAgentContext, plan: HarnessPlan): HarnessPlan {
  if (plan.needsVision || plan.needsPerceptionStatus || !plan.answerDraft) return plan;
  if (!hasVisualGroundingLanguage(plan.answerDraft)) return plan;
  const perception = ensurePerceptionState(context.state);
  const hasMirrorEvidence =
    perception.cameraActive ||
    Boolean(context.state.currentUserImageId) ||
    perception.status === 'frame_received' ||
    perception.status === 'preview_only' ||
    perception.status === 'observed' ||
    perception.status === 'unclear';
  if (!hasMirrorEvidence) return plan;
  return {
    ...plan,
    answerDraft: undefined,
    needsVision: context.permissions.allowVisualAnalysis,
    needsPerceptionStatus: true,
    confidence: Math.min(plan.confidence, 0.45),
  };
}

function hasVisualGroundingLanguage(text: string): boolean {
  return /看见|看到|看清|没看|画面|镜子|照片|图片|实时|预览|当前帧|当前画面|camera|video|image|photo|mirror|visible|see/i.test(text);
}

type MuseToolName =
  | 'observe_current_frame'
  | 'get_perception_status'
  | 'recommend_from_closet'
  | 'get_item_images'
  | 'get_weather'
  | 'search_products'
  | 'generate_outfit_visual'
  | 'generate_try_on_preview'
  | 'edit_try_on_preview'
  | 'retrieve_style_strategy';

function parseToolCalls(value: unknown): Array<{ name: MuseToolName; arguments?: Record<string, unknown> }> {
  const calls: Array<{ name: MuseToolName; arguments?: Record<string, unknown> }> = [];
  if (!Array.isArray(value)) return calls;
  for (const item of value) {
    if (typeof item === 'string') {
      const name = normalizeToolName(item);
      if (name) calls.push({ name });
      continue;
    }
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const name = stringValue(record.tool) ?? stringValue(record.name) ?? stringValue(record.toolName);
      const normalized = name ? normalizeToolName(name) : undefined;
      if (!normalized) continue;
      const args = record.arguments && typeof record.arguments === 'object'
        ? record.arguments as Record<string, unknown>
        : record.args && typeof record.args === 'object'
          ? record.args as Record<string, unknown>
          : record;
      calls.push({ name: normalized, arguments: args });
    }
  }
  return calls;
}

function normalizeToolName(value: string): MuseToolName | undefined {
  const normalized = value.trim();
  const aliases: Record<string, MuseToolName> = {
    observe_mirror: 'observe_current_frame',
    analyze_current_view: 'observe_current_frame',
    search_wardrobe: 'recommend_from_closet',
    search_closet: 'recommend_from_closet',
    render_outfit_visual: 'generate_outfit_visual',
  };
  const name = aliases[normalized] ?? normalized;
  const valid = new Set<MuseToolName>([
    'observe_current_frame',
    'get_perception_status',
    'recommend_from_closet',
    'get_item_images',
    'get_weather',
    'search_products',
    'generate_outfit_visual',
    'generate_try_on_preview',
    'edit_try_on_preview',
    'retrieve_style_strategy',
  ]);
  return valid.has(name as MuseToolName) ? name as MuseToolName : undefined;
}

export function parseClosetQuery(value: unknown, userMessage: string): HarnessClosetQuery | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const query = stringValue(record.query) ?? userMessage;
  const parsed: HarnessClosetQuery = { query, limit: Math.min(numberValue(record.limit, 12), 12) };
  const categories = stringArray(record.categories);
  const colors = stringArray(record.colors);
  const formality = stringValue(record.formality);
  const mustUseItemIds = stringArray(record.mustUseItemIds);
  const keepItemIds = stringArray(record.keepItemIds);
  const constraints = stringArray(record.constraints);
  const presentationPreference = parsePresentationPreference(record.presentationPreference);
  const presentationOpenness = parsePresentationOpenness(record.presentationOpenness);
  const styleTone = parseStyleTone(record.styleTone);
  const recommendationScope = parseRecommendationScope(record.recommendationScope);
  const expressionIntensity = parseExpressionIntensity(record.expressionIntensity);
  const preferenceMemoryScope = parseProfileScope(record.preferenceMemoryScope);
  const profileScope = parseProfileScope(record.profileScope);
  if (categories.length) parsed.categories = categories;
  if (colors.length) parsed.colors = colors;
  if (formality) parsed.formality = formality;
  if (mustUseItemIds.length) parsed.mustUseItemIds = mustUseItemIds;
  if (keepItemIds.length) parsed.keepItemIds = keepItemIds;
  if (constraints.length) parsed.constraints = constraints;
  if (presentationPreference) parsed.presentationPreference = presentationPreference;
  if (presentationOpenness) parsed.presentationOpenness = presentationOpenness;
  if (recommendationScope) parsed.recommendationScope = recommendationScope;
  if (expressionIntensity) parsed.expressionIntensity = expressionIntensity;
  if (preferenceMemoryScope) parsed.preferenceMemoryScope = preferenceMemoryScope;
  if (styleTone) parsed.styleTone = styleTone;
  if (profileScope) parsed.profileScope = profileScope;
  return parsed;
}

function parseProductQuery(value: unknown, userMessage: string): HarnessProductQuery | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const query = stringValue(record.query) ?? userMessage;
  const parsed: HarnessProductQuery = { query, limit: Math.min(numberValue(record.limit, 6), 8) };
  const category = stringValue(record.category);
  const color = stringValue(record.color);
  const maxPrice = numberValue(record.maxPrice, Number.NaN);
  if (category) parsed.category = category;
  if (color) parsed.color = color;
  if (Number.isFinite(maxPrice) && maxPrice > 0) parsed.maxPrice = maxPrice;
  return parsed;
}

function parsePresentationPreference(value: unknown): PresentationPreference | undefined {
  return value === 'masculine' ||
    value === 'androgynous' ||
    value === 'feminine' ||
    value === 'fluid' ||
    value === 'unrestricted' ||
    value === 'unknown'
    ? value
    : undefined;
}

function parsePresentationOpenness(value: unknown): StylingProfile['presentationOpenness'] | undefined {
  return value === 'strict' ||
    value === 'slightly_open' ||
    value === 'open' ||
    value === 'unrestricted'
    ? value
    : undefined;
}

function parseRecommendationScope(value: unknown): RecommendationScope | undefined {
  return value === 'neutral_core' ||
    value === 'menswear_inclusive' ||
    value === 'womenswear_inclusive' ||
    value === 'all'
    ? value
    : undefined;
}

function parseExpressionIntensity(value: unknown): ExpressionIntensity | undefined {
  return value === 'restrained' || value === 'balanced' || value === 'bold' ? value : undefined;
}

function parseStyleTone(value: unknown): StyleTone | undefined {
  return value === 'crisp' ||
    value === 'soft' ||
    value === 'relaxed' ||
    value === 'minimal' ||
    value === 'dramatic'
    ? value
    : undefined;
}

function parseProfileScope(value: unknown): 'turn' | 'session' | 'persistent' | undefined {
  return value === 'turn' || value === 'session' || value === 'persistent' ? value : undefined;
}

function presentationPreferenceForScope(scope: RecommendationScope | undefined): PresentationPreference | undefined {
  if (scope === 'menswear_inclusive') return 'masculine';
  if (scope === 'womenswear_inclusive') return 'feminine';
  if (scope === 'all') return 'unrestricted';
  if (scope === 'neutral_core') return 'unknown';
  return undefined;
}

function presentationOpennessForScope(scope: RecommendationScope | undefined): StylingProfile['presentationOpenness'] | undefined {
  if (scope === 'menswear_inclusive' || scope === 'womenswear_inclusive') return 'open';
  if (scope === 'all') return 'unrestricted';
  if (scope === 'neutral_core') return 'open';
  return undefined;
}

function recommendationScopeForPresentation(preference: PresentationPreference): RecommendationScope {
  if (preference === 'masculine') return 'menswear_inclusive';
  if (preference === 'feminine') return 'womenswear_inclusive';
  if (preference === 'unrestricted' || preference === 'fluid') return 'all';
  return 'neutral_core';
}

function parseWeatherRequest(value: unknown): HarnessWeatherRequest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const location = stringValue(record.location);
  return location ? { location } : {};
}

function buildSynthesisMessage(
  userMessage: string,
  plan: HarnessPlan,
  toolResults: HarnessToolResult[],
): string {
  return `${userMessage}

Harness 已完成本轮需要的工具步骤。请基于工具结果给最终 JSON 回复。

Fast brain plan:
${JSON.stringify({
    needsPerceptionStatus: plan.needsPerceptionStatus,
    needsVision: plan.needsVision,
    closetQuery: plan.closetQuery,
    weatherRequest: plan.weatherRequest,
    productQuery: plan.productQuery,
    skillRequests: plan.skillRequests,
    visualRequest: plan.visualRequest,
    confidence: plan.confidence,
  }, null, 2)}

Tool results:
${JSON.stringify(compactToolResults(toolResults), null, 2)}`;
}

function buildPublicPlanSummary(plan: HarnessPlan): string | undefined {
  const capabilities = capabilitiesForPlan(plan);
  if (!capabilities.length) return undefined;
  if (capabilities.includes('perception') && capabilities.includes('closet')) {
    return '我先看一下当前画面，再从你的真实衣柜里找合适的组合。';
  }
  if (capabilities.includes('perception')) return '我先确认一下你现在的穿搭和画面状态。';
  if (capabilities.includes('closet')) return '我先从你的真实衣柜里找几套合适的组合。';
  if (capabilities.includes('weather')) return '我先确认天气，再把它纳入穿搭判断。';
  if (capabilities.includes('products')) return '我会把柜外补充单独找出来，不会冒充你的衣柜。';
  if (capabilities.includes('outfit_visual')) return '我会准备这套的视觉参考。';
  return undefined;
}

function buildDecisionSummary(args: {
  context: FashionAgentContext;
  plan: HarnessPlan;
  toolResults: HarnessToolResult[];
  grounding: AgentGrounding;
  selectedItems: ClosetItem[];
  products: ProductItem[];
  recommendation?: ClosetRecommendationResult;
  visualObservation?: VisualObservation;
  visualArtifact?: UiArtifact;
}): MuseDecisionSummary | undefined {
  const capabilities = capabilitiesForPlan(args.plan);
  if (!capabilities.length && !args.selectedItems.length && !args.products.length && !args.visualArtifact) return undefined;
  const checked = summaryChecked(args);
  const constraintsApplied = summaryConstraints(args);
  const keyTradeoffs = summaryTradeoffs(args);
  const uncertainties = summaryUncertainties(args);
  const conclusion = summaryConclusion(args);
  if (!checked.length && !constraintsApplied.length && !keyTradeoffs.length && !uncertainties.length) return undefined;
  return {
    checked,
    constraintsApplied,
    keyTradeoffs,
    conclusion,
    uncertainties,
  };
}

function capabilitiesForPlan(plan: HarnessPlan): Array<'perception' | 'closet' | 'weather' | 'products' | 'outfit_visual' | 'try_on' | 'strategy'> {
  const capabilities: Array<'perception' | 'closet' | 'weather' | 'products' | 'outfit_visual' | 'try_on' | 'strategy'> = [];
  if (plan.needsVision || plan.needsPerceptionStatus) capabilities.push('perception');
  if (plan.closetQuery) capabilities.push('closet');
  if (plan.weatherRequest) capabilities.push('weather');
  if (plan.productQuery) capabilities.push('products');
  if (plan.visualRequest?.type === 'try_on') capabilities.push('try_on');
  if (plan.visualRequest?.type === 'outfit_visual') capabilities.push('outfit_visual');
  if (plan.skillRequests.length) capabilities.push('strategy');
  return capabilities;
}

function summaryChecked(args: {
  grounding: AgentGrounding;
  recommendation?: ClosetRecommendationResult;
  visualObservation?: VisualObservation;
  products: ProductItem[];
  toolResults: HarnessToolResult[];
}): string[] {
  const checked: string[] = [];
  if (args.grounding.perceptionObservationIds.length) {
    const visible = args.visualObservation?.visibleItems
      .slice(0, 3)
      .map((item) => `${item.color}${item.description || item.category}`)
      .join('、');
    checked.push(visible ? `当前画面：${visible}` : '当前画面观察');
  }
  if (args.recommendation) {
    const candidateCount = args.recommendation.candidates.length;
    const compatibleCount = args.recommendation.coverage.compatibleItemCount;
    checked.push(`真实衣柜：${compatibleCount} 件兼容单品，${candidateCount} 套候选`);
  }
  if (args.toolResults.some((result) => result.toolName === 'get_weather' && result.status === 'ok')) checked.push('天气信息');
  if (args.products.length) checked.push(`柜外补充：${args.products.length} 个商品候选`);
  return checked.slice(0, 5);
}

function summaryConstraints(args: {
  context: FashionAgentContext;
  recommendation?: ClosetRecommendationResult;
  selectedItems: ClosetItem[];
}): string[] {
	  const constraints: string[] = [];
	  const profile = ensureStylingProfile(args.context).profile;
	  if (args.recommendation && (profile.recommendationScope ?? 'neutral_core') === 'neutral_core') {
	    constraints.push('当前按通用低风险范围排序');
	  } else if (profile.presentationPreference !== 'unknown') {
	    constraints.push(`推荐范围：${presentationPreferenceLabel(profile.presentationPreference)}`);
	  }
	  if (profile.expressionIntensity) constraints.push(`表达强度：${expressionIntensityLabel(profile.expressionIntensity)}`);
	  if (profile.styleTone) constraints.push(`风格目标：${styleToneLabel(profile.styleTone)}`);
  if (args.recommendation?.coverage.excludedForPresentationCount) {
    constraints.push(`排除 ${args.recommendation.coverage.excludedForPresentationCount} 件表达方向不匹配的单品`);
  }
  if (args.recommendation?.coverage.excludedForFitCount) {
    constraints.push(`排除 ${args.recommendation.coverage.excludedForFitCount} 件明确 fit 不兼容单品`);
  }
  if (args.selectedItems.length && !isCompleteOutfit(args.selectedItems)) constraints.push('真实衣柜单品不足以完整成套');
  return constraints.slice(0, 5);
}

function summaryTradeoffs(args: {
  recommendation?: ClosetRecommendationResult;
  selectedItems: ClosetItem[];
}): string[] {
  const tradeoffs: string[] = [];
  if (args.selectedItems.length) {
    tradeoffs.push(`优先保留真实衣柜里确认存在的 ${args.selectedItems.length} 件单品`);
  }
  if (args.recommendation?.coverage.missingCategories.length) {
    tradeoffs.push(`衣柜缺 ${args.recommendation.coverage.missingCategories.map(categoryLabel).join('、')}，柜外补充需单独标记`);
  }
  if (args.recommendation?.status && args.recommendation.status !== 'success') {
    tradeoffs.push('候选覆盖不足时不硬凑完整搭配');
  }
  return tradeoffs.slice(0, 4);
}

function summaryUncertainties(args: {
  recommendation?: ClosetRecommendationResult;
  visualObservation?: VisualObservation;
  selectedItems: ClosetItem[];
}): string[] {
  const uncertainties = new Set<string>();
  for (const uncertainty of args.visualObservation?.uncertainties ?? []) {
    if (uncertainty.trim()) uncertainties.add(uncertainty.trim());
  }
  const candidate = matchRecommendationCandidate(args.recommendation, args.selectedItems);
  if (candidate?.fitStatus === 'unknown') uncertainties.add('没有真实试穿或完整尺码证据，实际肩线、腰围和裤长仍需确认');
  if (args.recommendation?.status === 'needs_presentation_preference') uncertainties.add('穿衣方向会显著影响推荐，需要用户确认');
  return [...uncertainties].slice(0, 4);
}

function summaryConclusion(args: {
  selectedItems: ClosetItem[];
  products: ProductItem[];
  visualArtifact?: UiArtifact;
  recommendation?: ClosetRecommendationResult;
}): string {
  if (args.selectedItems.length) return `选择 ${args.selectedItems.map((item) => item.name).join(' + ')}`;
  if (args.products.length) return '提供柜外补充建议';
  if (args.visualArtifact?.type === 'image') return '已生成视觉参考';
  if (args.recommendation?.status && args.recommendation.status !== 'success') return '衣柜覆盖不足，先说明缺口';
  return '完成本轮建议';
}

function presentationPreferenceLabel(value: PresentationPreference): string {
  const labels: Record<PresentationPreference, string> = {
    masculine: '偏男装',
    androgynous: '偏中性',
    feminine: '偏女装',
    fluid: '风格流动',
    unrestricted: '不设限',
    unknown: '未设置',
  };
  return labels[value];
}

function styleToneLabel(value: StyleTone): string {
  const labels: Record<StyleTone, string> = {
    crisp: '利落',
    soft: '柔和',
    relaxed: '松弛',
    minimal: '极简',
    dramatic: '有存在感',
  };
  return labels[value];
}

function expressionIntensityLabel(value: NonNullable<StylingProfile['expressionIntensity']>): string {
  const labels: Record<string, string> = {
    restrained: '低调',
    balanced: '平衡',
    bold: '鲜明',
  };
  return labels[value] ?? value;
}

function categoryLabel(value: string): string {
  const labels: Record<string, string> = {
    top: '上衣',
    bottom: '下装',
    shoes: '鞋',
    outerwear: '外套',
    dress: '连衣裙',
    jumpsuit: '连体裤',
    bag: '包',
    accessory: '配饰',
  };
  return labels[value] ?? value;
}

function compactToolResults(toolResults: HarnessToolResult[]): Array<{
  toolName: HarnessToolResult['toolName'];
  status: HarnessToolResult['status'];
  summary: string;
  data?: unknown;
  elapsedMs: number;
}> {
  return toolResults.map(({ toolName, status, summary, data, elapsedMs }) => ({
    toolName,
    status,
    summary,
    data,
    elapsedMs,
  }));
}

function responseText(
  parsed: GemmaStructuredResponse,
  rawContent: string,
  selectedItems: ClosetItem[],
  suggestedOutfit?: OutfitCandidate,
  visualArtifact?: UiArtifact,
): string {
  if (visualArtifact?.type === 'notice') {
    return visualArtifact.text;
  }
  if (typeof parsed.message === 'string' && parsed.message.trim()) {
    return parsed.message.trim();
  }
  if (typeof parsed.text === 'string' && parsed.text.trim()) {
    return parsed.text.trim();
  }
  if (rawContent.trim() && !rawContent.trim().startsWith('{')) {
    return rawContent.trim();
  }
  if (selectedItems.length) {
    return `我会用这几件组成一套：${selectedItems.map((item) => item.name).join('、')}。`;
  }
  if (visualArtifact?.type === 'image') {
    return '我把这套生成成视觉参考图了。';
  }
  if (suggestedOutfit) {
    return `我会这样搭：${suggestedOutfit.items.map((item) => `${item.color}${item.name}`).join('、')}。`;
  }
  return '我可以先从你的衣柜里搭一套更稳的方案；你也可以告诉我场合、天气或想要的风格。';
}

export function buildItemGrid(
  parsed: GemmaStructuredResponse,
  items: ClosetItem[],
  titleOverride?: string,
): UiArtifact {
  return {
    type: 'item_grid',
    id: makeId('artifact'),
    title:
      titleOverride ??
      (typeof parsed.artifactTitle === 'string' && parsed.artifactTitle.trim()
        ? parsed.artifactTitle.trim()
        : '小助手推荐单品'),
    items: items.map((item) => ({
      id: item.id,
      name: item.name,
      imageUrl: item.imageUrl,
      source: 'closet' as const,
    })),
  };
}

function buildProductArtifact(
  parsed: GemmaStructuredResponse,
  products: ProductItem[],
): UiArtifact | undefined {
  if (!products.length) return undefined;
  const selectedIds = parseSelectedItemIds(parsed.selectedProductIds);
  const allowedIds = new Set(products.map((product) => product.id));
  const selected = selectedIds.length
    ? products.filter((product) => selectedIds.includes(product.id) && allowedIds.has(product.id))
    : products;
  if (!selected.length) return undefined;
  return {
    type: 'product_cards',
    id: makeId('artifact'),
    title: '柜外可补充单品',
    products: selected.slice(0, 6),
  };
}

export function buildActiveOutfit(
  parsed: GemmaStructuredResponse,
  items: ClosetItem[],
  suggestedOutfit?: OutfitCandidate,
  recommendation?: ClosetRecommendationResult,
): OutfitCandidate {
  const stylingActions = Array.isArray(parsed.stylingActions)
    ? parsed.stylingActions.filter((item): item is string => typeof item === 'string')
    : suggestedOutfit?.stylingActions;
  const rationale =
    typeof parsed.rationale === 'string'
      ? parsed.rationale
      : typeof parsed.text === 'string'
        ? parsed.text
        : suggestedOutfit?.rationale;
  const closetIds = new Set(items.map((item) => item.id));
  const closetCategories = new Set<string>(items.map((item) => item.category));
  const supplementalItems =
    suggestedOutfit?.items.filter((item) => {
      if (item.source === 'closet') return false;
      if (item.itemId && closetIds.has(item.itemId)) return false;
      return !closetCategories.has(item.category);
    }) ?? [];

  const matchedCandidate = matchRecommendationCandidate(recommendation, items);
  return {
    id: makeId('outfit'),
    name:
      typeof parsed.outfitName === 'string' && parsed.outfitName.trim()
        ? parsed.outfitName.trim()
        : suggestedOutfit?.name ?? '小助手推荐搭配',
    occasion:
      typeof parsed.occasion === 'string' && parsed.occasion.trim()
        ? parsed.occasion.trim()
        : suggestedOutfit?.occasion,
    items: [
      ...items.map((item) => ({
        category: item.category,
        name: item.name,
        color: item.color,
        fit: item.fit,
        source: 'closet' as const,
        itemId: item.id,
      })),
      ...supplementalItems.map((item) => ({
        ...item,
        source: 'suggested_complement' as const,
        itemId: undefined,
      })),
    ],
    stylingActions,
    rationale,
    provenance: matchedCandidate?.provenance,
  };
}

export function normalizeSuggestedComplements(outfit: OutfitCandidate): OutfitCandidate {
  return {
    ...outfit,
    items: outfit.items.map((item) => (
      item.source === 'closet'
        ? item
        : { ...item, source: item.source === 'suggested_complement' ? 'suggested_complement' : 'suggested' }
    )),
  };
}

function parseSuggestedOutfit(value: unknown): OutfitCandidate | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const rawItems = Array.isArray(record.items) ? record.items : [];
  const items: OutfitItem[] = [];
  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const category = stringValue(raw.category);
    const name = stringValue(raw.name);
    const color = stringValue(raw.color);
    if (!category || !name || !color) continue;
    const source =
      raw.source === 'catalog' ||
      raw.source === 'closet' ||
      raw.source === 'suggested_complement'
        ? raw.source
        : 'suggested';
    const parsed: OutfitItem = { category, name, color, source };
    const fit = stringValue(raw.fit);
    const itemId = stringValue(raw.itemId);
    if (fit) parsed.fit = fit;
    if (itemId) parsed.itemId = itemId;
    items.push(parsed);
  }
  if (!items.length) return undefined;
  const stylingActions = Array.isArray(record.stylingActions)
    ? record.stylingActions.filter((item): item is string => typeof item === 'string')
    : undefined;
  return {
    id: stringValue(record.id) ?? makeId('outfit'),
    name: stringValue(record.name),
    occasion: stringValue(record.occasion),
    items,
    stylingActions,
    rationale: stringValue(record.rationale),
  };
}

function parseVisualRequest(value: unknown): GemmaVisualRequest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const type = record.type === 'try_on' ? 'try_on' : record.type === 'outfit_visual' ? 'outfit_visual' : undefined;
  if (!type) return undefined;
  const mode =
    record.mode === 'moodboard' || record.mode === 'mannequin' || record.mode === 'flatlay'
      ? record.mode
      : undefined;
  const aspectRatio =
    record.aspectRatio === '1:1' ||
    record.aspectRatio === '3:4' ||
    record.aspectRatio === '4:5' ||
    record.aspectRatio === '9:16' ||
    record.aspectRatio === '16:9'
      ? record.aspectRatio
      : undefined;
  return {
    type,
    mode,
    aspectRatio,
    extraInstruction: stringValue(record.extraInstruction),
  };
}

function parseSkillRequests(value: unknown): GemmaSkillRequest[] {
  const requests = Array.isArray(value) ? value : [];
  const validNames = new Set<string>(runtimeFashionSkillNames);
  const parsed: GemmaSkillRequest[] = [];
  for (const item of requests) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const skill = stringValue(record.skill);
    if (!skill || !validNames.has(skill)) continue;
    const request: GemmaSkillRequest = { skill: skill as RuntimeFashionSkillName };
    const reference = stringValue(record.reference);
    if (reference && /^[a-z0-9][a-z0-9._-]*\.md$/i.test(reference)) {
      request.reference = reference;
    }
    parsed.push(request);
  }
  return parsed;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : [];
}

function numberValue(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'high') return 0.9;
    if (normalized === 'medium') return 0.6;
    if (normalized === 'low') return 0.3;
  }
  return fallback;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 'true';
}

export function freshVisualCache(
  context: FashionAgentContext,
  ttlMs: number,
): NonNullable<FashionAgentContext['state']['visualCache']> | undefined {
  const cached = context.state.visualCache;
  if (!cached) return undefined;
  if (cached.expiresAt && Date.now() > cached.expiresAt) return undefined;
  const ageMs = Date.now() - Date.parse(cached.cachedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > ttlMs) return undefined;
  return cached;
}

export function canUseCachedObservationForCurrentFrame(
  context: FashionAgentContext,
  cached: NonNullable<FashionAgentContext['state']['visualCache']>,
): boolean {
  const currentFrameId = context.state.currentUserImageId ?? ensurePerceptionState(context.state).latestFrameId;
  if (!currentFrameId) return true;
  const cachedFrameId = cached.sourceFrameId ?? cached.imageId;
  return !cachedFrameId || cachedFrameId === currentFrameId;
}

export function shouldUseDeepVision(userMessage: string, observation: VisualObservation): boolean {
  if (!observation.visibleItems.length) return true;
  if (observation.uncertainties.length >= 2) return true;
  const uncertaintyText = observation.uncertainties.join(' ');
  if (/blur|low.light|dark|occlusion|unclear|看不清|模糊|遮挡|光线/i.test(uncertaintyText)) {
    return true;
  }
  return /仔细|细节|腰线|比例|合身|版型|哪里不对|正式|显|适合|协调|评价|改进/i.test(userMessage);
}

function uniqueClosetItems(items: ClosetItem[]): ClosetItem[] {
  const seen = new Set<string>();
  const unique: ClosetItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

export function filterItemsAllowedByRecommendation(
  items: ClosetItem[],
  recommendation?: ClosetRecommendationResult,
): ClosetItem[] {
  if (!recommendation) return items;
  const allowedIds = new Set(recommendation.candidates.flatMap((candidate) => candidate.itemIds));
  return items.filter((item) => allowedIds.has(item.id));
}

export function matchRecommendationCandidate(
  recommendation: ClosetRecommendationResult | undefined,
  items: ClosetItem[],
): ClosetRecommendationResult['candidates'][number] | undefined {
  if (!recommendation || !items.length) return undefined;
  const selected = new Set(items.map((item) => item.id));
  return recommendation.candidates.find((candidate) =>
    items.every((item) => candidate.itemIds.includes(item.id)) ||
    candidate.itemIds.every((id) => selected.has(id)),
  );
}

function matchedRecommendationCandidateIds(
  recommendation: ClosetRecommendationResult | undefined,
  items: ClosetItem[],
): string[] {
  const candidate = matchRecommendationCandidate(recommendation, items);
  return candidate ? [candidate.id] : [];
}

export function validateOutfitProvenance(
  context: FashionAgentContext,
  outfit: OutfitCandidate,
  closetVersion: string,
): string | undefined {
  const provenance = outfit.provenance;
  if (!provenance) return undefined;
  if (provenance.closetVersion !== closetVersion) {
    return '这套搭配来自旧衣柜状态。为了不展示过期单品，我需要先重新按当前衣柜推荐一次。';
  }
  if (provenance.policyVersion !== PRESENTATION_POLICY_VERSION) {
    return '这套搭配来自旧的穿衣适配规则。为了保证结果可信，我需要先重新推荐一次。';
  }
  const currentProfileSnapshotId = ensureStylingProfile(context).snapshotId;
  if (provenance.profileSnapshotId !== currentProfileSnapshotId) {
    return '你已经切换了穿衣方向。这套旧方案需要先重新校验，再生成图片或上身预览。';
  }
  return undefined;
}

function parseSelectedItemIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || seen.has(item)) continue;
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

export function validateGroundingEnvelope(
  context: FashionAgentContext,
  parsed: GemmaStructuredResponse,
  artifacts: UiArtifact[],
  selectedItems: ClosetItem[],
  products: ProductItem[],
  recommendation?: ClosetRecommendationResult,
): AgentGrounding {
  const closetItemIds = selectedItems.map((item) => item.id);
  const productIds = products.map((product) => product.id);
  const perception = ensurePerceptionState(context.state);
  const freshObservationIds =
    perception.status === 'observed' && perception.observationId
      ? [perception.observationId]
      : [];
  const modelGrounding = parseModelGrounding(parsed.grounding);
  const requestedObservationIds = modelGrounding.perceptionObservationIds.length
    ? modelGrounding.perceptionObservationIds.filter((id) => freshObservationIds.includes(id))
    : freshObservationIds;
  const artifactClosetIds = artifacts
    .flatMap((artifact) => {
      if (artifact.type === 'item_grid') return artifact.items.map((item) => item.id);
      if (artifact.type === 'look_board') {
        return artifact.items
          .filter((item) => item.source === 'closet' && item.closetItemId)
          .map((item) => item.closetItemId as string);
      }
      return [];
    });
  const artifactProductIds = artifacts
    .flatMap((artifact) => {
      if (artifact.type === 'product_cards') return artifact.products.map((product) => product.id);
      if (artifact.type === 'look_board') {
        return artifact.items
          .filter((item) => item.source === 'product' && item.productId)
          .map((item) => item.productId as string);
      }
      return [];
    });
  const grounding: AgentGrounding = {
    perceptionObservationIds: requestedObservationIds,
  };
  const candidateIds = new Set(recommendation?.candidates.map((candidate) => candidate.id) ?? []);
  const recommendationIds = recommendation ? [recommendation.recommendationId] : [];
  const modelRecommendationIds = stringArray((modelGrounding as AgentGrounding).closetRecommendationIds);
  const modelLookIds = stringArray((modelGrounding as AgentGrounding).selectedLookCandidateIds);
  const validClosetIds = uniqueStrings([...closetItemIds, ...artifactClosetIds])
    .filter((id) => closetItemIds.includes(id));
  const validProductIds = uniqueStrings([...productIds, ...artifactProductIds])
    .filter((id) => productIds.includes(id));
  if (validClosetIds.length) grounding.closetItemIds = validClosetIds;
  if (validProductIds.length) grounding.productIds = validProductIds;
  const validRecommendationIds = modelRecommendationIds.length
    ? modelRecommendationIds.filter((id) => recommendationIds.includes(id))
    : recommendationIds;
  if (validRecommendationIds.length) grounding.closetRecommendationIds = validRecommendationIds;
  const selectedLookCandidateIds = uniqueStrings([
    ...modelLookIds.filter((id) => candidateIds.has(id)),
    ...matchedRecommendationCandidateIds(recommendation, selectedItems),
  ]);
  if (selectedLookCandidateIds.length) grounding.selectedLookCandidateIds = selectedLookCandidateIds;
  if (recommendation) grounding.stylingProfileSnapshotId = recommendation.profileSnapshotId;
  return grounding;
}

function parseModelGrounding(value: unknown): AgentGrounding {
  if (!value || typeof value !== 'object') return { perceptionObservationIds: [] };
  const record = value as Record<string, unknown>;
  return {
    perceptionObservationIds: stringArray(record.perceptionObservationIds),
    closetItemIds: stringArray(record.closetItemIds),
    productIds: stringArray(record.productIds),
    closetRecommendationIds: stringArray(record.closetRecommendationIds),
    selectedLookCandidateIds: stringArray(record.selectedLookCandidateIds),
    stylingProfileSnapshotId: stringValue(record.stylingProfileSnapshotId),
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function groundResponseText(
  text: string,
  selectedItems: ClosetItem[],
  invalidSelectedIds: string[],
): string {
  if (invalidSelectedIds.length) {
    if (!selectedItems.length) {
      return '我这轮没有拿到可靠的真实衣柜单品，所以不会展示不存在的衣柜图卡。你可以让我换成柜外自由推荐，或者重新说一个场合我再查衣柜。';
    }
    return `我先只保留真实衣柜里确认存在的 ${selectedItems.map((item) => item.name).join('、')}。其它未确认单品不会作为真实衣柜图卡展示；如果需要补足，我会把它明确当作柜外建议。`;
  }
  const notes: string[] = [];
  if (selectedItems.length) {
    const canonicalNames = selectedItems.map((item) => item.name).join('、');
    const alreadyNamesItems = selectedItems.every((item) => text.includes(item.name));
    if (!alreadyNamesItems) {
      notes.push(`真实衣柜图卡以这几件为准：${canonicalNames}。`);
    }
  }
  return notes.length ? `${text}\n\n${notes.join(' ')}` : text;
}

export function elapsedMs(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Operation timed out.')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type LegacyActivityKind = 'thinking' | 'model' | 'skill' | 'tool' | 'vision' | 'weather' | 'state' | 'policy';
type LegacyActivityStatus = 'ok' | 'warning' | 'error' | 'pending';

export function normalizeActivityForTurn(activity: AgentActivity, turnId: string): AgentActivity {
  return {
    ...activity,
    turnId: activity.turnId === 'pending_turn' && turnId ? turnId : activity.turnId,
  };
}

export function activityItem(
  kind: LegacyActivityKind,
  status: LegacyActivityStatus,
  label: string,
  displayDetail?: string,
  id = makeId('activity'),
): AgentActivity {
  const eventType = activityTypeForLegacy(kind, status, label);
  const eventStatus = activityStatusForLegacy(status);
  return {
    id,
    type: eventType,
    turnId: 'pending_turn',
    timestamp: Date.now(),
    status: eventStatus,
    label,
    displayDetail,
    detail: {
      legacyKind: kind,
      legacyStatus: status,
    },
  };
}

function activityStatusForLegacy(status: LegacyActivityStatus): AgentActivity['status'] {
  if (status === 'pending') return 'started';
  if (status === 'ok') return 'completed';
  return 'failed';
}

function activityTypeForLegacy(
  kind: LegacyActivityKind,
  status: LegacyActivityStatus,
  label: string,
): AgentActivity['type'] {
  const suffix =
    status === 'pending'
      ? 'started'
      : status === 'ok'
        ? 'completed'
        : 'failed';
  if (kind === 'vision') return `perception.${suffix}` as AgentActivity['type'];
  if (kind === 'weather') return `weather.${suffix}` as AgentActivity['type'];
  if (kind === 'skill') return `strategy.${suffix}` as AgentActivity['type'];
  if (kind === 'model' || kind === 'thinking') return `synthesis.${suffix}` as AgentActivity['type'];
  if (kind === 'tool') {
    if (/图|图片|生成|上身|视觉/.test(label)) {
      return `generation.${suffix}` as AgentActivity['type'];
    }
    return `wardrobe.${suffix}` as AgentActivity['type'];
  }
  if (kind === 'policy') return 'policy.warning';
  return 'state.updated';
}

function appendClosetGapNote(text: string, note?: string): string {
  if (!note) return text;
  if (text.includes('不存在的衣柜单品') || text.includes('不够组成完整一套')) return text;
  return `${text}\n\n${note}`;
}

export function appendFitUncertaintyNote(
  text: string,
  selectedItems: ClosetItem[],
  recommendation?: ClosetRecommendationResult,
): string {
  const safeText = text
    .replace(/肯定合身/g, '需要试穿确认')
    .replace(/一定合身/g, '需要试穿确认');
  if (!selectedItems.length || !recommendation) return safeText;
  const candidate = matchRecommendationCandidate(recommendation, selectedItems);
  if (candidate?.fitStatus !== 'unknown') return safeText;
  if (safeText.includes('实际') && safeText.includes('试穿')) return safeText;
  return `${safeText}\n\n从剪裁和风格上看这几件更适配；实际肩线、腰围和裤长仍建议试穿确认。`;
}

export function isCompleteOutfit(items: ClosetItem[]): boolean {
  const categories = new Set(items.map((item) => item.category));
  const hasShoes = categories.has('shoes');
  const hasDressBase = categories.has('dress') || categories.has('jumpsuit');
  const hasSeparates = categories.has('top') && categories.has('bottom');
  if (hasDressBase) return hasShoes && items.length >= 3;
  return hasShoes && hasSeparates && items.length >= 3;
}

export function missingOutfitPieces(items: ClosetItem[]): string[] {
  const categories = new Set(items.map((item) => item.category));
  const missing: string[] = [];
  const hasDressBase = categories.has('dress') || categories.has('jumpsuit');

  if (hasDressBase) {
    if (!categories.has('shoes')) missing.push('鞋子');
    if (items.length < 3) missing.push('外套、包或配饰');
    return missing.length ? missing : ['补完整的造型层次'];
  }

  if (!categories.has('top')) missing.push('上装');
  if (!categories.has('bottom')) missing.push('下装');
  if (!categories.has('shoes')) missing.push('鞋子');
  if (items.length < 3 && !missing.length) missing.push('包或配饰');
  return missing.length ? missing : ['补完整的造型层次'];
}

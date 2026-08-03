import type {
  ContextOverride,
  ExplicitPreferenceEvent,
  ExtractedPreferenceIntent,
  MemoryValue,
  OverrideScope,
  PreferenceUiEvent,
} from '../types.js';
import { makeId } from '../utils/ids.js';

export interface MemoryExtractorInput {
  userId: string;
  conversationId: string;
  messageId: string;
  userMessage: string;
  trustedUiEvents?: PreferenceUiEvent[];
  nowIso?: string;
}

export interface MemoryExtractionResult {
  events: ExplicitPreferenceEvent[];
  overrides: Array<Omit<ContextOverride, 'id' | 'createdAt' | 'updatedAt'>>;
}

export function extractPreferenceIntents(input: MemoryExtractorInput): MemoryExtractionResult {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const text = normalizeText(input.userMessage);
  const intents: ExtractedPreferenceIntent[] = [];
  const overrides: MemoryExtractionResult['overrides'] = [];

  for (const event of input.trustedUiEvents ?? []) {
    const value = valueFromUiEvent(event);
    const persistence = event.persistence;
    if (persistence === 'persistent') {
      intents.push({
        subject: 'user',
        operation: 'set',
        durabilityIntent: 'persistent',
        memoryAuthorization: 'explicit',
        value,
        confidence: 1,
      });
    } else {
      overrides.push({
        userId: input.userId,
        conversationId: input.conversationId,
        scope: persistence,
        namespace: value.namespace,
        key: value.key,
        value,
        sourceMessageId: input.messageId,
        validFrom: nowIso,
        validUntil: defaultOverrideExpiry(persistence, nowIso),
      });
    }
  }

  if (isDoNotRemember(text)) {
    return {
      events: [
        buildEvent(input, nowIso, {
          subject: 'user',
          operation: 'do_not_remember',
          durabilityIntent: 'turn',
          memoryAuthorization: 'explicitly_denied',
          value: {
            namespace: 'communication_preference',
            key: 'answer_style',
            values: ['do_not_remember_current_statement'],
          },
          confidence: 1,
        }, 'forbidden'),
      ],
      overrides,
    };
  }

  if (mentionsOtherSubject(text)) {
    return { events: [], overrides };
  }

  const value = extractMemoryValue(text);
  if (!value) return { events: [], overrides };

  const durabilityIntent = inferDurability(text);
  const memoryAuthorization = inferAuthorization(text, durabilityIntent);
  const intent: ExtractedPreferenceIntent = {
    subject: 'user',
    operation: 'set',
    durabilityIntent,
    temporalValidity: durabilityIntent === 'conversation'
      ? { expiresAt: defaultOverrideExpiry('conversation', nowIso) }
      : undefined,
    memoryAuthorization,
    value,
    confidence: memoryAuthorization === 'explicit' ? 1 : 0.86,
  };

  if (durabilityIntent === 'persistent') {
    const status = memoryAuthorization === 'explicit' ? 'captured' : 'needs_confirmation';
    return { events: [buildEvent(input, nowIso, intent, status)], overrides };
  }

  overrides.push({
    userId: input.userId,
    conversationId: input.conversationId,
    scope: durabilityIntent,
    namespace: value.namespace,
    key: value.key,
    value,
    sourceMessageId: input.messageId,
    validFrom: nowIso,
    validUntil: intent.temporalValidity?.expiresAt ?? defaultOverrideExpiry(durabilityIntent, nowIso),
  });
  return { events: [], overrides };
}

export function defaultOverrideExpiry(scope: OverrideScope, nowIso: string): string | undefined {
  const now = new Date(nowIso);
  if (scope === 'turn') return new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  if (scope === 'task') return new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString();
  const localMidnight = new Date(now);
  localMidnight.setHours(23, 59, 59, 999);
  return localMidnight.toISOString();
}

function buildEvent(
  input: MemoryExtractorInput,
  nowIso: string,
  intent: ExtractedPreferenceIntent,
  status: ExplicitPreferenceEvent['status'],
): ExplicitPreferenceEvent {
  return {
    id: makeId('pref'),
    userId: input.userId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    intent,
    status,
    createdAt: nowIso,
  };
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function isDoNotRemember(text: string): boolean {
  return /(不要|别|不用).{0,6}(记住|保存|长期记)/.test(text);
}

function mentionsOtherSubject(text: string): boolean {
  return /(我朋友|朋友|同事|别人|他以后|她以后|他们|她们)/.test(text);
}

function inferDurability(text: string): OverrideScope | 'persistent' {
  if (/(这句话|这个回答|本句)/.test(text)) return 'turn';
  if (/(这套|这身|这个搭配|这张图|当前视觉)/.test(text)) return 'task';
  if (/(今天|今晚|这次|本次|现在|这轮)/.test(text)) return 'conversation';
  if (/(记住|以后|今后|以后都|别再|不要再|长期|平时|一直|总是)/.test(text)) return 'persistent';
  return 'conversation';
}

function inferAuthorization(
  text: string,
  durabilityIntent: OverrideScope | 'persistent',
): ExtractedPreferenceIntent['memoryAuthorization'] {
  if (durabilityIntent !== 'persistent') return 'none';
  if (/(记住|长期保存|作为长期偏好|保存为偏好)/.test(text)) return 'explicit';
  return 'implicit_durable_statement';
}

function extractMemoryValue(text: string): MemoryValue | undefined {
  if (/高领|turtleneck/.test(text) && /(不喜欢|不要|别|避免|不推荐|少推荐)/.test(text)) {
    return {
      namespace: 'avoidance',
      key: 'neckline',
      values: ['turtleneck'],
      strength: /(绝对|永远|完全|硬性)/.test(text) ? 'hard' : 'soft',
    };
  }
  if (/细跟|高跟/.test(text) && /(不喜欢|不要|别|避免|不推荐|少推荐)/.test(text)) {
    return {
      namespace: 'avoidance',
      key: 'shoe_type',
      values: ['thin_heels'],
      strength: /(绝对|永远|完全|硬性)/.test(text) ? 'hard' : 'soft',
    };
  }
  if (/极简|minimal/.test(text)) {
    return {
      namespace: 'style_preference',
      key: 'style_tone',
      values: ['minimal'],
      preferenceStrength: /(很|特别|长期|以后|通勤|平时)/.test(text) ? 'strong' : 'medium',
    };
  }
  if (/大胆|鲜明|有存在感|夸张/.test(text)) {
    return {
      namespace: 'style_preference',
      key: 'expression_intensity',
      values: ['bold'],
      preferenceStrength: /(很|特别|长期|以后|平时)/.test(text) ? 'strong' : 'medium',
    };
  }
  if (/低调|收敛|别太抢眼/.test(text)) {
    return {
      namespace: 'style_preference',
      key: 'expression_intensity',
      values: ['restrained'],
      preferenceStrength: /(很|特别|长期|以后|平时)/.test(text) ? 'strong' : 'medium',
    };
  }
  if (/简短|短一点|直接点/.test(text)) {
    return {
      namespace: 'communication_preference',
      key: 'answer_style',
      values: ['concise'],
    };
  }
  return undefined;
}

function valueFromUiEvent(event: PreferenceUiEvent): MemoryValue {
  if (event.type === 'set_recommendation_scope') {
    return {
      namespace: 'style_preference',
      key: 'recommendation_scope',
      values: [event.scope],
      preferenceStrength: 'medium',
    };
  }
  if (event.type === 'set_expression_intensity') {
    return {
      namespace: 'style_preference',
      key: 'expression_intensity',
      values: [event.intensity],
      preferenceStrength: 'medium',
    };
  }
  return {
    namespace: 'style_preference',
    key: 'style_tone',
    values: [event.tone],
    preferenceStrength: 'medium',
  };
}

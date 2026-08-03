import { createHash } from 'node:crypto';
import type {
  ClosetItem,
  FitStatus,
  PresentationAffinity,
  PresentationCompatibilityResult,
  PresentationPreference,
  StylingProfile,
} from '../types.js';

export const PRESENTATION_POLICY_VERSION = 'presentation_policy_v1';

export interface PresentationCompatibilityContext {
  mustUse?: boolean;
}

export function stylingProfileSnapshotId(profile: StylingProfile): string {
  return `profile_${hashStable({
    presentationPreference: profile.presentationPreference,
    presentationOpenness: profile.presentationOpenness,
    recommendationScope: profile.recommendationScope,
    expressionIntensity: profile.expressionIntensity,
    preferenceMemoryScope: profile.preferenceMemoryScope,
    styleTone: profile.styleTone,
    fitPreference: profile.fitPreference,
    sizeProfile: profile.sizeProfile,
    stylingGoals: profile.stylingGoals,
    avoidedCategories: profile.avoidedCategories,
    avoidedCuts: profile.avoidedCuts,
    source: profile.source,
  })}`;
}

type DirectionalPreference = Extract<PresentationPreference, 'masculine' | 'feminine'>;

const DEFAULT_RESULT: PresentationCompatibilityResult = {
  allowed: true,
  score: 0.55,
  reasonCodes: ['metadata_missing', 'safe_degraded'],
  fitStatus: 'unknown',
  fitConfidence: 0.2,
};

export function evaluatePresentationCompatibility(
  item: ClosetItem,
  profile: StylingProfile,
  context: PresentationCompatibilityContext = {},
): PresentationCompatibilityResult {
  const fit = evaluateFit(item, profile);
  if (fit.fitStatus === 'incompatible') {
    return {
      allowed: false,
      score: 0,
      reasonCodes: ['fit_incompatible', ...fit.reasonCodes],
      fitStatus: fit.fitStatus,
      fitConfidence: fit.fitConfidence,
    };
  }

  const metadata = item.presentationMetadata;
  if (!metadata) {
    return {
      ...DEFAULT_RESULT,
      allowed: context.mustUse ? true : DEFAULT_RESULT.allowed,
      fitStatus: fit.fitStatus,
      fitConfidence: fit.fitConfidence,
    };
  }

  const reasons = new Set<string>(metadata.reasonCodes);
  const preference = profile.presentationPreference;
  const recommendationScope = profile.recommendationScope ?? scopeForPresentation(preference);
  const expressionIntensity = profile.expressionIntensity ?? 'balanced';
  if (context.mustUse) reasons.add('explicit_must_use');

  let allowed = true;
  let score = scoreForPreference(metadata.affinity, preference);
  if (recommendationScope === 'neutral_core' || preference === 'unknown') {
    const neutralScore = Math.max(metadata.affinity.androgynous, balancedAffinity(metadata.affinity));
    const directionalScore = Math.max(metadata.affinity.masculine, metadata.affinity.feminine);
    score = Math.max(0.25, neutralScore);
    reasons.add('neutral_core_ranked');
    if (metadata.intensity === 'strong' && metadata.affinity.androgynous < 0.72 && !context.mustUse) {
      score *= expressionIntensity === 'bold' ? 0.72 : expressionIntensity === 'restrained' ? 0.38 : 0.52;
      if (directionalScore >= 0.78) reasons.add('range_option_high_expression');
      else reasons.add('downrank_strong_directional_expression');
    }
  } else if (preference === 'unrestricted' || preference === 'fluid') {
    score = Math.max(score, metadata.affinity.androgynous, 0.72);
    reasons.add(preference === 'fluid' ? 'fluid_expression_allowed' : 'unrestricted_expression');
  } else if (preference === 'androgynous') {
    score = Math.max(metadata.affinity.androgynous, balancedAffinity(metadata.affinity));
    if (metadata.intensity === 'strong' && metadata.affinity.androgynous < 0.55 && !context.mustUse) {
      score *= 0.55;
      reasons.add('strong_directional_expression');
    }
  } else {
    const directional = evaluateDirectional(metadata.affinity, metadata.intensity, preference, profile.presentationOpenness);
    allowed = directional.allowed;
    score = directional.score;
    for (const reason of directional.reasonCodes) reasons.add(reason);
  }

  if (context.mustUse) allowed = true;
  if (metadata.intensity === 'neutral' || metadata.intensity === 'subtle') reasons.add('low_expression_intensity');
  if (expressionIntensity === 'bold' && metadata.intensity !== 'neutral') {
    score = Math.min(1, score + 0.06);
    reasons.add('expression_intensity_bold');
  }
  if (expressionIntensity === 'restrained' && (metadata.intensity === 'moderate' || metadata.intensity === 'strong')) {
    score *= 0.88;
    reasons.add('expression_intensity_restrained');
  }
  if (metadata.affinity.androgynous >= 0.72) reasons.add('androgynous_compatible');
  if (item.marketedFor) reasons.add(`marketed_for_${item.marketedFor}`);

  return {
    allowed,
    score: clamp(score),
    reasonCodes: [...reasons],
    fitStatus: fit.fitStatus,
    fitConfidence: fit.fitConfidence,
  };
}

function evaluateDirectional(
  affinity: PresentationAffinity,
  intensity: NonNullable<ClosetItem['presentationMetadata']>['intensity'],
  preference: DirectionalPreference,
  openness: StylingProfile['presentationOpenness'],
): { allowed: boolean; score: number; reasonCodes: string[] } {
  const opposite = preference === 'masculine' ? 'feminine' : 'masculine';
  const preferredScore = affinity[preference];
  const oppositeScore = affinity[opposite];
  const neutralBridge = affinity.androgynous;
  const reasons: string[] = [`prefers_${preference}`];

  if (openness === 'unrestricted') {
    return {
      allowed: true,
      score: Math.max(preferredScore, neutralBridge, oppositeScore * 0.85),
      reasonCodes: [...reasons, 'openness_unrestricted'],
    };
  }

  const strongOpposite = oppositeScore >= 0.68 && preferredScore < 0.5 && neutralBridge < 0.72;
  const moderateOpposite = oppositeScore >= 0.62 && preferredScore < 0.45 && neutralBridge < 0.62;

  if (openness === 'strict' && (intensity === 'strong' || intensity === 'moderate') && strongOpposite) {
    return {
      allowed: false,
      score: Math.max(0.05, neutralBridge * 0.35),
      reasonCodes: [...reasons, `excluded_strong_${opposite}`],
    };
  }

  if (openness === 'slightly_open' && intensity === 'strong' && strongOpposite) {
    return {
      allowed: false,
      score: Math.max(0.08, neutralBridge * 0.45),
      reasonCodes: [...reasons, `excluded_strong_${opposite}`],
    };
  }

  let score = Math.max(preferredScore, neutralBridge * 0.92);
  if (moderateOpposite) {
    score *= openness === 'open' ? 0.78 : 0.58;
    reasons.push(`downrank_${opposite}_expression`);
  }
  return { allowed: true, score, reasonCodes: reasons };
}

function scoreForPreference(affinity: PresentationAffinity, preference: PresentationPreference): number {
  if (preference === 'masculine') return Math.max(affinity.masculine, affinity.androgynous * 0.92);
  if (preference === 'feminine') return Math.max(affinity.feminine, affinity.androgynous * 0.92);
  if (preference === 'androgynous') return Math.max(affinity.androgynous, balancedAffinity(affinity));
  if (preference === 'fluid' || preference === 'unrestricted') {
    return Math.max(affinity.masculine, affinity.androgynous, affinity.feminine);
  }
  return Math.max(affinity.androgynous, balancedAffinity(affinity));
}

function scopeForPresentation(preference: PresentationPreference): StylingProfile['recommendationScope'] {
  if (preference === 'masculine') return 'menswear_inclusive';
  if (preference === 'feminine') return 'womenswear_inclusive';
  if (preference === 'unrestricted' || preference === 'fluid') return 'all';
  return 'neutral_core';
}

function balancedAffinity(affinity: PresentationAffinity): number {
  return (Math.min(affinity.masculine, affinity.feminine) + affinity.androgynous) / 2;
}

function evaluateFit(
  item: ClosetItem,
  profile: StylingProfile,
): { fitStatus: FitStatus; fitConfidence: number; reasonCodes: string[] } {
  const reasons: string[] = [];
  if (!item.garmentMeasurements && !profile.sizeProfile) {
    return { fitStatus: 'unknown', fitConfidence: 0.25, reasonCodes: ['fit_data_missing'] };
  }

  if (item.fitCompatibilityTags?.includes('fit_incompatible')) {
    return { fitStatus: 'incompatible', fitConfidence: 0.92, reasonCodes: ['fit_incompatible_tag'] };
  }

  const categorySizeKey = categorySizeKeyFor(item.category);
  const sizePrefs = categorySizeKey ? profile.sizeProfile?.[categorySizeKey] : undefined;
  if (!sizePrefs?.length) {
    return { fitStatus: 'unknown', fitConfidence: 0.35, reasonCodes: ['user_size_unknown'] };
  }

  const itemSizeTags = item.fitCompatibilityTags?.filter((tag) => tag.startsWith('size_')) ?? [];
  if (!itemSizeTags.length) {
    return { fitStatus: 'likely', fitConfidence: 0.55, reasonCodes: ['size_tag_missing'] };
  }

  const matches = itemSizeTags.some((tag) => sizePrefs.includes(tag.slice('size_'.length)));
  if (!matches) {
    return { fitStatus: 'incompatible', fitConfidence: 0.8, reasonCodes: ['size_mismatch'] };
  }
  return { fitStatus: 'likely', fitConfidence: 0.7, reasonCodes: ['size_likely'] };
}

function categorySizeKeyFor(category: ClosetItem['category']): keyof NonNullable<StylingProfile['sizeProfile']> | undefined {
  if (category === 'top' || category === 'dress' || category === 'jumpsuit') return 'tops';
  if (category === 'bottom') return 'bottoms';
  if (category === 'outerwear') return 'outerwear';
  if (category === 'shoes') return 'shoes';
  return undefined;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

function hashStable(value: unknown): string {
  return createHash('sha1').update(stableStringify(value)).digest('hex').slice(0, 12);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

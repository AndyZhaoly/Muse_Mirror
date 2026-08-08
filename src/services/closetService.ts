import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  evaluatePresentationCompatibility,
  PRESENTATION_POLICY_VERSION,
  stylingProfileSnapshotId,
} from '../domain/presentationCompatibility.js';
import type {
  ClosetCoverage,
  ClosetItem,
  ClosetOutfitCandidate,
  ClosetRecommendationResult,
  CutProfile,
  FitStatus,
  GarmentMeasurements,
  PresentationCompatibilityResult,
	  PresentationMetadata,
	  RecommendationScope,
	  StylingProfile,
	  SuggestedComplement,
	} from '../types.js';

export interface ClosetSearchInput {
  query: string;
  categories?: string[];
  colors?: string[];
  formality?: string;
  limit?: number;
}

export interface ClosetRecommendationInput extends ClosetSearchInput {
  profile: StylingProfile;
  mustUseItemIds?: string[];
}

export interface ClosetLookCandidate {
  id: string;
  title: string;
  itemIds: string[];
  categories: ClosetItem['category'][];
  completeness: 'complete' | 'partial';
  score: number;
}

export class ClosetService {
  private readonly items: ClosetItem[];
  private readonly looks: Array<Omit<ClosetLookCandidate, 'score'>>;
  readonly closetVersion: string;

  constructor(
    dataPath = path.resolve('./data/mock-closet.json'),
    presentationMetadataPath?: string,
  ) {
    const metadata = loadPresentationOverlay(presentationMetadataPath);
    const rawItems = JSON.parse(fs.readFileSync(dataPath, 'utf8')) as unknown[];
    const dataDirectory = path.dirname(dataPath);
    this.items = rawItems.map((item) => {
      const id = stringValue((item as Demo2WardrobeItem).id, 'unknown_item');
      const normalized = normalizeClosetItem(item, metadata.get(id));
      return {
        ...normalized,
        imageUrl: resolveClosetImageUrl(normalized.imageUrl, dataDirectory),
        imageStatus: normalized.imageStatus ?? 'ready',
        source: normalized.source ?? 'demo_fixture',
        identityStatus: normalized.identityStatus ?? 'confirmed',
        ownershipStatus: normalized.ownershipStatus ?? 'confirmed',
      };
    });
    this.looks = buildLookCandidates(this.items);
    this.closetVersion = buildClosetVersion(this.items);
  }

  search(input: ClosetSearchInput): ClosetItem[] {
    const scored = this.items
      .filter((item) => {
        if (input.categories?.length && !input.categories.includes(item.category)) {
          return false;
        }
        if (input.colors?.length && !input.colors.includes(item.color)) return false;
        if (input.formality && item.formality !== input.formality) return false;
        return true;
      })
      .map((item) => ({ item, score: scoreItem(item, input.query) }))
      .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));

    return scored.slice(0, input.limit ?? 8).map(({ item }) => item);
  }

  recommend(
    input: ClosetRecommendationInput,
    additionalItems: readonly ClosetItem[] = [],
  ): { result: ClosetRecommendationResult; items: ClosetItem[]; looks: ClosetLookCandidate[] } {
    const createdAt = new Date().toISOString();
    const allItems = uniqueClosetItems([...this.items, ...additionalItems]);
    const closetVersion = additionalItems.length ? buildClosetVersion(allItems) : this.closetVersion;
    const recommendationId = `rec_${hashStable(`${createdAt}:${input.query}:${closetVersion}`)}`;
    const profileSnapshotId = stylingProfileSnapshotId(input.profile);
    const mustUse = new Set(input.mustUseItemIds ?? []);
    const evaluated = allItems
      .filter((item) => matchesSearchInput(item, input) || mustUse.has(item.id))
      .map((item) => ({
        item,
        compatibility: evaluatePresentationCompatibility(item, input.profile, {
          mustUse: mustUse.has(item.id),
        }),
        tokenScore: scoreItem(item, input.query),
      }));

    const compatible = evaluated
      .filter(({ compatibility }) => compatibility.allowed)
      .sort((a, b) =>
        b.compatibility.score - a.compatibility.score ||
        b.tokenScore - a.tokenScore ||
        a.item.name.localeCompare(b.item.name),
      );
    const directItems = compatible.map(({ item }) => item);
    const lookCandidates = this.searchLooks(input)
      .map((look) => buildRecommendationCandidate({
        look,
        items: this.getByIds(look.itemIds),
        evaluated,
        recommendationId,
        profileSnapshotId,
        closetVersion,
        createdAt,
      }))
      .filter((candidate): candidate is ClosetOutfitCandidate => Boolean(candidate))
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    const syntheticCandidate = buildSyntheticCandidate({
      items: directItems,
      evaluated,
      recommendationId,
      profileSnapshotId,
      closetVersion,
      createdAt,
    });
    const candidates = uniqueCandidates([
      ...lookCandidates,
      ...(syntheticCandidate ? [syntheticCandidate] : []),
    ]).slice(0, input.limit ?? 4);
    const candidateItems = this.getByIds(candidates.flatMap((candidate) => candidate.itemIds), additionalItems);
    const items = uniqueClosetItems([...candidateItems, ...directItems]).slice(0, input.limit ?? 12);
    const coverage = buildCoverage(evaluated);
    const status = recommendationStatus(input.profile, candidates, coverage);
	    const result: ClosetRecommendationResult = {
	      recommendationId,
	      profileSnapshotId,
	      policyVersion: PRESENTATION_POLICY_VERSION,
	      closetVersion,
      createdAt,
      status,
      candidates,
	      coverage,
	    };
	    const rangeHint = buildRangeHint(input.profile, evaluated);
	    if (rangeHint) result.rangeHint = rangeHint;
	    if (status === 'needs_presentation_preference') {
	      result.clarification = {
	        question: '你想把推荐范围放宽一点吗？',
	        options: [
	          { id: 'neutral_core', label: '通用稳妥' },
	          { id: 'menswear_inclusive', label: '偏传统男装' },
	          { id: 'womenswear_inclusive', label: '偏传统女装' },
	          { id: 'all', label: '全部都可以' },
	        ],
	      };
	    }
    if (coverage.missingCategories.length) {
      result.suggestedComplements = coverage.missingCategories.map((category) => suggestedComplement(category));
    }
    return {
      result,
      items,
      looks: candidates.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        itemIds: candidate.itemIds,
        categories: candidate.categories,
        completeness: candidate.completeness,
        score: candidate.score,
      })),
    };
  }

  getByIds(ids: string[], additionalItems: readonly ClosetItem[] = []): ClosetItem[] {
    const wanted = new Set(ids);
    return uniqueClosetItems([...this.items, ...additionalItems]).filter((item) => wanted.has(item.id));
  }

  allItems(): ClosetItem[] {
    return this.items.map((item) => ({ ...item, styleTags: [...item.styleTags] }));
  }

  searchLooks(input: ClosetSearchInput): ClosetLookCandidate[] {
    const tokens = input.query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.looks
      .map((look) => {
        const items = this.getByIds(look.itemIds);
        const haystack = [
          look.title,
          look.completeness,
          look.categories.join(' '),
          ...items.flatMap((item) => [
            item.name,
            item.category,
            item.color,
            item.fit,
            item.formality,
            ...item.styleTags,
          ]),
        ]
          .join(' ')
          .toLowerCase();
        const tokenScore = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
        const completenessBoost = look.completeness === 'complete' ? 2 : 0;
        return { ...look, score: tokenScore + completenessBoost + Math.min(look.itemIds.length, 5) / 10 };
      })
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, input.limit ?? 4);
  }
}

function resolveClosetImageUrl(imageUrl: string, dataDirectory: string): string {
  if (
    !imageUrl ||
    path.isAbsolute(imageUrl) ||
    /^https?:\/\//i.test(imageUrl) ||
    imageUrl.startsWith('data:') ||
    imageUrl.startsWith('./public/') ||
    imageUrl.startsWith('public/')
  ) {
    return imageUrl;
  }
  return path.resolve(dataDirectory, imageUrl);
}

interface Demo2WardrobeItem {
  id?: unknown;
  name?: unknown;
  category?: unknown;
  subcategory?: unknown;
  color_family?: unknown;
  fit_volume?: unknown;
  formality_band?: unknown;
  retrieval_text?: unknown;
  normalized_product_image_path?: unknown;
  source_product_image_path?: unknown;
  imageUrl?: unknown;
  styleTags?: unknown;
  length_bucket?: unknown;
  shoe_type?: unknown;
  heel_height?: unknown;
  boot_height?: unknown;
  waistline?: unknown;
  outerwear_length?: unknown;
}

interface PresentationOverlayFile {
  items?: Record<string, PresentationOverlayItem>;
}

interface PresentationOverlayItem {
  marketedFor?: ClosetItem['marketedFor'];
  presentationMetadata?: PresentationMetadata;
  cutProfile?: CutProfile;
  garmentMeasurements?: GarmentMeasurements;
  fitCompatibilityTags?: string[];
}

const COLOR_ZH: Record<string, string> = {
  black: '黑色',
  white: '白色',
  grey: '灰色',
  gray: '灰色',
  navy: '海军蓝',
  blue: '蓝色',
  brown: '棕色',
  beige: '米色',
  pink: '粉色',
  red: '红色',
  green: '绿色',
  yellow: '黄色',
  purple: '紫色',
  metallic: '金属色',
  unknown: '',
};

const CATEGORY_ZH: Record<string, string> = {
  top: '上衣',
  bottom: '下装',
  dress: '连衣裙',
  jumpsuit: '连体裤',
  outerwear: '外套',
  shoes: '鞋',
  bag: '包',
  accessory: '配饰',
};

function normalizeClosetItem(raw: unknown, overlay?: PresentationOverlayItem): ClosetItem {
  const item = raw as Demo2WardrobeItem;
  const id = stringValue(item.id, 'unknown_item');
  const category = normalizeCategory(stringValue(item.category, 'accessory'));
  const color = stringValue(item.color_family, stringValue((item as any).color, 'unknown'));
  const subcategory = stringValue(item.subcategory, '');
  const retrievalText = stringValue(item.retrieval_text, '');

  const normalized: ClosetItem = {
    id,
    name: stringValue(item.name, buildName({ category, color, subcategory, retrievalText })),
    category,
    color,
    fit: stringValue(item.fit_volume, stringValue((item as any).fit, 'unknown')),
    formality: stringValue(item.formality_band, stringValue((item as any).formality, 'casual')),
    styleTags: styleTags(item),
    imageUrl: stringValue(
      item.imageUrl,
      stringValue(item.normalized_product_image_path, stringValue(item.source_product_image_path, '')),
    ),
  };
  if (overlay?.marketedFor) normalized.marketedFor = overlay.marketedFor;
  if (overlay?.presentationMetadata) normalized.presentationMetadata = overlay.presentationMetadata;
  if (overlay?.cutProfile) normalized.cutProfile = overlay.cutProfile;
  if (overlay?.garmentMeasurements) normalized.garmentMeasurements = overlay.garmentMeasurements;
  if (overlay?.fitCompatibilityTags) normalized.fitCompatibilityTags = overlay.fitCompatibilityTags;
  return normalized;
}

function loadPresentationOverlay(metadataPath: string | undefined): Map<string, PresentationOverlayItem> {
  if (!metadataPath || !fs.existsSync(metadataPath)) return new Map();
  const raw = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as PresentationOverlayFile;
  const entries = Object.entries(raw.items ?? {})
    .filter((entry): entry is [string, PresentationOverlayItem] => Boolean(entry[1]));
  return new Map(entries);
}

function buildRecommendationCandidate(args: {
  look: ClosetLookCandidate;
  items: ClosetItem[];
  evaluated: Array<{ item: ClosetItem; compatibility: PresentationCompatibilityResult; tokenScore: number }>;
  recommendationId: string;
  profileSnapshotId: string;
  closetVersion: string;
  createdAt: string;
}): ClosetOutfitCandidate | undefined {
  const byId = new Map(args.evaluated.map((entry) => [entry.item.id, entry]));
  const entries = args.items.map((item) => byId.get(item.id));
  if (entries.some((entry) => !entry?.compatibility.allowed)) return undefined;
  const validEntries = entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  if (validEntries.length < 2) return undefined;
  const score = validEntries.reduce((sum, entry) => sum + entry.compatibility.score + entry.tokenScore * 0.08, 0) / validEntries.length;
  return {
    id: args.look.id,
    title: args.look.title,
    itemIds: args.look.itemIds,
    categories: args.look.categories,
    completeness: args.look.completeness,
    score: Number((score + (args.look.completeness === 'complete' ? 0.2 : 0)).toFixed(3)),
    reasonCodes: uniqueStrings(validEntries.flatMap((entry) => entry.compatibility.reasonCodes)).slice(0, 12),
    fitStatus: aggregateFitStatus(validEntries.map((entry) => entry.compatibility.fitStatus)),
    provenance: {
      recommendationId: args.recommendationId,
      candidateId: args.look.id,
      closetVersion: args.closetVersion,
      profileSnapshotId: args.profileSnapshotId,
      policyVersion: PRESENTATION_POLICY_VERSION,
      createdAt: args.createdAt,
    },
  };
}

function buildSyntheticCandidate(args: {
  items: ClosetItem[];
  evaluated: Array<{ item: ClosetItem; compatibility: PresentationCompatibilityResult; tokenScore: number }>;
  recommendationId: string;
  profileSnapshotId: string;
  closetVersion: string;
  createdAt: string;
}): ClosetOutfitCandidate | undefined {
  const byId = new Map(args.evaluated.map((entry) => [entry.item.id, entry]));
  const selected: ClosetItem[] = [];
  const categories = new Set<ClosetItem['category']>();
  for (const category of ['outerwear', 'top', 'bottom', 'dress', 'jumpsuit', 'shoes'] as const) {
    const item = args.items.find((candidate) => candidate.category === category && !selected.some((existing) => existing.id === candidate.id));
    if (item) {
      selected.push(item);
      categories.add(item.category);
    }
  }
  if (selected.length < 2) return undefined;
  const entries = selected
    .map((item) => byId.get(item.id))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  const id = `candidate_${hashStable(selected.map((item) => item.id).join(':'))}`;
  return {
    id,
    title: 'compatible closet candidate',
    itemIds: selected.map((item) => item.id),
    categories: [...categories],
    completeness: completeCategories(selected.map((item) => item.category)) ? 'complete' : 'partial',
    score: Number((entries.reduce((sum, entry) => sum + entry.compatibility.score + entry.tokenScore * 0.08, 0) / entries.length).toFixed(3)),
    reasonCodes: uniqueStrings(entries.flatMap((entry) => entry.compatibility.reasonCodes)).slice(0, 12),
    fitStatus: aggregateFitStatus(entries.map((entry) => entry.compatibility.fitStatus)),
    provenance: {
      recommendationId: args.recommendationId,
      candidateId: id,
      closetVersion: args.closetVersion,
      profileSnapshotId: args.profileSnapshotId,
      policyVersion: PRESENTATION_POLICY_VERSION,
      createdAt: args.createdAt,
    },
  };
}

function buildCoverage(
  evaluated: Array<{ item: ClosetItem; compatibility: PresentationCompatibilityResult }>,
): ClosetCoverage {
  const compatible = evaluated.filter(({ compatibility }) => compatibility.allowed);
  const availableByCategory: Record<string, number> = {};
  for (const { item } of compatible) {
    availableByCategory[item.category] = (availableByCategory[item.category] ?? 0) + 1;
  }
  return {
    compatibleItemCount: compatible.length,
    availableByCategory,
    missingCategories: missingCategoriesForCoverage(compatible.map(({ item }) => item.category)),
    excludedForPresentationCount: evaluated.filter(({ compatibility }) =>
      !compatibility.allowed && !compatibility.reasonCodes.includes('fit_incompatible'),
    ).length,
    excludedForFitCount: evaluated.filter(({ compatibility }) => compatibility.fitStatus === 'incompatible').length,
  };
}

function recommendationStatus(
  profile: StylingProfile,
  candidates: ClosetOutfitCandidate[],
  coverage: ClosetCoverage,
): ClosetRecommendationResult['status'] {
  if (!coverage.compatibleItemCount) return 'no_valid_items';
  if (candidates.some((candidate) => candidate.completeness === 'complete')) return 'success';
  if (coverage.compatibleItemCount < 2) return 'insufficient_compatible_items';
  return 'insufficient_complete_look';
}

function buildRangeHint(
  profile: StylingProfile,
  evaluated: Array<{ item: ClosetItem; compatibility: PresentationCompatibilityResult }>,
): ClosetRecommendationResult['rangeHint'] | undefined {
  const scope = profile.recommendationScope ?? (profile.presentationPreference === 'unknown' ? 'neutral_core' : undefined);
  if (scope !== 'neutral_core') return undefined;
  const expressiveCount = evaluated.filter(({ compatibility }) =>
    compatibility.allowed &&
      (
        compatibility.reasonCodes.includes('range_option_high_expression') ||
        compatibility.reasonCodes.includes('downrank_strong_directional_expression') ||
        compatibility.reasonCodes.includes('expression_intensity_bold')
      ),
  ).length;
  if (!expressiveCount) return undefined;
  const options: Array<{ id: RecommendationScope; label: string }> = [
    { id: 'neutral_core', label: '继续通用稳妥' },
    { id: 'all', label: '全部都可以' },
    { id: 'menswear_inclusive', label: '偏传统男装' },
    { id: 'womenswear_inclusive', label: '偏传统女装' },
  ];
  return {
    message: `我先按通用低风险范围排序；衣柜里还有 ${expressiveCount} 件更有表达度的单品，可以按你的偏好放开。`,
    options,
  };
}

function missingCategoriesForCoverage(categories: ClosetItem['category'][]): string[] {
  const set = new Set(categories);
  const hasDressBase = set.has('dress') || set.has('jumpsuit');
  const missing: string[] = [];
  if (!hasDressBase) {
    if (!set.has('top')) missing.push('top');
    if (!set.has('bottom')) missing.push('bottom');
  }
  if (!set.has('shoes')) missing.push('shoes');
  return missing;
}

function suggestedComplement(category: string): SuggestedComplement {
  const names: Record<string, string> = {
    top: '中性基础上衣',
    bottom: '中性直筒下装',
    shoes: '舒适平底鞋或乐福鞋',
  };
  return {
    category,
    name: names[category] ?? '补完整造型的单品',
    reason: '当前衣柜里要组成完整搭配还缺这一类；这是柜外补充建议，不代表衣柜已有。',
    source: 'suggested_complement',
  };
}

function matchesSearchInput(item: ClosetItem, input: ClosetSearchInput): boolean {
  if (input.categories?.length && !input.categories.includes(item.category)) return false;
  if (input.colors?.length && !input.colors.includes(item.color)) return false;
  if (input.formality && item.formality !== input.formality) return false;
  return true;
}

function scoreItem(item: ClosetItem, query: string): number {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = [
    item.name,
    item.category,
    item.color,
    item.fit,
    item.formality,
    item.marketedFor,
    ...item.styleTags,
    ...(item.presentationMetadata?.reasonCodes ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
}

function uniqueCandidates(candidates: ClosetOutfitCandidate[]): ClosetOutfitCandidate[] {
  const seen = new Set<string>();
  const unique: ClosetOutfitCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.itemIds.join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

function aggregateFitStatus(statuses: FitStatus[]): FitStatus {
  if (statuses.includes('incompatible')) return 'incompatible';
  if (statuses.includes('unknown')) return 'unknown';
  if (statuses.includes('likely')) return 'likely';
  return 'confirmed';
}

function buildClosetVersion(items: ClosetItem[]): string {
  return `closet_${hashStable(items.map((item) => ({
    id: item.id,
    metadataVersion: item.presentationMetadata?.metadataVersion,
    reviewedAt: item.presentationMetadata?.reviewedAt,
  })))}`;
}

function hashStable(value: unknown): string {
  return createHash('sha1').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex').slice(0, 12);
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function buildLookCandidates(items: ClosetItem[]): Array<Omit<ClosetLookCandidate, 'score'>> {
  const groups = new Map<string, ClosetItem[]>();
  for (const item of items) {
    const lookId = lookPrefix(item.id);
    if (!lookId) continue;
    groups.set(lookId, [...(groups.get(lookId) ?? []), item]);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length >= 2)
    .map(([id, group]) => ({
      id,
      title: buildLookTitle(id),
      itemIds: group.map((item) => item.id),
      categories: [...new Set(group.map((item) => item.category))],
      completeness: completeCategories(group.map((item) => item.category)) ? 'complete' : 'partial',
    }));
}

function lookPrefix(id: string): string | undefined {
  return id.match(/^(look_\d+_.+?)_item_\d+_/i)?.[1];
}

function buildLookTitle(id: string): string {
  return id.replace(/^look_\d+_/, '').replaceAll('_', ' ');
}

function completeCategories(categories: ClosetItem['category'][]): boolean {
  const set = new Set(categories);
  const hasShoes = set.has('shoes');
  const hasDressBase = set.has('dress') || set.has('jumpsuit');
  const hasSeparates = set.has('top') && set.has('bottom');
  if (hasDressBase) return hasShoes && categories.length >= 2;
  return hasShoes && hasSeparates && categories.length >= 3;
}

function normalizeCategory(category: string): ClosetItem['category'] {
  if (
    category === 'top' ||
    category === 'bottom' ||
    category === 'dress' ||
    category === 'jumpsuit' ||
    category === 'outerwear' ||
    category === 'shoes' ||
    category === 'bag' ||
    category === 'accessory'
  ) {
    return category;
  }
  if (category === 'lower') return 'bottom';
  return 'accessory';
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function buildName(args: {
  category: ClosetItem['category'];
  color: string;
  subcategory: string;
  retrievalText: string;
}): string {
  const color = COLOR_ZH[args.color] ?? '';
  const category = CATEGORY_ZH[args.category] ?? '单品';
  const descriptor = args.subcategory || args.retrievalText;
  if (!descriptor) return `${color}${category}`.trim() || category;
  return `${color}${category} · ${descriptor.replaceAll('_', ' ')}`.trim();
}

function styleTags(item: Demo2WardrobeItem): string[] {
  const explicit = Array.isArray(item.styleTags)
    ? item.styleTags.filter((value): value is string => typeof value === 'string')
    : [];
  const inferred = [
    item.subcategory,
    item.length_bucket,
    item.shoe_type,
    item.heel_height,
    item.boot_height,
    item.waistline,
    item.outerwear_length,
  ]
    .filter((value): value is string => typeof value === 'string')
    .filter((value) => !['unknown', 'not_applicable'].includes(value));
  return [...new Set([...explicit, ...inferred])];
}

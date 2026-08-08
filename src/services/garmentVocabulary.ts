/** Canonical appearance vocabulary shared by observation, tracking, and recall. */

import type { AmbientGarmentSlot } from '../domain/ambientCapture.js';
import type { ClosetItem } from '../types.js';

export const CANONICAL_COLORS = [
  'black', 'white', 'off_white', 'gray', 'beige', 'brown',
  'navy', 'blue', 'light_blue', 'denim_blue',
  'green', 'olive', 'teal',
  'yellow', 'orange', 'red', 'burgundy', 'pink', 'purple',
  'silver', 'gold', 'multicolor', 'unknown',
] as const;
export type CanonicalColor = (typeof CANONICAL_COLORS)[number];

// Unknown must remain model-facing so weak visual evidence never forces a color guess.
export const OBSERVABLE_COLORS = CANONICAL_COLORS;

export const CANONICAL_PATTERNS = [
  'solid', 'stripe', 'check', 'floral', 'print', 'graphic',
  'colorblock', 'denim_wash', 'knit_texture', 'other',
] as const;
export type CanonicalPattern = (typeof CANONICAL_PATTERNS)[number];

export const CANONICAL_FITS = ['slim', 'regular', 'relaxed', 'oversized', 'unknown'] as const;
export type CanonicalFit = (typeof CANONICAL_FITS)[number];
export const OBSERVABLE_FITS = CANONICAL_FITS;

export const CANONICAL_SLEEVES = ['sleeveless', 'short', 'three_quarter', 'long', 'unknown'] as const;
export type CanonicalSleeve = (typeof CANONICAL_SLEEVES)[number];

export const CANONICAL_NECKLINES = ['crew', 'v', 'square', 'collar', 'turtleneck', 'boat', 'hooded', 'unknown'] as const;
export type CanonicalNeckline = (typeof CANONICAL_NECKLINES)[number];

export const CANONICAL_LENGTH_CLASSES = ['short', 'medium', 'long', 'unknown'] as const;
export type CanonicalGarmentLengthClass = (typeof CANONICAL_LENGTH_CLASSES)[number];

export const CANONICAL_MATERIAL_CLASSES = [
  'cotton', 'linen', 'denim', 'knit', 'wool', 'chiffon', 'leather', 'suiting', 'technical', 'other', 'unknown',
] as const;
export type CanonicalMaterialClass = (typeof CANONICAL_MATERIAL_CLASSES)[number];

const COLOR_SYNONYMS: Record<string, CanonicalColor> = {
  charcoal: 'gray', 'dark gray': 'gray', 'dark grey': 'gray', grey: 'gray',
  'light gray': 'gray', 'light grey': 'gray', slate: 'gray', 灰色: 'gray', 深灰: 'gray', 浅灰: 'gray',
  ivory: 'off_white', cream: 'off_white', ecru: 'off_white', 'off white': 'off_white', 米白: 'off_white', 奶油色: 'off_white',
  白色: 'white', 黑色: 'black', 'jet black': 'black',
  khaki: 'beige', 'light khaki': 'beige', tan: 'beige', sand: 'beige', camel: 'beige',
  卡其: 'beige', 卡其色: 'beige', 米色: 'beige', 驼色: 'beige',
  'dark brown': 'brown', 'light brown': 'brown', chocolate: 'brown', coffee: 'brown', 棕色: 'brown', 咖啡色: 'brown',
  'dark blue': 'navy', 'navy blue': 'navy', 'deep blue': 'navy', midnight: 'navy',
  深蓝: 'navy', 深蓝色: 'navy', 藏青: 'navy', 藏青色: 'navy',
  'royal blue': 'blue', cobalt: 'blue', 蓝色: 'blue',
  'sky blue': 'light_blue', 'baby blue': 'light_blue', 'pale blue': 'light_blue', 浅蓝: 'light_blue', 浅蓝色: 'light_blue', 天蓝色: 'light_blue',
  denim: 'denim_blue', 'washed blue': 'denim_blue', 牛仔蓝: 'denim_blue',
  'dark green': 'green', 'forest green': 'green', emerald: 'green', 绿色: 'green', 墨绿: 'green',
  'army green': 'olive', 'olive green': 'olive', 军绿: 'olive', 橄榄绿: 'olive',
  turquoise: 'teal', cyan: 'teal', 青色: 'teal',
  mustard: 'yellow', 黄色: 'yellow', 橙色: 'orange', coral: 'orange',
  'dark red': 'burgundy', maroon: 'burgundy', 'wine red': 'burgundy', wine: 'burgundy', 酒红: 'burgundy', 酒红色: 'burgundy',
  红色: 'red', 粉色: 'pink', 粉红色: 'pink', 'hot pink': 'pink', magenta: 'pink',
  lavender: 'purple', violet: 'purple', 紫色: 'purple', 金色: 'gold', 银色: 'silver',
};

const COLOR_NEIGHBOR_GROUPS: readonly (readonly CanonicalColor[])[] = [
  ['black', 'gray', 'navy'],
  ['white', 'off_white', 'beige'],
  ['beige', 'brown'],
  ['navy', 'blue', 'denim_blue'],
  ['blue', 'light_blue', 'denim_blue', 'teal'],
  ['green', 'olive', 'teal'],
  ['red', 'burgundy', 'orange'],
  ['pink', 'red', 'purple'],
  ['yellow', 'orange', 'gold'],
  ['gray', 'silver'],
];

const PATTERN_SYNONYMS: Record<string, CanonicalPattern> = {
  plain: 'solid', 纯色: 'solid', 素色: 'solid',
  striped: 'stripe', stripes: 'stripe', pinstripe: 'stripe', 条纹: 'stripe',
  plaid: 'check', checked: 'check', checkered: 'check', gingham: 'check', tartan: 'check', 格纹: 'check', 格子: 'check',
  flower: 'floral', flowers: 'floral', 碎花: 'floral', 花卉: 'floral',
  printed: 'print', 'all over print': 'print', 印花: 'print',
  logo: 'graphic', text: 'graphic', 图案: 'graphic',
  'color block': 'colorblock', 拼色: 'colorblock', 拼接: 'colorblock',
  'denim wash': 'denim_wash', washed: 'denim_wash', 水洗: 'denim_wash',
  knit: 'knit_texture', ribbed: 'knit_texture', cable: 'knit_texture', 针织: 'knit_texture', 罗纹: 'knit_texture',
};

const FIT_SYNONYMS: Record<string, CanonicalFit> = {
  fitted: 'slim', tight: 'slim', 'slim fit': 'slim', tailored: 'slim', bodycon: 'slim', 修身: 'slim', 紧身: 'slim',
  straight: 'regular', 'regular fit': 'regular', standard: 'regular', classic: 'regular', 常规: 'regular', 直筒: 'regular',
  loose: 'relaxed', 'relaxed fit': 'relaxed', wide: 'relaxed', flowy: 'relaxed', 宽松: 'relaxed', 阔腿: 'relaxed',
  baggy: 'oversized', 'over sized': 'oversized', boxy: 'oversized', 廓形: 'oversized',
};

const SLEEVE_SYNONYMS: Record<string, CanonicalSleeve> = {
  tank: 'sleeveless', 'tank top': 'sleeveless', vest: 'sleeveless', 无袖: 'sleeveless', 背心: 'sleeveless', 无袖背心: 'sleeveless',
  'short sleeve': 'short', 'short sleeved': 'short', 短袖: 'short',
  'three quarter sleeve': 'three_quarter', '3 4 sleeve': 'three_quarter', 'mid sleeve': 'three_quarter',
  七分袖: 'three_quarter', 中袖: 'three_quarter',
  'long sleeve': 'long', 'long sleeved': 'long', 长袖: 'long',
};

const NECKLINE_SYNONYMS: Record<string, CanonicalNeckline> = {
  'crew neck': 'crew', round: 'crew', 'round neck': 'crew', 圆领: 'crew',
  'v neck': 'v', 'v neckline': 'v', v领: 'v',
  'square neck': 'square', 方领: 'square',
  'shirt collar': 'collar', collared: 'collar', lapel: 'collar', 衬衫领: 'collar', 翻领: 'collar',
  'high neck': 'turtleneck', mockneck: 'turtleneck', 'mock neck': 'turtleneck', 高领: 'turtleneck', 半高领: 'turtleneck',
  'boat neck': 'boat', bateau: 'boat', 'off shoulder': 'boat', 一字领: 'boat', 船领: 'boat',
  hood: 'hooded', hoodie: 'hooded', 连帽: 'hooded',
};

const LENGTH_SYNONYMS: Record<string, CanonicalGarmentLengthClass> = {
  cropped: 'short', crop: 'short', mini: 'short', 短款: 'short', 短: 'short',
  regular: 'medium', midi: 'medium', 'standard length': 'medium', 常规长度: 'medium', 中长: 'medium',
  longline: 'long', maxi: 'long', 长款: 'long', 长: 'long',
};

const MATERIAL_SYNONYMS: Record<string, CanonicalMaterialClass> = {
  jersey: 'cotton', 棉: 'cotton', 纯棉: 'cotton',
  flax: 'linen', 亚麻: 'linen',
  jean: 'denim', 牛仔: 'denim', 牛仔面料: 'denim',
  knitted: 'knit', ribbed: 'knit', 针织: 'knit', 罗纹: 'knit',
  woolen: 'wool', 羊毛: 'wool', 毛呢: 'wool',
  雪纺: 'chiffon', suede: 'leather', 皮革: 'leather', 皮质: 'leather',
  tailored: 'suiting', 'suiting fabric': 'suiting', 西装料: 'suiting', 西装面料: 'suiting',
  nylon: 'technical', polyester: 'technical', 'technical fabric': 'technical', 机能面料: 'technical', 涤纶: 'technical',
};

export function canonicalizeColor(value: string): CanonicalColor {
  return canonicalizeValue(value, CANONICAL_COLORS, COLOR_SYNONYMS, 'unknown');
}

/** 1 = same bucket, 0.6 = neighboring buckets, 0 = unrelated or unknown. */
export function colorSimilarity(left: string, right: string): number {
  const a = canonicalizeColor(left);
  const b = canonicalizeColor(right);
  if (a === 'unknown' || b === 'unknown') return 0;
  if (a === b) return 1;
  return COLOR_NEIGHBOR_GROUPS.some((group) => group.includes(a) && group.includes(b)) ? 0.6 : 0;
}

export function canonicalizePattern(value: string): CanonicalPattern {
  return canonicalizeValue(value, CANONICAL_PATTERNS, PATTERN_SYNONYMS, 'other');
}

export function canonicalizeFit(value: string): CanonicalFit {
  return canonicalizeValue(value, CANONICAL_FITS, FIT_SYNONYMS, 'unknown');
}

export function canonicalizeSleeve(value: string | undefined): CanonicalSleeve {
  return canonicalizeValue(value ?? '', CANONICAL_SLEEVES, SLEEVE_SYNONYMS, 'unknown');
}

export function canonicalizeNeckline(value: string | undefined): CanonicalNeckline {
  return canonicalizeValue(value ?? '', CANONICAL_NECKLINES, NECKLINE_SYNONYMS, 'unknown');
}

export function canonicalizeLengthClass(value: string | undefined): CanonicalGarmentLengthClass {
  return canonicalizeValue(value ?? '', CANONICAL_LENGTH_CLASSES, LENGTH_SYNONYMS, 'unknown');
}

export function canonicalizeMaterialClass(value: string | undefined): CanonicalMaterialClass {
  return canonicalizeValue(value ?? '', CANONICAL_MATERIAL_CLASSES, MATERIAL_SYNONYMS, 'unknown');
}

export function sleeveClassDistance(left: string | undefined, right: string | undefined): number | undefined {
  const order: readonly CanonicalSleeve[] = ['sleeveless', 'short', 'three_quarter', 'long'];
  const leftIndex = order.indexOf(canonicalizeSleeve(left));
  const rightIndex = order.indexOf(canonicalizeSleeve(right));
  return leftIndex < 0 || rightIndex < 0 ? undefined : Math.abs(leftIndex - rightIndex);
}

/** Jumpsuits share the one-piece/dress tracking slot; they never become accessories. */
export function canonicalizeGarmentSlot(
  value: unknown,
  category: ClosetItem['category'],
): AmbientGarmentSlot {
  if (category === 'jumpsuit' || value === 'jumpsuit') return 'dress';
  const slots: readonly AmbientGarmentSlot[] = [
    'top', 'bottom', 'dress', 'outerwear', 'shoes', 'bag', 'accessory',
  ];
  return typeof value === 'string' && slots.includes(value as AmbientGarmentSlot)
    ? value as AmbientGarmentSlot
    : 'accessory';
}

function canonicalizeValue<T extends string>(
  value: string,
  vocabulary: readonly T[],
  synonyms: Record<string, T>,
  fallback: T,
): T {
  const cleaned = clean(value);
  if (vocabulary.includes(cleaned as T)) return cleaned as T;
  const underscored = cleaned.replace(/\s+/g, '_');
  if (vocabulary.includes(underscored as T)) return underscored as T;
  if (synonyms[cleaned]) return synonyms[cleaned]!;

  // Longest complete token phrase wins. This matches "light khaki" before
  // "khaki" while preventing substring errors such as tan -> tangerine.
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  for (let span = tokens.length; span >= 1; span -= 1) {
    for (let start = 0; start + span <= tokens.length; start += 1) {
      const phrase = tokens.slice(start, start + span).join(' ');
      if (vocabulary.includes(phrase as T)) return phrase as T;
      const phraseUnderscored = phrase.replace(/\s+/g, '_');
      if (vocabulary.includes(phraseUnderscored as T)) return phraseUnderscored as T;
      if (synonyms[phrase]) return synonyms[phrase]!;
    }
  }
  return fallback;
}

function clean(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

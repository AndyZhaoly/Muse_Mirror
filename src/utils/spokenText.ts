export type CriticalSpokenNoticeKind =
  | 'visual_unavailable'
  | 'fit_uncertain'
  | 'closet_incomplete';

export interface CriticalSpokenNotice {
  kind: CriticalSpokenNoticeKind;
  priority: number;
  text: string;
}

export interface SpokenTextOptions {
  locale?: string;
  maxSentences?: number;
  maxChineseChars?: number;
  maxEnglishWords?: number;
  fallbackText?: string;
  criticalNotices?: CriticalSpokenNotice[];
}

const urlPattern = /(?:https?:\/\/|www\.)[^\s，。！？；、）)\]}]+/gi;
const opaqueIdPattern = /\b(?:item|closet|product|candidate|look|observation|turn|frame|tool|artifact|session|recommendation)[_-][A-Za-z0-9_-]{3,}\b/gi;
const safetyLanguagePattern = /不建议|不能|没有|仍需|仍要|可能|不一定|不是衣柜单品|AI\s*推测|需要授权|试穿确认/i;
const emptyLabelPattern = /(?:详情|链接|网址|参考|单品|ID|itemId|productId)\s*[:：]\s*(?=$|[，,。.!！？?；;）)\]])/gim;

function isPureHeading(content: string): boolean {
  const normalized = content.replace(/[*_~`]/g, '').trim();
  if (!normalized || /[。！？!?；;.]$/.test(normalized)) return false;
  if (safetyLanguagePattern.test(normalized)) return false;
  if (/^(?:搭配建议|推荐单品|推荐方案|搭配方案|详情|参考|总结|结论|为什么这样建议|Look\s*\d+|Outfit\s*\d+|Recommendations?)$/i.test(normalized)) {
    return true;
  }
  if (/适合|可以|会|应该|要|换|穿|保留|选择|建议.{2,}/.test(normalized)) return false;
  return Array.from(normalized).length <= 24;
}

function stripHeadingLines(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
      if (!match) return line;
      const content = match[1]?.trim() ?? '';
      return isPureHeading(content) ? '' : content;
    })
    .join('\n');
}

function normalizePunctuation(value: string): string {
  return value
    .replace(/[（(]\s*[）)]/g, ' ')
    .replace(emptyLabelPattern, ' ')
    .replace(/(^|[。！？!?；;]\s*)[：:,，;；、]+/g, '$1')
    .replace(/[：:]\s*[，,]+/g, '：')
    .replace(/[：:]\s*[。.!！？?；;]+/g, '。')
    .replace(/[，,]\s*([。.!！？?])/g, '$1')
    .replace(/。{2,}/g, '。')
    .replace(/\.{2,}/g, '.')
    .replace(/！{2,}/g, '！')
    .replace(/!{2,}/g, '!')
    .replace(/？{2,}/g, '？')
    .replace(/\?{2,}/g, '?')
    .replace(/；{2,}/g, '；')
    .replace(/;{2,}/g, ';')
    .replace(/\s+([，。！？；、,.!?;])/g, '$1')
    .replace(/([，。！？；、,.!?;])\s+/g, '$1')
    .replace(/^[：:,，;；、\s]+/, '')
    .trim();
}

function cleanSpeechFormatting(value: string): string {
  const withoutCodeBlocks = value.replace(/```[\s\S]*?```/g, ' ');
  return normalizePunctuation(
    stripHeadingLines(withoutCodeBlocks)
      .replace(/\[([^\]]+)]\((?:https?:\/\/|www\.)[^)]+\)/gi, '$1')
      .replace(urlPattern, ' ')
      .replace(opaqueIdPattern, ' ')
      .replace(/^\s*(?:[-*+]\s+|\d+[.)、]\s*)/gm, '')
      .replace(/[`*_~>|]/g, '')
      .replace(/\b(?:itemId|productId|candidateId|toolName|observationId|frameId|turnId)\s*[:=]\s*\S+/gi, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n+\s*/g, ' ')
      .trim(),
  );
}

function firstSentences(value: string, limit: number): string {
  const sentences = value.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [];
  return sentences.slice(0, Math.max(1, limit)).join('').trim();
}

function avoidBrokenAsciiWord(value: string, end: number): number {
  if (end <= 0 || end >= value.length) return end;
  if (!/[A-Za-z0-9]/.test(value[end - 1] ?? '') || !/[A-Za-z0-9]/.test(value[end] ?? '')) {
    return end;
  }
  let cursor = end;
  while (cursor > 0 && /[A-Za-z0-9]/.test(value[cursor - 1] ?? '')) cursor -= 1;
  return cursor > 0 ? cursor : end;
}

function truncateCharacters(value: string, limit: number): string {
  const chars = Array.from(value);
  if (chars.length <= limit) return value;
  const prefix = chars.slice(0, Math.max(1, limit)).join('');
  const boundaries = ['。', '！', '？', '；', '，', '、', '.', '!', '?', ';', ','];
  let end = -1;
  for (const boundary of boundaries) end = Math.max(end, prefix.lastIndexOf(boundary) + 1);
  if (end < Math.floor(limit * 0.45)) {
    const wordBoundary = prefix.lastIndexOf(' ') + 1;
    end = wordBoundary >= Math.floor(limit * 0.45) ? wordBoundary : prefix.length;
  }
  end = avoidBrokenAsciiWord(value, end);
  return value.slice(0, end).trim();
}

function truncateEnglishWords(value: string, limit: number): string {
  const matches = [...value.matchAll(/\S+/g)];
  if (matches.length <= limit) return value;
  const last = matches[Math.max(0, limit - 1)];
  if (!last || last.index === undefined) return value;
  const end = last.index + last[0].length;
  return value.slice(0, end).replace(/[,:-]+$/, '').trim();
}

function isChineseText(value: string, locale?: string): boolean {
  if (locale?.toLowerCase().startsWith('zh')) return true;
  const chinese = (value.match(/[\u3400-\u9fff]/g) ?? []).length;
  return chinese >= Math.max(1, value.length * 0.15);
}

function ensureNaturalEnding(value: string, chinese: boolean): string {
  const trimmed = normalizePunctuation(value).replace(/[，,、：:；;\s]+$/, '').trim();
  if (!trimmed) return '';
  if (/[。！？.!?]$/.test(trimmed)) return trimmed;
  return `${trimmed}${chinese ? '。' : '.'}`;
}

function noticeAlreadyExpressed(
  text: string,
  kind: CriticalSpokenNoticeKind,
): boolean {
  if (kind === 'fit_uncertain') {
    return /试穿.{0,6}(?:确认|为准)|(?:尺码|肩线|腰围|裤长).{0,10}(?:试穿|确认|不确定|未知)|仍(?:需|要).{0,8}试穿/i.test(text);
  }
  if (kind === 'closet_incomplete') {
    return /衣柜.{0,14}(?:不够|不完整|还缺|缺少)|不够组成完整一套|主要缺.{0,16}(?:鞋子|上装|下装|外套|包|配饰)|缺(?:鞋子|上装|下装)/i.test(text);
  }
  return /(?:没有|还没|无法|看不到).{0,14}(?:视觉|画面|看见|看到)|不能假装.{0,8}(?:看见|看到)/i.test(text);
}

function normalizedCriticalNotices(
  notices: CriticalSpokenNotice[],
): CriticalSpokenNotice[] {
  const byKind = new Map<CriticalSpokenNoticeKind, CriticalSpokenNotice>();
  for (const notice of [...notices].sort((a, b) => b.priority - a.priority)) {
    const text = cleanSpeechFormatting(notice.text);
    if (!text || byKind.has(notice.kind)) continue;
    byKind.set(notice.kind, { ...notice, text });
  }
  return [...byKind.values()].sort((a, b) => b.priority - a.priority);
}

function combineNoticeText(notices: CriticalSpokenNotice[], chinese: boolean): string {
  const clauses = notices
    .map((notice) => notice.text.replace(/[。！？.!?；;]+$/, '').trim())
    .filter(Boolean);
  if (!clauses.length) return '';
  return ensureNaturalEnding(clauses.join(chinese ? '；' : '; '), chinese);
}

function limitOrdinarySpeech(
  value: string,
  options: SpokenTextOptions,
  chinese: boolean,
): string {
  const sentenceLimited = firstSentences(value, options.maxSentences ?? 2);
  const limited = chinese
    ? truncateCharacters(sentenceLimited, options.maxChineseChars ?? 80)
    : truncateEnglishWords(sentenceLimited, options.maxEnglishWords ?? 40);
  return ensureNaturalEnding(limited, chinese);
}

function composeSpeechWithNotices(
  mainText: string,
  notices: CriticalSpokenNotice[],
  options: SpokenTextOptions,
  chinese: boolean,
): string {
  const mainFirstSentence = ensureNaturalEnding(firstSentences(mainText, 1), chinese);
  const required = notices.filter((notice) => !noticeAlreadyExpressed(mainFirstSentence, notice.kind));
  if (!required.length) return limitOrdinarySpeech(mainText, options, chinese);

  const noticeText = combineNoticeText(required, chinese);
  if (!mainFirstSentence) return noticeText;
  if (chinese) {
    const limit = options.maxChineseChars ?? 80;
    const noticeLength = Array.from(noticeText).length;
    const availableForMain = limit - noticeLength;
    if (availableForMain < 8) return noticeText;
    const main = ensureNaturalEnding(
      truncateCharacters(mainFirstSentence, Math.max(1, availableForMain - 1)),
      true,
    );
    const combined = `${main}${noticeText}`;
    return Array.from(combined).length <= limit ? combined : noticeText;
  }

  const wordLimit = options.maxEnglishWords ?? 40;
  const noticeWords = noticeText.match(/\S+/g)?.length ?? 0;
  const availableForMain = wordLimit - noticeWords;
  if (availableForMain < 4) return noticeText;
  return `${ensureNaturalEnding(truncateEnglishWords(mainFirstSentence, availableForMain), false)} ${noticeText}`;
}

export function normalizeSpokenText(
  text: string,
  options: SpokenTextOptions = {},
): string {
  const fallback = cleanSpeechFormatting(options.fallbackText ?? '请看屏幕上的完整回答。');
  const cleaned = cleanSpeechFormatting(text);
  if (!cleaned) return ensureNaturalEnding(fallback, true) || '请看屏幕上的完整回答。';
  const chinese = isChineseText(cleaned, options.locale);
  const notices = normalizedCriticalNotices(options.criticalNotices ?? []);
  const spoken = notices.length
    ? composeSpeechWithNotices(cleaned, notices, options, chinese)
    : limitOrdinarySpeech(cleaned, options, chinese);
  return spoken || ensureNaturalEnding(fallback, chinese) || '请看屏幕上的完整回答。';
}

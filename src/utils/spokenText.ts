export interface SpokenTextOptions {
  locale?: string;
  maxSentences?: number;
  maxChineseChars?: number;
  maxEnglishWords?: number;
  fallbackText?: string;
}

const urlPattern = /(?:https?:\/\/|www\.)\S+/gi;
const opaqueIdPattern = /\b(?:item|closet|product|candidate|look|observation|turn|frame|tool|artifact|session|recommendation)[_-][A-Za-z0-9_-]{3,}\b/gi;

function cleanSpeechFormatting(value: string): string {
  return value
    .replace(urlPattern, ' ')
    .replace(opaqueIdPattern, ' ')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)、]\s*)/gm, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_~>|]/g, '')
    .replace(/\b(?:itemId|productId|candidateId|toolName|observationId|frameId|turnId)\s*[:=]\s*\S+/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/([。！？；])\s+/g, '$1')
    .trim();
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
  const prefix = chars.slice(0, limit).join('');
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

export function normalizeSpokenText(
  text: string,
  options: SpokenTextOptions = {},
): string {
  const fallback = cleanSpeechFormatting(options.fallbackText ?? '请看屏幕上的完整回答。');
  const cleaned = cleanSpeechFormatting(text);
  if (!cleaned) return fallback || '请看屏幕上的完整回答。';
  const sentenceLimited = firstSentences(cleaned, options.maxSentences ?? 2);
  const limited = isChineseText(sentenceLimited, options.locale)
    ? truncateCharacters(sentenceLimited, options.maxChineseChars ?? 80)
    : truncateEnglishWords(sentenceLimited, options.maxEnglishWords ?? 40);
  return limited.trim() || fallback || '请看屏幕上的完整回答。';
}

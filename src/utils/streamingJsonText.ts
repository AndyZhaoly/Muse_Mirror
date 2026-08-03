export class StreamingJsonTextExtractor {
  private lastText = '';

  next(buffer: string): string | undefined {
    const text = extractPartialJsonStringField(buffer, 'text');
    if (text === undefined) return undefined;
    if (text === this.lastText) return undefined;
    if (text.startsWith(this.lastText)) {
      const delta = text.slice(this.lastText.length);
      this.lastText = text;
      return delta || undefined;
    }
    this.lastText = text;
    return text;
  }
}

export function extractPartialJsonStringField(
  jsonLike: string,
  fieldName: string,
): string | undefined {
  const fieldIndex = jsonLike.search(new RegExp(`"${escapeRegExp(fieldName)}"\\s*:`));
  if (fieldIndex < 0) return undefined;
  const colonIndex = jsonLike.indexOf(':', fieldIndex);
  if (colonIndex < 0) return undefined;
  const quoteIndex = jsonLike.indexOf('"', colonIndex + 1);
  if (quoteIndex < 0) return undefined;

  let end = jsonLike.length;
  let escaped = false;
  for (let index = quoteIndex + 1; index < jsonLike.length; index += 1) {
    const char = jsonLike[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      end = index;
      break;
    }
  }

  const raw = safePartialJsonString(jsonLike.slice(quoteIndex + 1, end));
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return undefined;
  }
}

function safePartialJsonString(raw: string): string | undefined {
  let value = raw;
  const trailingBackslashes = value.match(/\\+$/)?.[0].length ?? 0;
  if (trailingBackslashes % 2 === 1) {
    value = value.slice(0, -1);
  }
  const unicodeStart = value.lastIndexOf('\\u');
  if (unicodeStart >= 0) {
    const tail = value.slice(unicodeStart);
    if (/^\\u[0-9a-fA-F]{0,3}$/.test(tail)) {
      value = value.slice(0, unicodeStart);
    }
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

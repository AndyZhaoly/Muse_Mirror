export function extractJsonObject<T>(text: string): T {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) {
      throw new Error('Model response did not contain a JSON object.');
    }
    return JSON.parse(trimmed.slice(start, end + 1)) as T;
  }
}

export function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

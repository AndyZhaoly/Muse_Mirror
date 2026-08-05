export function toCanvasPlainText(text?: string): string | undefined {
  if (!text) return undefined;
  const normalized = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}|[-+*]|\d+[.)])\s+/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalized || undefined;
}

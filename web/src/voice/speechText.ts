interface SpeakableTurnResult {
  text: string;
  spokenText?: string;
}

export function speechTextForResult(
  result: SpeakableTurnResult,
): string {
  return result.spokenText?.trim() || result.text.trim();
}

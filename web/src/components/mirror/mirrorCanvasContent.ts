export interface MirrorCanvasMessage {
  id: string;
  role: 'assistant' | 'user';
  text?: string;
  commentary?: string;
  isTyping?: boolean;
}

export interface CurrentCanvasContent {
  latestUserText?: string;
  latestAssistantText?: string;
  latestAssistantCommentary?: string;
  assistantMessageId?: string;
  assistantIsTyping: boolean;
}

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

export function deriveCurrentCanvasContent(
  messages: readonly MirrorCanvasMessage[],
  activeAssistantId?: string | null,
): CurrentCanvasContent {
  const latestUser = [...messages].reverse().find((message) => message.role === 'user');
  const activeAssistant = activeAssistantId
    ? messages.find((message) => message.id === activeAssistantId && message.role === 'assistant')
    : undefined;
  const latestCompletedAssistant = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant' && (message.text?.trim() || message.commentary?.trim()));
  const latestAssistant = activeAssistant ?? latestCompletedAssistant;

  const commentary = latestAssistant?.commentary?.trim() || undefined;
  const text = latestAssistant?.text?.trim() || undefined;
  const commentaryTakesPriority = Boolean(activeAssistant && commentary && !text);

  return {
    latestUserText: latestUser?.text?.trim() || undefined,
    latestAssistantText: commentaryTakesPriority ? undefined : text,
    latestAssistantCommentary: commentaryTakesPriority ? commentary : undefined,
    assistantMessageId: activeAssistant?.id ?? latestAssistant?.id,
    assistantIsTyping: Boolean(activeAssistant && !text && !commentary),
  };
}

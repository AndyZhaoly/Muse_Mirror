export type VoiceSessionState =
  | 'disabled'
  | 'idle'
  | 'requesting_permission'
  | 'listening'
  | 'recognizing'
  | 'thinking'
  | 'speaking'
  | 'error';

export interface VoiceCapabilityStatus {
  ok: boolean;
  mode: 'semi_duplex';
  asr: {
    provider: 'volcengine' | 'disabled';
    configured: boolean;
    ready: boolean;
    sampleRate: number;
    resourceId: string;
  };
  tts: {
    provider: 'volcengine' | 'disabled';
    configured: boolean;
    ready: boolean;
    sampleRate: number;
    model: string;
    resourceId: string;
    speakerConfigured: boolean;
  };
}

export interface VoiceSessionView {
  enabled: boolean;
  available: boolean;
  state: VoiceSessionState;
  partialTranscript: string;
  finalTranscript: string;
  lastError?: string;
}

export function voiceWebSocketUrl(
  path: string,
  location: Pick<Location, 'protocol' | 'host'> = window.location,
): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}${path}`;
}

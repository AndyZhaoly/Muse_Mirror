import { voiceWebSocketUrl } from './voiceTypes';

export interface AsrClientHandlers {
  onPartial(text: string): void;
  onFinal(text: string): void;
  onUtteranceEnd(): void;
  onError(error: Error): void;
}

export class AsrClient {
  private socket?: WebSocket;
  private ready = false;
  private stopped = false;

  constructor(private readonly handlers: AsrClientHandlers) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(voiceWebSocketUrl('/api/voice/asr'));
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      let settled = false;
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({
          type: 'start',
          language: 'zh-CN',
          format: 'pcm_s16le',
          sampleRate: 16000,
          channels: 1,
        }));
      });
      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        try {
          const message = JSON.parse(event.data) as Record<string, unknown>;
          if (message.type === 'ready') {
            this.ready = true;
            settled = true;
            resolve();
          } else if (message.type === 'partial' && typeof message.text === 'string') {
            this.handlers.onPartial(message.text);
          } else if (message.type === 'final' && typeof message.text === 'string') {
            this.handlers.onFinal(message.text);
          } else if (message.type === 'utterance_end') {
            this.handlers.onUtteranceEnd();
          } else if (message.type === 'error') {
            const error = new Error(
              typeof message.message === 'string' ? message.message : '语音识别暂时不可用。',
            );
            if (!settled) reject(error);
            this.handlers.onError(error);
          }
        } catch {
          this.handlers.onError(new Error('语音识别返回了无法解析的数据。'));
        }
      });
      socket.addEventListener('error', () => {
        const error = new Error('无法连接语音识别服务。');
        if (!settled) reject(error);
        this.handlers.onError(error);
      });
      socket.addEventListener('close', () => {
        this.ready = false;
      });
    });
  }

  sendAudio(pcm: ArrayBuffer): void {
    if (!this.ready || this.stopped || this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(pcm);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'stop' }));
    }
  }

  close(): void {
    this.ready = false;
    this.stopped = true;
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
    this.socket = undefined;
  }
}

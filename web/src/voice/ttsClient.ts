import { voiceWebSocketUrl } from './voiceTypes';

export interface TtsClientHandlers {
  onReady(sampleRate: number): void;
  onAudio(pcm: ArrayBuffer): void;
}

export class TtsClient {
  private socket?: WebSocket;

  speak(text: string, handlers: TtsClientHandlers): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(voiceWebSocketUrl('/api/voice/tts'));
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      let settled = false;
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'start', text }));
      });
      socket.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) {
          handlers.onAudio(event.data);
          return;
        }
        if (typeof event.data !== 'string') return;
        try {
          const message = JSON.parse(event.data) as Record<string, unknown>;
          if (message.type === 'ready') {
            handlers.onReady(typeof message.sampleRate === 'number' ? message.sampleRate : 24000);
          } else if (message.type === 'done') {
            settled = true;
            resolve();
            this.close();
          } else if (message.type === 'error') {
            settled = true;
            reject(new Error(
              typeof message.message === 'string' ? message.message : '语音合成暂时不可用。',
            ));
            this.close();
          }
        } catch {
          settled = true;
          reject(new Error('语音合成返回了无法解析的数据。'));
          this.close();
        }
      });
      socket.addEventListener('error', () => {
        if (!settled) reject(new Error('无法连接语音合成服务。'));
        this.close();
      });
    });
  }

  close(): void {
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
    this.socket = undefined;
  }
}

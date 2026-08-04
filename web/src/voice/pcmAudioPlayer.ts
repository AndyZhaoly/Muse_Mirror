export class PcmAudioPlayer {
  private context?: AudioContext;
  private nextStartTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private pending = new Set<Promise<void>>();

  async enqueue(pcm: ArrayBuffer, sampleRate: number): Promise<void> {
    if (!pcm.byteLength) return;
    this.context ??= new AudioContext();
    if (this.context.state === 'suspended') await this.context.resume();
    const input = new Int16Array(pcm);
    const buffer = this.context.createBuffer(1, input.length, sampleRate);
    const output = buffer.getChannelData(0);
    for (let index = 0; index < input.length; index += 1) {
      output[index] = input[index]! / 32768;
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const startAt = Math.max(this.context.currentTime + 0.015, this.nextStartTime);
    this.nextStartTime = startAt + buffer.duration;
    this.sources.add(source);
    const finished = new Promise<void>((resolve) => {
      source.onended = () => {
        source.disconnect();
        this.sources.delete(source);
        resolve();
      };
    });
    this.pending.add(finished);
    void finished.finally(() => this.pending.delete(finished));
    source.start(startAt);
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  async stop(): Promise<void> {
    for (const source of this.sources) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.sources.clear();
    this.pending.clear();
    this.nextStartTime = 0;
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.context = undefined;
  }
}

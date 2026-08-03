class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = [];
    this.pendingLength = 0;
    this.targetRate = 16000;
    this.targetChunkSize = 480;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;
    this.pending.push(new Float32Array(input));
    this.pendingLength += input.length;
    const ratio = sampleRate / this.targetRate;
    const sourceFramesNeeded = Math.ceil(this.targetChunkSize * ratio);
    while (this.pendingLength >= sourceFramesNeeded) {
      const source = new Float32Array(sourceFramesNeeded);
      let copied = 0;
      while (copied < sourceFramesNeeded && this.pending.length) {
        const first = this.pending[0];
        const take = Math.min(first.length, sourceFramesNeeded - copied);
        source.set(first.subarray(0, take), copied);
        copied += take;
        this.pendingLength -= take;
        if (take === first.length) this.pending.shift();
        else this.pending[0] = first.subarray(take);
      }
      const pcm = new Int16Array(this.targetChunkSize);
      for (let index = 0; index < pcm.length; index += 1) {
        const sourceIndex = Math.min(source.length - 1, Math.floor(index * ratio));
        const sample = Math.max(-1, Math.min(1, source[sourceIndex] || 0));
        pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);

export class MicrophoneCapture {
  private stream?: MediaStream;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private silentGain?: GainNode;

  async prepare(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
    this.context = new AudioContext();
    await this.context.audioWorklet.addModule('/audio/pcm-capture-processor.js');
    await this.context.resume();
  }

  start(onPcm: (pcm: ArrayBuffer) => void): void {
    if (!this.stream || !this.context) throw new Error('麦克风尚未准备好。');
    this.source = this.context.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.context, 'pcm-capture-processor');
    this.silentGain = this.context.createGain();
    this.silentGain.gain.value = 0;
    this.worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => onPcm(event.data);
    this.source.connect(this.worklet);
    this.worklet.connect(this.silentGain);
    this.silentGain.connect(this.context.destination);
  }

  async close(): Promise<void> {
    this.worklet?.port.close();
    this.worklet?.disconnect();
    this.source?.disconnect();
    this.silentGain?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== 'closed') await this.context.close();
    this.worklet = undefined;
    this.source = undefined;
    this.silentGain = undefined;
    this.stream = undefined;
    this.context = undefined;
  }
}

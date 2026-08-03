import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentTurnResult } from '../agentClient';
import { AsrClient } from './asrClient';
import { MicrophoneCapture } from './microphoneCapture';
import { PcmAudioPlayer } from './pcmAudioPlayer';
import { TtsClient } from './ttsClient';
import type { VoiceCapabilityStatus, VoiceSessionState, VoiceSessionView } from './voiceTypes';

interface UseVoiceSessionOptions {
  submitMessage(message: string): Promise<AgentTurnResult | undefined>;
}

function permissionError(error: unknown): string {
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
    return '麦克风权限被拒绝，请在浏览器设置中允许后重试。';
  }
  return error instanceof Error ? error.message : '无法开启麦克风。';
}

export function useVoiceSession(options: UseVoiceSessionOptions) {
  const submitRef = useRef(options.submitMessage);
  const mountedRef = useRef(true);
  const enabledRef = useRef(false);
  const busyRef = useRef(false);
  const asrRef = useRef<AsrClient | undefined>(undefined);
  const micRef = useRef<MicrophoneCapture | undefined>(undefined);
  const ttsRef = useRef<TtsClient | undefined>(undefined);
  const playerRef = useRef<PcmAudioPlayer | undefined>(undefined);
  const latestPartialRef = useRef('');
  const [capabilities, setCapabilities] = useState<VoiceCapabilityStatus>();
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<VoiceSessionState>('disabled');
  const [partialTranscript, setPartialTranscript] = useState('');
  const [finalTranscript, setFinalTranscript] = useState('');
  const [lastError, setLastError] = useState<string>();

  submitRef.current = options.submitMessage;

  const releaseListening = useCallback(async () => {
    asrRef.current?.close();
    asrRef.current = undefined;
    await micRef.current?.close();
    micRef.current = undefined;
  }, []);

  const stopAll = useCallback(async () => {
    await releaseListening();
    ttsRef.current?.close();
    ttsRef.current = undefined;
    await playerRef.current?.stop();
    playerRef.current = undefined;
    busyRef.current = false;
  }, [releaseListening]);

  const handleFinal = useCallback(async (text: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const finalText = text.trim() || latestPartialRef.current.trim();
    setPartialTranscript('');
    latestPartialRef.current = '';
    await releaseListening();
    if (!finalText) {
      busyRef.current = false;
      if (enabledRef.current) setState('idle');
      return;
    }
    setFinalTranscript(finalText);
    setState('thinking');
    const result = await submitRef.current(finalText);
    if (!mountedRef.current || !enabledRef.current) {
      busyRef.current = false;
      setState('disabled');
      return;
    }
    if (result?.status === 'completed' && result.text.trim() && capabilities?.tts.ready) {
      setState('speaking');
      const player = new PcmAudioPlayer();
      const tts = new TtsClient();
      playerRef.current = player;
      ttsRef.current = tts;
      let sampleRate = capabilities.tts.sampleRate;
      try {
        await tts.speak(result.text, {
          onReady: (nextSampleRate) => { sampleRate = nextSampleRate; },
          onAudio: (pcm) => { void player.enqueue(pcm, sampleRate); },
        });
        await player.waitForIdle();
      } catch (error) {
        setLastError(error instanceof Error ? error.message : '语音合成暂时不可用。');
        setState('error');
        busyRef.current = false;
        return;
      } finally {
        tts.close();
        await player.stop();
        ttsRef.current = undefined;
        playerRef.current = undefined;
      }
    }
    busyRef.current = false;
    setState(enabledRef.current ? 'idle' : 'disabled');
  }, [capabilities, releaseListening]);

  const startListening = useCallback(async () => {
    if (!enabledRef.current || busyRef.current) return;
    if (!capabilities?.asr.ready) {
      setLastError('语音识别尚未配置。');
      setState('error');
      return;
    }
    busyRef.current = true;
    setLastError(undefined);
    setPartialTranscript('');
    latestPartialRef.current = '';
    setState('requesting_permission');
    const microphone = new MicrophoneCapture();
    micRef.current = microphone;
    try {
      await microphone.prepare();
      if (!enabledRef.current) {
        await microphone.close();
        busyRef.current = false;
        return;
      }
      const asr = new AsrClient({
        onPartial: (text) => {
          latestPartialRef.current = text;
          setPartialTranscript(text);
          setState('listening');
        },
        onFinal: (text) => { void handleFinal(text); },
        onUtteranceEnd: () => {
          setState('recognizing');
          void microphone.close();
          asr.stop();
        },
        onError: (error) => {
          setLastError(error.message);
          setState('error');
          busyRef.current = false;
          void releaseListening();
        },
      });
      asrRef.current = asr;
      await asr.start();
      microphone.start((pcm) => asr.sendAudio(pcm));
      busyRef.current = false;
      setState('listening');
    } catch (error) {
      await releaseListening();
      busyRef.current = false;
      setLastError(permissionError(error));
      setState('error');
    }
  }, [capabilities, handleFinal, releaseListening]);

  const enable = useCallback(async () => {
    enabledRef.current = true;
    setEnabled(true);
    setState('idle');
    await startListening();
  }, [startListening]);

  const disable = useCallback(async () => {
    enabledRef.current = false;
    setEnabled(false);
    setState('disabled');
    setPartialTranscript('');
    await stopAll();
  }, [stopAll]);

  const toggle = useCallback(() => {
    if (enabledRef.current) void disable();
    else void enable();
  }, [disable, enable]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/voice/status')
      .then(async (response) => {
        const body = await response.json() as VoiceCapabilityStatus;
        if (!response.ok) throw new Error('Voice status unavailable.');
        if (!cancelled) setCapabilities(body);
      })
      .catch(() => {
        if (!cancelled) setCapabilities(undefined);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (enabled && state === 'idle' && !busyRef.current) void startListening();
  }, [enabled, startListening, state]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      enabledRef.current = false;
      void stopAll();
    };
  }, [stopAll]);

  const view: VoiceSessionView = {
    enabled,
    available: Boolean(capabilities?.asr.ready && capabilities?.tts.ready),
    state,
    partialTranscript,
    finalTranscript,
    lastError,
  };
  return { ...view, toggle };
}

import { describe, expect, it, vi } from 'vitest';
import {
  VoiceCaptureController,
  VoiceCaptureError,
  type VoiceCapturePlatform,
} from '../src/features/conversation/voice-capture';
import {
  MonoPcm16kEncoder,
  VOICE_PCM_MAX_SAMPLES,
  VOICE_PCM_SAMPLE_RATE,
} from '../src/features/conversation/voice-pcm-worklet';

const OPERATION_REF = '11111111-1111-4111-8111-111111111111';

type FakeEnvironment = {
  platform: VoiceCapturePlatform;
  log: string[];
  port: MessagePort;
  track: MediaStreamTrack;
};

function pcmBuffer(samples: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return buffer;
}

function createEnvironment(onPortMessage?: (message: unknown, port: MessagePort) => void): FakeEnvironment {
  const log: string[] = [];
  const track = { stop: vi.fn(() => log.push('track.stop')) } as unknown as MediaStreamTrack;
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const port = {
    onmessage: null,
    onmessageerror: null,
    postMessage(message: unknown) {
      log.push((message as { type?: string }).type ?? 'unknown');
      onPortMessage?.(message, port as MessagePort);
    },
  } as unknown as MessagePort;
  const node = {
    port,
    connect: vi.fn(() => log.push('node.connect')),
    disconnect: vi.fn(() => log.push('node.disconnect')),
  } as unknown as AudioWorkletNode;
  const source = {
    connect: vi.fn(() => log.push('source.connect')),
    disconnect: vi.fn(() => log.push('source.disconnect')),
  } as unknown as MediaStreamAudioSourceNode;
  const context = {
    state: 'running',
    audioWorklet: { addModule: vi.fn(async () => { log.push('addModule'); }) },
    createMediaStreamSource: vi.fn(() => source),
    resume: vi.fn(async () => { log.push('context.resume'); }),
    close: vi.fn(async () => { log.push('context.close'); }),
  } as unknown as AudioContext;
  const platform: VoiceCapturePlatform = {
    isSecureContext: () => true,
    getUserMedia: vi.fn(async () => stream),
    createAudioContext: vi.fn(() => context),
    createAudioWorkletNode: vi.fn(() => node),
    workletModuleUrl: 'https://orquesta.local/voice-pcm-worklet.js',
    flushTimeoutMs: 100,
  };
  return { platform, log, port, track };
}

function dispatchPort(port: MessagePort, data: unknown): void {
  port.onmessage?.(new MessageEvent('message', { data }));
}

describe('P2-008C renderer microphone capture', () => {
  it('resamples mono PCM as signed 16-bit little-endian and enforces the exact sample cap', () => {
    const chunks: Array<{ pcm: ArrayBuffer; sampleCount: number }> = [];
    const encoder = new MonoPcm16kEncoder(
      VOICE_PCM_SAMPLE_RATE,
      (pcm, sampleCount) => chunks.push({ pcm, sampleCount }),
      2,
    );
    encoder.push([
      new Float32Array([1, -1, 0.5]),
      new Float32Array([1, -1, 0.5]),
    ]);
    encoder.flush();

    expect(encoder.sampleCount).toBe(2);
    expect(encoder.reachedLimit).toBe(true);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.sampleCount).toBe(2);
    const view = new DataView(chunks[0]!.pcm);
    expect(view.getInt16(0, true)).toBe(32_767);
    expect(view.getInt16(2, true)).toBe(-32_768);
    expect(VOICE_PCM_MAX_SAMPLES).toBe(960_000);
  });

  it('does not request microphone permission outside a secure context', async () => {
    const environment = createEnvironment();
    environment.platform.isSecureContext = () => false;
    const controller = new VoiceCaptureController(environment.platform);

    await expect(controller.start({ operationRef: OPERATION_REF })).rejects.toMatchObject({
      code: 'insecure_context',
    });
    expect(environment.platform.getUserMedia).not.toHaveBeenCalled();
  });

  it('stops a late permission stream when the pending generation was cancelled', async () => {
    let resolvePermission!: (stream: MediaStream) => void;
    const environment = createEnvironment();
    const lateStream = { getTracks: () => [environment.track] } as unknown as MediaStream;
    environment.platform.getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => {
      resolvePermission = resolve;
    }));
    const controller = new VoiceCaptureController(environment.platform);

    const start = controller.start({ operationRef: OPERATION_REF });
    await controller.cancelActive();
    resolvePermission(lateStream);

    await expect(start).rejects.toBeInstanceOf(VoiceCaptureError);
    await expect(start).rejects.toMatchObject({ code: 'cancelled' });
    expect(environment.track.stop).toHaveBeenCalledTimes(1);
    expect(environment.platform.createAudioContext).not.toHaveBeenCalled();
  });

  it('flushes before track, node and context cleanup and preserves caller operation identity', async () => {
    const environment = createEnvironment((message, port) => {
      if ((message as { type?: string }).type !== 'flush') return;
      const pcm = pcmBuffer([123, -456]);
      dispatchPort(port, { type: 'pcm', pcm, sampleCount: 2 });
      dispatchPort(port, { type: 'flushed', sampleCount: 2 });
    });
    const controller = new VoiceCaptureController(environment.platform);
    const capture = await controller.start({ operationRef: OPERATION_REF });

    const result = await capture.stop();

    expect(result).toMatchObject({
      operationRef: OPERATION_REF,
      sampleRate: 16_000,
      channelCount: 1,
      bitsPerSample: 16,
      sampleCount: 2,
      durationMs: 0.125,
    });
    expect([...result.pcm]).toEqual([123, 0, 56, 254]);
    expect(environment.platform.getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    expect(environment.platform.createAudioWorkletNode).toHaveBeenCalledWith(
      expect.anything(),
      'orquesta-voice-pcm-16k-v1',
      expect.objectContaining({
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        processorOptions: { maxSamples: 960_000 },
      }),
    );
    expect(environment.log.indexOf('flush')).toBeLessThan(environment.log.indexOf('track.stop'));
    expect(environment.log.indexOf('flush')).toBeLessThan(environment.log.indexOf('node.disconnect'));
    expect(environment.log.indexOf('flush')).toBeLessThan(environment.log.indexOf('context.close'));
    await expect(capture.completion).resolves.toMatchObject({ kind: 'captured', reason: 'manual' });
  });

  it('cancels and disposes local capture resources without flushing or invoking another boundary', async () => {
    const environment = createEnvironment();
    const controller = new VoiceCaptureController(environment.platform);
    const capture = await controller.start({ operationRef: OPERATION_REF });

    await controller.dispose();

    expect(environment.log).not.toContain('flush');
    expect(environment.track.stop).toHaveBeenCalledTimes(1);
    await expect(capture.completion).resolves.toEqual({ kind: 'cancelled' });
    await expect(controller.start({ operationRef: OPERATION_REF })).rejects.toMatchObject({ code: 'disposed' });
  });

  it('treats the worklet sample limit as an already-flushed terminal capture', async () => {
    const environment = createEnvironment();
    const controller = new VoiceCaptureController(environment.platform);
    const capture = await controller.start({ operationRef: OPERATION_REF });
    const pcm = pcmBuffer([10, 20, 30]);

    dispatchPort(environment.port, { type: 'pcm', pcm, sampleCount: 3 });
    dispatchPort(environment.port, { type: 'limit', sampleCount: 3 });

    await expect(capture.completion).resolves.toMatchObject({
      kind: 'captured',
      reason: 'limit',
      capture: { operationRef: OPERATION_REF, sampleCount: 3 },
    });
    expect(environment.log).not.toContain('flush');
    expect(environment.track.stop).toHaveBeenCalledTimes(1);
  });
});

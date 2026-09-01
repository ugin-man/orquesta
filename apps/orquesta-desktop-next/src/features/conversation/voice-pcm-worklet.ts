export const VOICE_PCM_PROCESSOR_NAME = 'orquesta-voice-pcm-16k-v1';
export const VOICE_PCM_SAMPLE_RATE = 16_000;
export const VOICE_PCM_MAX_SAMPLES = VOICE_PCM_SAMPLE_RATE * 60;

const PCM_CHUNK_SAMPLES = 2_048;

export type PcmChunkSink = (pcm: ArrayBuffer, sampleCount: number) => void;

function clampSample(sample: number): number {
  return Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
}

/**
 * Small streaming resampler shared by the AudioWorklet and focused unit tests.
 * It keeps only the unconsumed tail between render quanta and emits signed
 * 16-bit little-endian PCM in bounded chunks.
 */
export class MonoPcm16kEncoder {
  private readonly ratio: number;
  private readonly pendingInput: number[] = [];
  private readonly pendingOutput: number[] = [];
  private readPosition = 0;
  private emittedSamples = 0;
  private finished = false;

  constructor(
    sourceSampleRate: number,
    private readonly sink: PcmChunkSink,
    private readonly maxSamples = VOICE_PCM_MAX_SAMPLES,
  ) {
    if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0) {
      throw new Error('voice_capture_invalid_source_sample_rate');
    }
    if (!Number.isSafeInteger(maxSamples) || maxSamples <= 0) {
      throw new Error('voice_capture_invalid_max_samples');
    }
    this.ratio = sourceSampleRate / VOICE_PCM_SAMPLE_RATE;
  }

  get sampleCount(): number {
    return this.emittedSamples;
  }

  get reachedLimit(): boolean {
    return this.emittedSamples >= this.maxSamples;
  }

  push(channels: readonly Float32Array[]): void {
    if (this.finished || this.reachedLimit || channels.length === 0) return;
    const frameCount = channels.reduce(
      (smallest, channel) => Math.min(smallest, channel.length),
      Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(frameCount) || frameCount <= 0) return;

    for (let frame = 0; frame < frameCount; frame += 1) {
      let mono = 0;
      for (const channel of channels) mono += channel[frame] ?? 0;
      this.pendingInput.push(mono / channels.length);
    }
    this.emitAvailable(false);
  }

  flush(): void {
    if (this.finished) return;
    this.emitAvailable(true);
    this.emitOutputChunk();
    this.finished = true;
  }

  private emitAvailable(flushing: boolean): void {
    const finalReadablePosition = flushing
      ? this.pendingInput.length
      : Math.max(0, this.pendingInput.length - 1);

    while (this.readPosition < finalReadablePosition && !this.reachedLimit) {
      const lowerIndex = Math.floor(this.readPosition);
      const upperIndex = Math.min(lowerIndex + 1, this.pendingInput.length - 1);
      const fraction = this.readPosition - lowerIndex;
      const lower = this.pendingInput[lowerIndex] ?? 0;
      const upper = this.pendingInput[upperIndex] ?? lower;
      this.pushOutputSample(lower + ((upper - lower) * fraction));
      this.readPosition += this.ratio;
    }

    const consumed = Math.min(Math.floor(this.readPosition), this.pendingInput.length);
    if (consumed > 0) {
      this.pendingInput.splice(0, consumed);
      this.readPosition -= consumed;
    }
  }

  private pushOutputSample(sample: number): void {
    const clamped = clampSample(sample);
    const encoded = clamped < 0
      ? Math.round(clamped * 0x8000)
      : Math.round(clamped * 0x7fff);
    this.pendingOutput.push(encoded);
    this.emittedSamples += 1;
    if (this.pendingOutput.length >= PCM_CHUNK_SAMPLES) this.emitOutputChunk();
  }

  private emitOutputChunk(): void {
    if (this.pendingOutput.length === 0) return;
    const pcm = new ArrayBuffer(this.pendingOutput.length * 2);
    const view = new DataView(pcm);
    for (let index = 0; index < this.pendingOutput.length; index += 1) {
      view.setInt16(index * 2, this.pendingOutput[index] ?? 0, true);
    }
    const sampleCount = this.pendingOutput.length;
    this.pendingOutput.length = 0;
    this.sink(pcm, sampleCount);
  }
}

declare const sampleRate: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][]): boolean;
}
declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

if (typeof registerProcessor === 'function') {
  class OrquestaVoicePcmProcessor extends AudioWorkletProcessor {
    private readonly encoder: MonoPcm16kEncoder;
    private closed = false;

    constructor(options?: AudioWorkletNodeOptions) {
      super();
      const requestedMax = options?.processorOptions?.maxSamples;
      const maxSamples = Number.isSafeInteger(requestedMax) && requestedMax > 0
        ? Math.min(requestedMax, VOICE_PCM_MAX_SAMPLES)
        : VOICE_PCM_MAX_SAMPLES;
      this.encoder = new MonoPcm16kEncoder(
        sampleRate,
        (pcm, sampleCount) => {
          this.port.postMessage({ type: 'pcm', pcm, sampleCount }, [pcm]);
        },
        maxSamples,
      );
      this.port.onmessage = (event: MessageEvent<unknown>) => {
        if (!event.data || typeof event.data !== 'object') return;
        if ((event.data as { type?: unknown }).type !== 'flush') return;
        this.finish('flushed');
      };
    }

    process(inputs: Float32Array[][]): boolean {
      if (this.closed) return false;
      const channels = inputs[0] ?? [];
      this.encoder.push(channels);
      if (this.encoder.reachedLimit) {
        this.finish('limit');
        return false;
      }
      return true;
    }

    private finish(type: 'flushed' | 'limit'): void {
      if (this.closed) {
        if (type === 'flushed') {
          this.port.postMessage({ type: 'flushed', sampleCount: this.encoder.sampleCount });
        }
        return;
      }
      this.closed = true;
      this.encoder.flush();
      this.port.postMessage({ type, sampleCount: this.encoder.sampleCount });
    }
  }

  registerProcessor(VOICE_PCM_PROCESSOR_NAME, OrquestaVoicePcmProcessor);
}

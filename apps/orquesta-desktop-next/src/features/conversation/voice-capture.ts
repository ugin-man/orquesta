import {
  VOICE_PCM_MAX_SAMPLES,
  VOICE_PCM_PROCESSOR_NAME,
  VOICE_PCM_SAMPLE_RATE,
} from './voice-pcm-worklet';
import voicePcmWorkletUrl from './voice-pcm-worklet.ts?worker&url';

export const VOICE_CAPTURE_MAX_SECONDS = 60;
export const VOICE_CAPTURE_MAX_BYTES = VOICE_PCM_MAX_SAMPLES * 2;

const OPERATION_REF_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;

export type VoiceCaptureErrorCode =
  | 'cancelled'
  | 'already_active'
  | 'disposed'
  | 'insecure_context'
  | 'media_devices_unavailable'
  | 'audio_worklet_unavailable'
  | 'permission_denied'
  | 'invalid_operation_ref'
  | 'invalid_pcm_message'
  | 'flush_timeout'
  | 'capture_failed';

export class VoiceCaptureError extends Error {
  constructor(readonly code: VoiceCaptureErrorCode, message: string = code, options?: ErrorOptions) {
    super(message, options);
    this.name = 'VoiceCaptureError';
  }
}

export type CapturedVoicePcm = {
  operationRef: string;
  pcm: Uint8Array;
  sampleRate: typeof VOICE_PCM_SAMPLE_RATE;
  channelCount: 1;
  bitsPerSample: 16;
  sampleCount: number;
  durationMs: number;
};

export type VoiceCaptureCompletion =
  | { kind: 'captured'; reason: 'manual' | 'limit'; capture: CapturedVoicePcm }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: VoiceCaptureError };

export type VoiceCaptureHandle = {
  readonly operationRef: string;
  readonly completion: Promise<VoiceCaptureCompletion>;
  stop(): Promise<CapturedVoicePcm>;
  cancel(): Promise<void>;
};

export type VoiceCaptureStartRequest = {
  /** Caller-owned canonical UUID. This adapter never creates operation identity. */
  operationRef: string;
};

export interface VoiceCapturePlatform {
  isSecureContext(): boolean;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createAudioContext(options: AudioContextOptions): AudioContext;
  createAudioWorkletNode(
    context: AudioContext,
    name: string,
    options: AudioWorkletNodeOptions,
  ): AudioWorkletNode;
  workletModuleUrl: string | URL;
  flushTimeoutMs: number;
}

type PendingCapture = {
  generation: number;
  stream: MediaStream | null;
  context: AudioContext | null;
  source: MediaStreamAudioSourceNode | null;
  node: AudioWorkletNode | null;
  trackEndedListener: (() => void) | null;
  cleaned: boolean;
};

type PcmMessage = { type: 'pcm'; pcm: ArrayBuffer; sampleCount: number };
type FlushMessage = { type: 'flushed'; sampleCount: number };
type LimitMessage = { type: 'limit'; sampleCount: number };

function toVoiceCaptureError(error: unknown, fallback: VoiceCaptureErrorCode): VoiceCaptureError {
  if (error instanceof VoiceCaptureError) return error;
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')) {
    return new VoiceCaptureError('permission_denied', 'Microphone permission was denied.', { cause: error });
  }
  return new VoiceCaptureError(fallback, error instanceof Error ? error.message : String(error), { cause: error });
}

function stopStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) {
    try { track.stop(); } catch { /* cleanup is best effort */ }
  }
}

async function cleanupPendingCapture(pending: PendingCapture): Promise<void> {
  if (pending.cleaned) return;
  pending.cleaned = true;
  if (pending.trackEndedListener) {
    for (const track of pending.stream?.getTracks() ?? []) {
      track.removeEventListener?.('ended', pending.trackEndedListener);
    }
  }
  stopStream(pending.stream);
  try { pending.source?.disconnect(); } catch { /* cleanup is best effort */ }
  try { pending.node?.disconnect(); } catch { /* cleanup is best effort */ }
  if (pending.node) {
    pending.node.port.onmessage = null;
    pending.node.port.onmessageerror = null;
    pending.node.onprocessorerror = null;
  }
  if (pending.context && pending.context.state !== 'closed') {
    try { await pending.context.close(); } catch { /* cleanup is best effort */ }
  }
}

function defaultPlatform(): VoiceCapturePlatform {
  return {
    isSecureContext: () => globalThis.isSecureContext === true,
    getUserMedia: (constraints) => {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new VoiceCaptureError('media_devices_unavailable');
      }
      return navigator.mediaDevices.getUserMedia(constraints);
    },
    createAudioContext: (options) => {
      if (typeof AudioContext !== 'function') throw new VoiceCaptureError('audio_worklet_unavailable');
      return new AudioContext(options);
    },
    createAudioWorkletNode: (context, name, options) => {
      if (typeof AudioWorkletNode !== 'function') throw new VoiceCaptureError('audio_worklet_unavailable');
      return new AudioWorkletNode(context, name, options);
    },
    workletModuleUrl: voicePcmWorkletUrl,
    flushTimeoutMs: DEFAULT_FLUSH_TIMEOUT_MS,
  };
}

class ActiveVoiceCapture implements VoiceCaptureHandle {
  readonly completion: Promise<VoiceCaptureCompletion>;
  private resolveCompletion!: (completion: VoiceCaptureCompletion) => void;
  private readonly chunks: Uint8Array[] = [];
  private sampleCount = 0;
  private state: 'recording' | 'stopping' | 'settled' = 'recording';
  private terminal: VoiceCaptureCompletion | null = null;
  private stopTask: Promise<CapturedVoicePcm> | null = null;
  private flushResolve: (() => void) | null = null;
  private flushReject: ((error: VoiceCaptureError) => void) | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly operationRef: string,
    private readonly resources: PendingCapture,
    private readonly flushTimeoutMs: number,
    private readonly onSettled: (capture: ActiveVoiceCapture) => void,
  ) {
    this.completion = new Promise((resolve) => { this.resolveCompletion = resolve; });
    resources.node!.port.onmessage = (event: MessageEvent<unknown>) => this.onMessage(event.data);
    resources.node!.port.onmessageerror = () => this.fail(new VoiceCaptureError('invalid_pcm_message'));
    resources.node!.onprocessorerror = () => this.fail(new VoiceCaptureError('capture_failed'));
    resources.trackEndedListener = () => this.fail(new VoiceCaptureError('capture_failed', 'Microphone track ended.'));
    for (const track of resources.stream?.getTracks() ?? []) {
      track.addEventListener?.('ended', resources.trackEndedListener);
    }
  }

  stop(): Promise<CapturedVoicePcm> {
    if (this.stopTask) return this.stopTask;
    if (this.terminal?.kind === 'captured') return Promise.resolve(this.terminal.capture);
    if (this.terminal?.kind === 'failed') return Promise.reject(this.terminal.error);
    if (this.terminal?.kind === 'cancelled') return Promise.reject(new VoiceCaptureError('cancelled'));
    this.stopTask = this.finishCapture('manual', false);
    return this.stopTask;
  }

  async cancel(): Promise<void> {
    if (this.state === 'settled') return;
    if (this.state === 'stopping' && this.stopTask) {
      await this.stopTask.then(() => undefined, () => undefined);
      return;
    }
    this.state = 'settled';
    this.rejectFlush(new VoiceCaptureError('cancelled'));
    await cleanupPendingCapture(this.resources);
    this.settle({ kind: 'cancelled' });
  }

  private onMessage(message: unknown): void {
    if (this.state === 'settled' || !message || typeof message !== 'object') return;
    const type = (message as { type?: unknown }).type;
    if (type === 'pcm') {
      this.acceptPcm(message as PcmMessage);
      return;
    }
    if (type === 'flushed') {
      if (!this.validTerminalMessage(message as FlushMessage)) return;
      this.resolveFlush();
      return;
    }
    if (type === 'limit') {
      if (!this.validTerminalMessage(message as LimitMessage)) return;
      if (this.state === 'stopping' && this.stopTask) {
        this.resolveFlush();
        return;
      }
      this.stopTask ??= this.finishCapture('limit', true);
      return;
    }
    this.fail(new VoiceCaptureError('invalid_pcm_message'));
  }

  private acceptPcm(message: PcmMessage): void {
    const { pcm, sampleCount } = message;
    if (!(pcm instanceof ArrayBuffer)
      || !Number.isSafeInteger(sampleCount)
      || sampleCount <= 0
      || pcm.byteLength !== sampleCount * 2
      || this.sampleCount + sampleCount > VOICE_PCM_MAX_SAMPLES) {
      this.fail(new VoiceCaptureError('invalid_pcm_message'));
      return;
    }
    this.chunks.push(new Uint8Array(pcm));
    this.sampleCount += sampleCount;
  }

  private validTerminalMessage(message: FlushMessage | LimitMessage): boolean {
    if (!Number.isSafeInteger(message.sampleCount)
      || message.sampleCount !== this.sampleCount
      || message.sampleCount > VOICE_PCM_MAX_SAMPLES) {
      this.fail(new VoiceCaptureError('invalid_pcm_message'));
      return false;
    }
    return true;
  }

  private async finishCapture(reason: 'manual' | 'limit', alreadyFlushed: boolean): Promise<CapturedVoicePcm> {
    if (this.state === 'settled') {
      if (this.terminal?.kind === 'captured') return this.terminal.capture;
      throw this.terminal?.kind === 'failed' ? this.terminal.error : new VoiceCaptureError('cancelled');
    }
    this.state = 'stopping';
    try {
      if (!alreadyFlushed) await this.flushWorklet();
      const pcm = new Uint8Array(this.sampleCount * 2);
      let offset = 0;
      for (const chunk of this.chunks) {
        pcm.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const capture: CapturedVoicePcm = {
        operationRef: this.operationRef,
        pcm,
        sampleRate: VOICE_PCM_SAMPLE_RATE,
        channelCount: 1,
        bitsPerSample: 16,
        sampleCount: this.sampleCount,
        durationMs: (this.sampleCount / VOICE_PCM_SAMPLE_RATE) * 1_000,
      };
      this.state = 'settled';
      await cleanupPendingCapture(this.resources);
      this.settle({ kind: 'captured', reason, capture });
      return capture;
    } catch (error) {
      const captureError = toVoiceCaptureError(error, 'capture_failed');
      this.state = 'settled';
      await cleanupPendingCapture(this.resources);
      this.settle({ kind: 'failed', error: captureError });
      throw captureError;
    }
  }

  private flushWorklet(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.flushResolve = resolve;
      this.flushReject = reject;
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushResolve = null;
        this.flushReject = null;
        reject(new VoiceCaptureError('flush_timeout'));
      }, this.flushTimeoutMs);
      try {
        this.resources.node!.port.postMessage({ type: 'flush' });
      } catch (error) {
        this.rejectFlush(toVoiceCaptureError(error, 'capture_failed'));
      }
    });
  }

  private resolveFlush(): void {
    if (!this.flushResolve) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    const resolve = this.flushResolve;
    this.flushTimer = null;
    this.flushResolve = null;
    this.flushReject = null;
    resolve();
  }

  private rejectFlush(error: VoiceCaptureError): void {
    if (!this.flushReject) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    const reject = this.flushReject;
    this.flushTimer = null;
    this.flushResolve = null;
    this.flushReject = null;
    reject(error);
  }

  private fail(error: VoiceCaptureError): void {
    if (this.state === 'settled') return;
    this.state = 'settled';
    this.rejectFlush(error);
    void cleanupPendingCapture(this.resources).then(() => this.settle({ kind: 'failed', error }));
  }

  private settle(completion: VoiceCaptureCompletion): void {
    if (this.terminal) return;
    this.terminal = completion;
    this.resolveCompletion(completion);
    this.onSettled(this);
  }
}

export class VoiceCaptureController {
  private readonly platform: VoiceCapturePlatform;
  private generation = 0;
  private disposed = false;
  private pending: PendingCapture | null = null;
  private active: ActiveVoiceCapture | null = null;

  constructor(platform: VoiceCapturePlatform = defaultPlatform()) {
    this.platform = platform;
  }

  /** Must be called directly from a user gesture. It is the only permission entrypoint. */
  async start(request: VoiceCaptureStartRequest): Promise<VoiceCaptureHandle> {
    if (this.disposed) throw new VoiceCaptureError('disposed');
    if (this.pending || this.active) throw new VoiceCaptureError('already_active');
    if (!OPERATION_REF_PATTERN.test(request.operationRef)) {
      throw new VoiceCaptureError('invalid_operation_ref');
    }
    if (!this.platform.isSecureContext()) throw new VoiceCaptureError('insecure_context');

    const generation = ++this.generation;
    const pending: PendingCapture = {
      generation,
      stream: null,
      context: null,
      source: null,
      node: null,
      trackEndedListener: null,
      cleaned: false,
    };
    this.pending = pending;

    try {
      const stream = await this.platform.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      });
      if (this.disposed || generation !== this.generation || this.pending !== pending) {
        stopStream(stream);
        throw new VoiceCaptureError('cancelled');
      }
      pending.stream = stream;
      this.assertCurrent(pending);

      pending.context = this.platform.createAudioContext({
        latencyHint: 'interactive',
        sampleRate: VOICE_PCM_SAMPLE_RATE,
      });
      if (!pending.context.audioWorklet?.addModule) {
        throw new VoiceCaptureError('audio_worklet_unavailable');
      }
      await pending.context.audioWorklet.addModule(this.platform.workletModuleUrl);
      this.assertCurrent(pending);

      pending.node = this.platform.createAudioWorkletNode(
        pending.context,
        VOICE_PCM_PROCESSOR_NAME,
        {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: 'explicit',
          processorOptions: { maxSamples: VOICE_PCM_MAX_SAMPLES },
        },
      );
      pending.source = pending.context.createMediaStreamSource(pending.stream);
      pending.source.connect(pending.node);
      // The processor intentionally emits silence. Keeping that silent output in
      // the render graph ensures Chromium continues pulling microphone frames.
      pending.node.connect(pending.context.destination);
      if (pending.context.state === 'suspended') await pending.context.resume();
      this.assertCurrent(pending);

      const active = new ActiveVoiceCapture(
        request.operationRef,
        pending,
        this.platform.flushTimeoutMs,
        (settled) => {
          if (this.active === settled) this.active = null;
        },
      );
      this.pending = null;
      this.active = active;
      return active;
    } catch (error) {
      if (this.pending === pending) this.pending = null;
      await cleanupPendingCapture(pending);
      if (generation !== this.generation || this.disposed) throw new VoiceCaptureError('cancelled');
      throw toVoiceCaptureError(error, 'capture_failed');
    }
  }

  async cancelActive(): Promise<void> {
    this.generation += 1;
    const pending = this.pending;
    this.pending = null;
    const active = this.active;
    this.active = null;
    await Promise.all([
      pending ? cleanupPendingCapture(pending) : Promise.resolve(),
      active ? active.cancel() : Promise.resolve(),
    ]);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.cancelActive();
  }

  private assertCurrent(pending: PendingCapture): void {
    if (this.disposed || pending.generation !== this.generation || this.pending !== pending) {
      throw new VoiceCaptureError('cancelled');
    }
  }
}

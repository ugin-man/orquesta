import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attestPinnedAttachmentRuntime,
  assertSanitizedAttachmentProof,
  renderCodePng,
  resolveRuntimeComponentReceipt,
  runLiveAttachmentCanary,
  verifyResolvedRuntimeMeasurement,
} from '../scripts/p2-006-live-attachment-canary.mjs';

const TEST_RUNTIME_ATTESTATION = Object.freeze({
  version: '0.144.5',
  executableSha256: 'a'.repeat(64),
  executableSha256Verified: true,
  contractRef: 'codex-runtime/runtime-manifest.json#schemaVersion=1',
});

const attestTestRuntime = async () => TEST_RUNTIME_ATTESTATION;

function success<T extends object>(value: T) {
  return { ok: true, ...value };
}

function fakeAdapter({
  stall = false,
  answer = '482901',
  terminalStatus = 'completed',
  terminalTiming = 'inside-start',
  removeSourceBeforeTerminal = false,
  shutdownFails = false,
} = {}) {
  let listener: ((event: Record<string, any>) => void) | null = null;
  let createdCwd: string | null = null;
  let observedInput: Array<Record<string, unknown>> = [];
  const calls = {
    creates: 0, starts: 0, reads: 0, interrupts: 0, archives: 0, shutdowns: 0,
    sourceExistsAtTerminal: null as boolean | null,
    sourceExistsAtArchive: null as boolean | null,
    sourceExistsAtShutdown: null as boolean | null,
  };
  return {
    calls,
    get createdCwd() { return createdCwd; },
    get observedInput() { return observedInput; },
    adapter: {
      async subscribeEvents({ listener: nextListener }: { listener: typeof listener }) {
        listener = nextListener;
        return success({ subscription: { unsubscribe() { listener = null; } } });
      },
      async createThread({ params }: { params: Record<string, unknown> }) {
        calls.creates += 1;
        createdCwd = String(params.cwd);
        return success({
          thread_id: 'secret-thread-id',
          runtime_profile: { cwd: createdCwd, sandbox: 'read-only', approval_policy: 'never' },
        });
      },
      async startTurn({ input }: { input: Array<Record<string, unknown>> }) {
        calls.starts += 1;
        observedInput = input;
        listener?.({
          type: 'provider_event',
          provider_event: {
            direction: 'client_to_provider', event_type: 'provider.command_requested',
            source: { method: 'turn/start', has_request_id: true, frame_sha256: 'b'.repeat(64) },
          },
        });
        const emitTerminal = () => {
          const sourcePath = String(observedInput[1]?.path);
          if (removeSourceBeforeTerminal && existsSync(sourcePath)) rmSync(sourcePath, { force: false });
          calls.sourceExistsAtTerminal = existsSync(sourcePath);
          listener?.({ type: 'turn_completed', turn_id: 'secret-turn-id', status: terminalStatus });
        };
        if (!stall) {
          if (terminalTiming === 'inside-start') emitTerminal();
          else setTimeout(emitTerminal, 0);
        }
        return success({ turn_id: 'secret-turn-id' });
      },
      async readThread() {
        calls.reads += 1;
        return success({ thread: { turns: [{ items: [{ type: 'agentMessage', text: answer }] }] } });
      },
      async interruptTurn() {
        calls.interrupts += 1;
        return success({});
      },
      async archiveThread() {
        calls.archives += 1;
        calls.sourceExistsAtArchive = existsSync(String(observedInput[1]?.path));
        return success({});
      },
      async shutdown() {
        calls.shutdowns += 1;
        calls.sourceExistsAtShutdown = existsSync(String(observedInput[1]?.path));
        return shutdownFails ? { ok: false } : success({});
      },
    },
  };
}

function fakeTextResumeAdapters() {
  let firstListener: ((event: Record<string, any>) => void) | null = null;
  let secondListener: ((event: Record<string, any>) => void) | null = null;
  let answer = '';
  let internalGuide = '';
  const calls = {
    factories: 0, creates: 0, resumes: 0, starts: 0, toolCalls: 0,
    archives: 0, firstShutdowns: 0, secondShutdowns: 0,
  };
  const first = {
    async subscribeEvents({ listener }: { listener: typeof firstListener }) {
      firstListener = listener;
      return success({ subscription: { unsubscribe() { firstListener = null; } } });
    },
    async createThread({ params }: { params: Record<string, any> }) {
      calls.creates += 1;
      return success({
        thread_id: 'secret-thread-id',
        runtime_profile: { cwd: params.cwd, sandbox: 'read-only', approval_policy: 'never' },
      });
    },
    async startTurn() {
      calls.starts += 1;
      firstListener?.({ type: 'turn_completed', turn_id: 'prime-turn', status: 'completed' });
      return success({ turn_id: 'prime-turn' });
    },
    async shutdown() {
      calls.firstShutdowns += 1;
      return success({});
    },
  };
  const second = {
    async subscribeEvents({ listener }: { listener: typeof secondListener }) {
      secondListener = listener;
      return success({ subscription: { unsubscribe() { secondListener = null; } } });
    },
    async resumeThread() {
      calls.resumes += 1;
      return success({ thread_id: 'secret-thread-id' });
    },
    async startTurn(input: Record<string, any>) {
      calls.starts += 1;
      internalGuide = String(input.input[0]?.text ?? '');
      const capability = /Capability: ([a-f0-9]{64})/u.exec(internalGuide)?.[1];
      if (!capability) throw new Error('test capability missing');
      const handler = input.dynamicToolHandlerFactory({
        providerConnectionId: 'secret-provider-id',
        correlationId: input.correlationId,
        threadId: input.threadId,
        turnId: 'secret-turn-id',
      });
      const handled = await handler.handle({
        method: 'item/tool/call',
        tool: 'orquesta_attachment_read',
        arguments: { capability, cursor: null },
      });
      calls.toolCalls += 1;
      answer = String(handled.response.contentItems[0]?.text ?? '').trim();
      secondListener?.({ type: 'turn_completed', turn_id: 'secret-turn-id', status: 'completed' });
      return success({ turn_id: 'secret-turn-id' });
    },
    async readThread() {
      return success({ thread: { turns: [{ items: [
        { type: 'userMessage', text: internalGuide },
        { type: 'dynamicToolCall' },
        { type: 'agentMessage', text: answer },
      ] }] } });
    },
    async archiveThread() {
      calls.archives += 1;
      return success({});
    },
    async shutdown() {
      calls.secondShutdowns += 1;
      return success({});
    },
  };
  return {
    calls,
    get answer() { return answer; },
    adapterFactory() {
      calls.factories += 1;
      if (calls.factories === 1) return first;
      if (calls.factories === 2) return second;
      throw new Error('unexpected adapter factory call');
    },
  };
}

describe('P2-006 attachment canary harness unit', () => {
  it('delegates release receipts to the canonical attestation verifier and fails closed on rejection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orquesta-release-receipt-'));
    try {
      const manifestPath = join(root, 'apps', 'orquesta-desktop-next', 'codex-runtime', 'runtime-manifest.json');
      const receiptPath = join(root, 'release-attestation.json');
      const receipt = {
        schemaVersion: 2,
        executable: { path: 'apps/orquesta-desktop-next/src-tauri/target/release/Orquesta Next.exe' },
        codexRuntimeManifest: {
          path: 'apps/orquesta-desktop-next/codex-runtime/runtime-manifest.json',
        },
      };
      mkdirSync(dirname(manifestPath), { recursive: true });
      writeFileSync(manifestPath, JSON.stringify({
        schemaVersion: 1,
        packages: [{ directory: 'codex-sdk', name: '@openai/codex-sdk', version: '0.144.5' }],
        files: [],
      }));
      writeFileSync(receiptPath, JSON.stringify(receipt));
      let verifierCalls = 0;
      const resolved = await resolveRuntimeComponentReceipt({
        receiptPath,
        repositoryRoot: root,
        releaseVerifier: (input: Record<string, string>) => {
          verifierCalls += 1;
          expect(input).toMatchObject({ repositoryRoot: root, attestationPath: receiptPath });
          expect(input.desktopExe).toBe(join(root, ...receipt.executable.path.split('/')));
          return receipt;
        },
      });
      expect(verifierCalls).toBe(1);
      expect(resolved).toMatchObject({
        receiptKind: 'desktop-release-attestation',
        manifestPath,
      });
      await expect(resolveRuntimeComponentReceipt({
        receiptPath,
        repositoryRoot: root,
        releaseVerifier: () => { throw new Error('rejected'); },
      })).rejects.toThrow(/runtime_release_attestation_invalid/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('generates a real PNG, sends one localImage input, and emits sanitized proof', async () => {
    const fake = fakeAdapter();
    const proof = await runLiveAttachmentCanary({
      adapterFactory: () => fake.adapter,
      runtimeAttestor: attestTestRuntime,
      codeFactory: () => '482901',
      timeoutMs: 100,
      now: () => '2026-08-26T00:00:00.000Z',
    });

    expect(proof.status).toBe('passed');
    expect(proof.attachment).toMatchObject({
      input_type: 'localImage', generated_media_type: 'image/png',
      generated_in_disposable_root: true, turn_start_provider_frames: 1,
      source_present_after_turn_accept: true,
      source_present_at_terminal: true,
      source_present_through_readback: true,
      source_removed_after_terminal_readback: true,
      turn_start_frame_validated: true, provider_terminal: true,
      visual_ocr_exact_match: true,
    });
    expect(fake.observedInput[0]).toMatchObject({ type: 'text', text_elements: [] });
    expect(fake.observedInput[1]).toMatchObject({ type: 'localImage' });
    const imagePath = String(fake.observedInput[1].path);
    expect(imagePath.endsWith('generated-code.png')).toBe(true);
    expect(existsSync(imagePath)).toBe(false);
    expect(fake.calls).toEqual({
      creates: 1, starts: 1, reads: 1, interrupts: 0, archives: 1, shutdowns: 1,
      sourceExistsAtTerminal: true,
      sourceExistsAtArchive: false,
      sourceExistsAtShutdown: false,
    });
    expect(proof.cleanup.source_absent_before_archive).toBe(true);
    const serialized = JSON.stringify(proof);
    for (const secret of ['482901', 'secret-thread-id', 'secret-turn-id', imagePath, 'generated-code.png']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('covers the text dynamic-tool and cross-process resume invariants in one canary mode', async () => {
    const fake = fakeTextResumeAdapters();
    const proof = await runLiveAttachmentCanary({
      mode: 'text-resume',
      adapterFactory: () => fake.adapterFactory(),
      runtimeAttestor: attestTestRuntime,
      timeoutMs: 100,
      now: () => '2026-08-26T00:00:00.000Z',
    });

    expect(proof.status).toBe('passed');
    expect(proof.mode).toBe('text-resume');
    expect(proof.attachment).toMatchObject({
      input_type: 'dynamicTool',
      first_process_shutdown: true,
      resumed_after_provider_restart: true,
      exact_marker_read: true,
      dynamic_tool_call_count: 1,
      tool_arguments_contained_path: false,
      provider_history_private_leak: false,
      source_removed_after_terminal_readback: true,
    });
    expect(proof.cleanup).toMatchObject({
      thread_archived: true,
      first_process_shutdown: true,
      second_process_shutdown: true,
      temporary_root_removed: true,
    });
    expect(fake.calls).toEqual({
      factories: 2, creates: 1, resumes: 1, starts: 2, toolCalls: 1,
      archives: 1, firstShutdowns: 1, secondShutdowns: 1,
    });
    expect(JSON.stringify(proof)).not.toContain(fake.answer);
  });

  it('fails closed when adapter shutdown returns an error result', async () => {
    const fake = fakeAdapter({ shutdownFails: true });
    const proof = await runLiveAttachmentCanary({
      adapterFactory: () => fake.adapter,
      runtimeAttestor: attestTestRuntime,
      codeFactory: () => '482901',
      timeoutMs: 100,
      now: () => '2026-08-26T00:00:00.000Z',
    });
    expect(proof.status).toBe('failed');
    expect(proof.failure_code).toBe('adapter_shutdown_failed');
  });

  it('keeps the source through an asynchronous terminal and removes it only after readback', async () => {
    const fake = fakeAdapter({ terminalTiming: 'after-start' });
    const proof = await runLiveAttachmentCanary({
      adapterFactory: () => fake.adapter,
      runtimeAttestor: attestTestRuntime,
      codeFactory: () => '482901',
      timeoutMs: 100,
      now: () => '2026-08-26T00:00:00.000Z',
    });

    expect(proof.status).toBe('passed');
    expect(proof.attachment).toMatchObject({
      source_present_after_turn_accept: true,
      source_present_at_terminal: true,
      source_present_through_readback: true,
      source_removed_after_terminal_readback: true,
      provider_terminal_status: 'completed',
      visual_ocr_exact_match: true,
    });
    expect(fake.calls.sourceExistsAtTerminal).toBe(true);
    expect(fake.calls.sourceExistsAtArchive).toBe(false);
    expect(fake.calls.sourceExistsAtShutdown).toBe(false);
    expect(proof.cleanup.source_absent_before_archive).toBe(true);
  });

  it('produces a structurally valid non-empty PNG without an external fixture', () => {
    const png = renderCodePng('012345');
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.includes(Buffer.from('IHDR'))).toBe(true);
    expect(png.includes(Buffer.from('IDAT'))).toBe(true);
    expect(png.includes(Buffer.from('IEND'))).toBe(true);
  });

  it('fails closed on a non-terminal Provider turn and still archives and cleans up', async () => {
    const fake = fakeAdapter({ stall: true });
    const proof = await runLiveAttachmentCanary({
      adapterFactory: () => fake.adapter,
      runtimeAttestor: attestTestRuntime,
      codeFactory: () => '482901',
      timeoutMs: 5,
      now: () => '2026-08-26T00:00:00.000Z',
    });
    expect(proof.status).toBe('failed');
    expect(proof.failure_code).toBe('attachment_turn_timeout');
    expect(proof.limits.fake_fallback).toBe(false);
    expect(fake.calls.interrupts).toBe(1);
    expect(fake.calls.archives).toBe(1);
    expect(fake.calls.shutdowns).toBe(1);
    expect(proof.cleanup.temporary_root_removed).toBe(true);
    expect(proof.cleanup.source_absent_before_archive).toBe(false);
    expect(proof.attachment).toMatchObject({
      source_present_after_turn_accept: true,
      source_present_at_terminal: false,
      source_present_through_readback: false,
      source_removed_after_terminal_readback: false,
    });
    expect(fake.calls.sourceExistsAtArchive).toBe(true);
    expect(fake.calls.sourceExistsAtShutdown).toBe(true);
  });

  it('does not treat a failed terminal Provider status as a successful attachment proof', async () => {
    const fake = fakeAdapter({ terminalStatus: 'failed' });
    const proof = await runLiveAttachmentCanary({
      adapterFactory: () => fake.adapter,
      runtimeAttestor: attestTestRuntime,
      codeFactory: () => '482901',
      timeoutMs: 100,
      now: () => '2026-08-26T00:00:00.000Z',
    });
    expect(proof.status).toBe('failed');
    expect(proof.failure_code).toBe('attachment_turn_not_completed');
    expect(proof.attachment.provider_terminal_status).toBe('failed');
    expect(fake.calls.reads).toBe(0);
    expect(fake.calls.archives).toBe(1);
    expect(fake.calls.shutdowns).toBe(1);
    expect(proof.cleanup.temporary_root_removed).toBe(true);
    expect(fake.calls.sourceExistsAtTerminal).toBe(true);
    expect(proof.attachment).toMatchObject({
      source_present_after_turn_accept: true,
      source_present_at_terminal: true,
      source_present_through_readback: false,
      source_removed_after_terminal_readback: false,
    });
    expect(fake.calls.sourceExistsAtArchive).toBe(true);
    expect(fake.calls.sourceExistsAtShutdown).toBe(true);
    expect(proof.cleanup.source_absent_before_archive).toBe(false);
  });

  it('retains exact turn/start diagnostics and the source when OCR readback mismatches', async () => {
    const fake = fakeAdapter({ answer: '000000' });
    const proof = await runLiveAttachmentCanary({
      adapterFactory: () => fake.adapter,
      runtimeAttestor: attestTestRuntime,
      codeFactory: () => '482901',
      timeoutMs: 100,
      now: () => '2026-08-26T00:00:00.000Z',
    });

    expect(proof.status).toBe('failed');
    expect(proof.failure_code).toBe('attachment_ocr_mismatch');
    expect(proof.attachment).toMatchObject({
      turn_start_provider_frames: 1,
      turn_start_frame_validated: true,
      source_present_at_terminal: true,
      source_present_through_readback: true,
      source_removed_after_terminal_readback: false,
      visual_ocr_exact_match: false,
    });
    expect(fake.calls.sourceExistsAtArchive).toBe(true);
    expect(fake.calls.sourceExistsAtShutdown).toBe(true);
    expect(proof.cleanup.source_absent_before_archive).toBe(false);
  });

  it('fails closed if the source disappears before Provider terminal observation', async () => {
    const fake = fakeAdapter({ terminalTiming: 'after-start', removeSourceBeforeTerminal: true });
    const proof = await runLiveAttachmentCanary({
      adapterFactory: () => fake.adapter,
      runtimeAttestor: attestTestRuntime,
      codeFactory: () => '482901',
      timeoutMs: 100,
      now: () => '2026-08-26T00:00:00.000Z',
    });

    expect(proof.status).toBe('failed');
    expect(proof.failure_code).toBe('attachment_source_missing_before_terminal_observation');
    expect(proof.attachment).toMatchObject({
      source_present_after_turn_accept: true,
      source_present_at_terminal: false,
      source_removed_after_terminal_readback: false,
    });
    expect(fake.calls.reads).toBe(0);
    expect(fake.calls.sourceExistsAtArchive).toBe(false);
    expect(fake.calls.sourceExistsAtShutdown).toBe(false);
    expect(proof.cleanup.source_absent_before_archive).toBe(true);
  });

  it('fails closed if explicit post-terminal removal leaves the source behind', async () => {
    const fake = fakeAdapter();
    const proof = await runLiveAttachmentCanary({
      adapterFactory: () => fake.adapter,
      runtimeAttestor: attestTestRuntime,
      codeFactory: () => '482901',
      sourceRemover: () => {},
      timeoutMs: 100,
      now: () => '2026-08-26T00:00:00.000Z',
    });

    expect(proof.status).toBe('failed');
    expect(proof.failure_code).toBe('attachment_source_remains_after_post_terminal_removal');
    expect(proof.attachment).toMatchObject({
      source_present_at_terminal: true,
      source_present_through_readback: true,
      source_removed_after_terminal_readback: false,
      visual_ocr_exact_match: true,
    });
    expect(fake.calls.sourceExistsAtArchive).toBe(true);
    expect(fake.calls.sourceExistsAtShutdown).toBe(true);
    expect(proof.cleanup.source_absent_before_archive).toBe(false);
  });

  it('measures the resolver-selected executable and compares it with the pinned manifest', async () => {
    const actualSha256 = 'c'.repeat(64);
    let hashedPath: string | null = null;
    const attestation = await attestPinnedAttachmentRuntime({
      sdkPackageRoot: 'C:\\fixture\\node_modules\\@openai\\codex-sdk',
      manifestPath: 'C:\\fixture\\runtime-manifest.json',
      runtimeResolver: () => ({
        sdk_version: '0.144.5', codex_version: '0.144.5',
        runtime_package: '@openai/codex-win32-x64',
        target_triple: 'x86_64-pc-windows-msvc',
        executable_path: 'C:\\fixture\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe',
      }),
      fileHasher: async (filePath: string) => {
        hashedPath = filePath;
        return actualSha256;
      },
      manifestReader: async () => ({ files: [{
        path: 'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
        sha256: actualSha256,
      }] }),
    });
    expect(hashedPath).toContain('codex.exe');
    expect(attestation).toMatchObject({
      version: '0.144.5', executableSha256: actualSha256,
      executableSha256Verified: true,
    });
  });

  it('rejects a resolver-selected executable whose measured hash differs from the manifest', () => {
    const runtime = {
      sdk_version: '0.144.5', codex_version: '0.144.5',
      runtime_package: '@openai/codex-win32-x64',
      target_triple: 'x86_64-pc-windows-msvc',
      executable_path: 'C:\\fixture\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe',
    };
    const manifest = { files: [{
      path: 'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe',
      sha256: 'd'.repeat(64),
    }] };
    expect(() => verifyResolvedRuntimeMeasurement(runtime, manifest, 'e'.repeat(64)))
      .toThrow(/runtime_executable_sha256_mismatch/);
  });

  it('does not construct the Provider adapter when runtime attestation fails', async () => {
    const fake = fakeAdapter();
    let adapterFactoryCalls = 0;
    const proof = await runLiveAttachmentCanary({
      adapterFactory: () => {
        adapterFactoryCalls += 1;
        return fake.adapter;
      },
      runtimeAttestor: async () => ({
        ...TEST_RUNTIME_ATTESTATION,
        executableSha256Verified: false,
      }),
      codeFactory: () => '482901',
      timeoutMs: 100,
      now: () => '2026-08-26T00:00:00.000Z',
    });
    expect(proof.status).toBe('failed');
    expect(proof.failure_code).toBe('runtime_attestation_invalid');
    expect(proof.pinned_runtime.executable_sha256_verified).toBe(false);
    expect(adapterFactoryCalls).toBe(0);
    expect(fake.calls.creates).toBe(0);
    expect(proof.cleanup.disposable_threads_created).toBe(0);
  });

  it('rejects evidence containing raw paths, IDs, or generated OCR content', () => {
    expect(() => assertSanitizedAttachmentProof({ local_image_path: 'secret' }))
      .toThrow(/forbidden_evidence_key_local_image_path/);
    expect(() => assertSanitizedAttachmentProof({ safe: '482901' }, ['482901']))
      .toThrow(/secret_present_in_evidence/);
  });
});

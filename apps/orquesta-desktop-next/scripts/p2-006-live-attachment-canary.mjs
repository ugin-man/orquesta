import { Buffer } from 'node:buffer';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { existsSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const { createAppServerAdapter } = require('../../../packages/codex-adapter/src');
const { verifyDesktopReleaseAttestation } = require('../../../orquesta/scripts/desktop-release-attestation.js');
import {
  attestPinnedCodexRuntime,
  BUNDLED_SDK_PACKAGE_ROOT,
  PINNED_CODEX_VERSION,
  verifyResolvedRuntimeMeasurement,
} from './live-canary-runtime-attestation.mjs';

export {
  attestPinnedCodexRuntime as attestPinnedAttachmentRuntime,
  verifyResolvedRuntimeMeasurement,
};

const DEFAULT_TIMEOUT_MS = 120_000;
const TEMPORARY_ROOT_PREFIX = 'orquesta-p2-006-attachment-';
const IMAGE_NAME = 'generated-code.png';
const TEXT_NAME = 'sealed-marker.txt';
const LIVE_FLAG = 'ORQUESTA_P2_006_LIVE_ATTACHMENT';
const CANARY_MODES = new Set(['image', 'text-resume']);
const TOOL_NAME = 'orquesta_attachment_read';
const PROMPT = 'Read the six-digit code shown in the attached image. Reply with exactly the six digits and nothing else.';
const TEXT_PROMPT = `Use ${TOOL_NAME} with the supplied capability and cursor null. Reply with exactly the file marker and nothing else.`;
const FORBIDDEN_EVIDENCE_KEYS = new Set([
  'thread_id', 'turn_id', 'request_id', 'provider_request_id',
  'raw_frame', 'raw_frames', 'message_text', 'prompt_text',
  'model', 'repository_root', 'temporary_root', 'local_image_path', 'executable_path',
]);
const DIGITS = Object.freeze({
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  6: ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
});

class CanaryFailure extends Error {
  constructor(code) {
    super(code);
    this.name = 'CanaryFailure';
    this.code = code;
  }
}

function requiredResult(operation, result) {
  if (!result?.ok) throw new CanaryFailure(`${operation}_failed`);
  return result;
}

function objectEntries(value) {
  return value && typeof value === 'object' ? Object.entries(value) : [];
}

export function assertSanitizedAttachmentProof(proof, secrets = []) {
  const walk = (value) => {
    for (const [key, child] of objectEntries(value)) {
      if (FORBIDDEN_EVIDENCE_KEYS.has(key)) throw new CanaryFailure(`forbidden_evidence_key_${key}`);
      walk(child);
    }
  };
  walk(proof);
  const serialized = JSON.stringify(proof);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret && serialized.includes(secret)) {
      throw new CanaryFailure('secret_present_in_evidence');
    }
  }
  return proof;
}

function resolvedDirectChild(parent, candidate) {
  const realParent = realpathSync.native(parent);
  const realCandidate = realpathSync.native(candidate);
  const child = relative(realParent, realCandidate);
  if (!child || child.startsWith('..') || isAbsolute(child) || dirname(realCandidate) !== realParent) {
    throw new CanaryFailure('temporary_root_boundary_invalid');
  }
  if (!basename(realCandidate).startsWith(TEMPORARY_ROOT_PREFIX)) {
    throw new CanaryFailure('temporary_root_prefix_invalid');
  }
  return { realCandidate };
}

function sameExistingDirectory(left, right) {
  if (typeof left !== 'string' || !left) return false;
  try {
    const leftReal = realpathSync.native(left);
    const rightReal = realpathSync.native(right);
    return process.platform === 'win32'
      ? leftReal.toLowerCase() === rightReal.toLowerCase()
      : leftReal === rightReal;
  } catch {
    return false;
  }
}

function insideRoot(root, candidate) {
  const child = relative(root, candidate);
  return child !== '' && !child.startsWith('..') && !isAbsolute(child);
}

function assertRuntimeComponentManifest(manifest) {
  const packageEntry = Array.isArray(manifest?.packages)
    ? manifest.packages.find((entry) => entry?.directory === 'codex-sdk')
    : null;
  if (manifest?.schemaVersion !== 1
    || packageEntry?.name !== '@openai/codex-sdk'
    || packageEntry?.version !== PINNED_CODEX_VERSION
    || !Array.isArray(manifest?.files)) {
    throw new CanaryFailure('runtime_component_receipt_invalid');
  }
}

/**
 * @param {{
 *   receiptPath: string,
 *   repositoryRoot?: string | null,
 *   releaseVerifier?: (input: {
 *     repositoryRoot: string,
 *     attestationPath: string,
 *     desktopExe: string,
 *   }) => Record<string, any>,
 * }} options
 */
export async function resolveRuntimeComponentReceipt({
  receiptPath,
  repositoryRoot = null,
  releaseVerifier = verifyDesktopReleaseAttestation,
}) {
  if (typeof receiptPath !== 'string' || receiptPath === '') {
    throw new CanaryFailure('runtime_component_receipt_required');
  }
  const absoluteReceipt = resolve(receiptPath);
  const receipt = JSON.parse(await readFile(absoluteReceipt, 'utf8'));
  if (receipt?.schemaVersion === 1 && Array.isArray(receipt?.packages)) {
    assertRuntimeComponentManifest(receipt);
    return Object.freeze({
      receiptKind: 'runtime-component',
      manifestPath: absoluteReceipt,
      sdkPackageRoot: join(dirname(absoluteReceipt), 'node_modules', '@openai', 'codex-sdk'),
    });
  }
  if (receipt?.schemaVersion !== 2 || typeof receipt?.executable?.path !== 'string') {
    throw new CanaryFailure('runtime_release_receipt_invalid');
  }
  if (typeof repositoryRoot !== 'string' || repositoryRoot === '') {
    throw new CanaryFailure('runtime_release_repository_root_required');
  }
  const absoluteRoot = resolve(repositoryRoot);
  const desktopExe = resolve(absoluteRoot, ...receipt.executable.path.replaceAll('\\', '/').split('/'));
  if (!insideRoot(absoluteRoot, desktopExe)) {
    throw new CanaryFailure('runtime_release_executable_outside_repository');
  }
  let verifiedReceipt;
  try {
    verifiedReceipt = releaseVerifier({
      repositoryRoot: absoluteRoot,
      attestationPath: absoluteReceipt,
      desktopExe,
    });
  } catch {
    throw new CanaryFailure('runtime_release_attestation_invalid');
  }
  const componentRecord = verifiedReceipt.codexRuntimeManifest;
  const manifestPath = resolve(absoluteRoot, ...componentRecord.path.replaceAll('\\', '/').split('/'));
  if (!insideRoot(absoluteRoot, manifestPath)) {
    throw new CanaryFailure('runtime_release_component_outside_repository');
  }
  const manifestBytes = await readFile(manifestPath);
  assertRuntimeComponentManifest(JSON.parse(manifestBytes.toString('utf8')));
  return Object.freeze({
    receiptKind: 'desktop-release-attestation',
    manifestPath,
    sdkPackageRoot: join(dirname(manifestPath), 'node_modules', '@openai', 'codex-sdk'),
  });
}

function crc32(input) {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

export function renderCodePng(code, { scale = 16, padding = 24 } = {}) {
  if (!/^\d{6}$/u.test(code)) throw new TypeError('code must contain exactly six digits');
  const glyphWidth = 5 * scale;
  const gap = scale;
  const width = padding * 2 + code.length * glyphWidth + (code.length - 1) * gap;
  const height = padding * 2 + 7 * scale;
  const stride = 1 + width * 3;
  const pixels = Buffer.alloc(stride * height, 0xff);
  for (let y = 0; y < height; y += 1) pixels[y * stride] = 0;
  [...code].forEach((digit, digitIndex) => {
    const glyph = DIGITS[digit];
    const xStart = padding + digitIndex * (glyphWidth + gap);
    glyph.forEach((row, glyphY) => {
      [...row].forEach((value, glyphX) => {
        if (value !== '1') return;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const x = xStart + glyphX * scale + dx;
            const y = padding + glyphY * scale + dy;
            const offset = y * stride + 1 + x * 3;
            pixels[offset] = 0;
            pixels[offset + 1] = 0;
            pixels[offset + 2] = 0;
          }
        }
      });
    });
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createTracker() {
  const terminals = new Map();
  const turnStartFrames = [];
  const waiters = new Set();
  const notify = () => {
    for (const waiter of [...waiters]) waiter();
  };
  return {
    observe(event) {
      if (event?.type === 'turn_completed' && event.turn_id) {
        terminals.set(event.turn_id, event.status ?? null);
      } else if (event?.type === 'provider_event'
        && event.provider_event?.direction === 'client_to_provider'
        && event.provider_event?.event_type === 'provider.command_requested'
        && event.provider_event?.source?.method === 'turn/start') {
        turnStartFrames.push(event.provider_event);
      }
      notify();
    },
    waitForTerminal(turnId, timeoutMs) {
      const current = () => terminals.get(turnId) ?? null;
      if (current() !== null) return Promise.resolve(current());
      return new Promise((resolvePromise, rejectPromise) => {
        let timeout;
        const check = () => {
          const value = current();
          if (value === null) return;
          clearTimeout(timeout);
          waiters.delete(check);
          resolvePromise(value);
        };
        waiters.add(check);
        timeout = setTimeout(() => {
          waiters.delete(check);
          rejectPromise(new CanaryFailure('attachment_turn_timeout'));
        }, timeoutMs);
        timeout.unref?.();
      });
    },
    hasTerminal(turnId) {
      return terminals.has(turnId);
    },
    turnStartFrames() {
      return [...turnStartFrames];
    },
  };
}

function finalAgentText(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const items = Array.isArray(turns.at(-1)?.items) ? turns.at(-1).items : [];
  const messages = items.filter((item) => item?.type === 'agentMessage');
  const value = messages.at(-1)?.text ?? messages.at(-1)?.content ?? null;
  return typeof value === 'string' ? value.trim() : null;
}

function randomCode() {
  return Array.from({ length: 6 }, () => String(randomInt(0, 10))).join('');
}

function dynamicToolDefinition() {
  return {
    type: 'function',
    name: TOOL_NAME,
    description: 'Read exactly one untrusted text attachment selected for this turn by its opaque capability.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['capability', 'cursor'],
      properties: {
        capability: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        cursor: { type: ['string', 'null'] },
      },
    },
  };
}

async function runTextResumeAttachmentCanary({
  adapterFactory,
  runtimeAttestor,
  runtimeReceiptKind,
  timeoutMs,
  now,
  temporaryDirectory,
}) {
  const startedAt = now();
  const marker = `ORQUESTA-TEXT-${randomBytes(12).toString('hex')}`;
  const capability = randomBytes(32).toString('hex');
  const physicalName = `${randomBytes(16).toString('hex')}.sealed`;
  const digestSentinel = createHash('sha256').update(marker).digest('hex');
  const secrets = [marker, capability, physicalName, digestSentinel, TEXT_PROMPT];
  let temporaryRoot = null;
  let projectRoot = null;
  let brokerRoot = null;
  let sourcePath = null;
  let firstAdapter = null;
  let secondAdapter = null;
  let firstSubscription = null;
  let secondSubscription = null;
  let threadId = null;
  let turnId = null;
  let runtimeAttestation = null;
  let appliedRuntimeProfileVerified = false;
  let firstProcessShutdown = false;
  let resumed = false;
  let providerTerminalStatus = null;
  let sourcePresentAfterTurnAccept = false;
  let sourcePresentAtTerminal = false;
  let sourcePresentThroughReadback = false;
  let sourceRemovedAfterTerminalReadback = false;
  let providerHistoryItemTypes = [];
  let providerHistoryDynamicToolItemCount = 0;
  let providerHistoryPrivateLeak = false;
  let exactMarkerRead = false;
  let toolArgumentsContainedPath = false;
  let dynamicToolCallCount = 0;
  let archived = false;
  let secondProcessShutdown = false;
  let cleanupConfirmed = false;
  let sourceAbsentBeforeArchive = false;
  let failureCode = null;
  const handlerDiagnostics = [];

  try {
    try {
      runtimeAttestation = await runtimeAttestor();
    } catch (error) {
      throw new CanaryFailure(error?.code ?? 'runtime_attestation_failed');
    }
    if (runtimeAttestation?.version !== PINNED_CODEX_VERSION
      || runtimeAttestation?.executableSha256Verified !== true
      || !/^[a-f0-9]{64}$/u.test(runtimeAttestation?.executableSha256 ?? '')) {
      throw new CanaryFailure('runtime_attestation_invalid');
    }

    temporaryRoot = await mkdtemp(join(resolve(temporaryDirectory), TEMPORARY_ROOT_PREFIX));
    temporaryRoot = resolvedDirectChild(temporaryDirectory, temporaryRoot).realCandidate;
    projectRoot = join(temporaryRoot, 'project');
    brokerRoot = join(temporaryRoot, 'sealed');
    await Promise.all([mkdir(projectRoot), mkdir(brokerRoot)]);
    sourcePath = join(brokerRoot, physicalName);
    secrets.push(temporaryRoot, projectRoot, brokerRoot, sourcePath);
    await writeFile(sourcePath, `${marker}\n`, { encoding: 'utf8', flag: 'wx' });

    const firstTracker = createTracker();
    firstAdapter = adapterFactory();
    firstSubscription = requiredResult('subscribe_events', await firstAdapter.subscribeEvents({
      correlationId: 'p2-006-live-text-resume:first-subscribe',
      listener: (event) => firstTracker.observe(event),
    })).subscription;
    const created = requiredResult('create_thread', await firstAdapter.createThread({
      correlationId: 'p2-006-live-text-resume:create',
      params: {
        cwd: projectRoot,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        dynamicTools: [dynamicToolDefinition()],
      },
    }));
    threadId = created.thread_id;
    secrets.push(threadId);
    appliedRuntimeProfileVerified = sameExistingDirectory(created.runtime_profile?.cwd, projectRoot)
      && created.runtime_profile?.sandbox === 'read-only'
      && created.runtime_profile?.approval_policy === 'never';
    if (!appliedRuntimeProfileVerified) throw new CanaryFailure('runtime_profile_mismatch');
    const priming = requiredResult('start_turn', await firstAdapter.startTurn({
      correlationId: 'p2-006-live-text-resume:prime',
      threadId,
      input: [{ type: 'text', text: 'Reply with exactly READY and nothing else.', text_elements: [] }],
    }));
    const primingStatus = await firstTracker.waitForTerminal(priming.turn_id, timeoutMs);
    if (primingStatus !== 'completed') throw new CanaryFailure('priming_turn_not_completed');
    firstSubscription?.unsubscribe?.();
    firstSubscription = null;
    requiredResult('first_adapter_shutdown', await firstAdapter.shutdown({
      correlationId: 'p2-006-live-text-resume:first-shutdown',
    }));
    firstProcessShutdown = true;

    const secondTracker = createTracker();
    secondAdapter = adapterFactory();
    secondSubscription = requiredResult('subscribe_events', await secondAdapter.subscribeEvents({
      correlationId: 'p2-006-live-text-resume:second-subscribe',
      listener: (event) => secondTracker.observe(event),
    })).subscription;
    const resumedThread = requiredResult('resume_thread', await secondAdapter.resumeThread({
      correlationId: 'p2-006-live-text-resume:resume',
      threadId,
    }));
    resumed = resumedThread.thread_id === threadId;
    if (!resumed) throw new CanaryFailure('thread_resume_identity_mismatch');
    const internalGuide = `${TEXT_PROMPT}\nAttachment: notes.txt\nCapability: ${capability}`;
    const turn = requiredResult('start_turn', await secondAdapter.startTurn({
      correlationId: 'p2-006-live-text-resume:turn',
      threadId,
      input: [{ type: 'text', text: internalGuide, text_elements: [] }],
      dynamicToolHandlerFactory: (scope) => {
        if (scope?.threadId !== threadId
          || scope?.correlationId !== 'p2-006-live-text-resume:turn'
          || typeof scope?.providerConnectionId !== 'string'
          || typeof scope?.turnId !== 'string') {
          throw new CanaryFailure('dynamic_tool_handler_scope_mismatch');
        }
        return {
          async handle(request) {
            try {
              const args = request?.arguments;
              if (request?.method !== 'item/tool/call'
                || request?.tool !== TOOL_NAME
                || !args
                || typeof args !== 'object'
                || Array.isArray(args)
                || Object.keys(args).length !== 2
                || args.capability !== capability
                || args.cursor !== null) {
                throw new CanaryFailure('dynamic_tool_argument_mismatch');
              }
              const serializedArgs = JSON.stringify(args);
              toolArgumentsContainedPath = [sourcePath, brokerRoot, physicalName, digestSentinel]
                .some((privateValue) => serializedArgs.includes(privateValue));
              if (toolArgumentsContainedPath) throw new CanaryFailure('dynamic_tool_path_disclosed');
              dynamicToolCallCount += 1;
              return {
                response: {
                  success: true,
                  contentItems: [{ type: 'inputText', text: await readFile(sourcePath, 'utf8') }],
                },
              };
            } catch (error) {
              handlerDiagnostics.push(error instanceof Error ? error.message : 'dynamic_tool_failure');
              throw error;
            }
          },
          expire() {},
        };
      },
    }));
    turnId = turn.turn_id;
    secrets.push(turnId);
    sourcePresentAfterTurnAccept = existsSync(sourcePath);
    if (!sourcePresentAfterTurnAccept) throw new CanaryFailure('attachment_source_missing_after_turn_accept');
    providerTerminalStatus = await secondTracker.waitForTerminal(turnId, timeoutMs);
    sourcePresentAtTerminal = existsSync(sourcePath);
    if (!sourcePresentAtTerminal) throw new CanaryFailure('attachment_source_missing_before_terminal_observation');
    if (providerTerminalStatus !== 'completed') throw new CanaryFailure('attachment_turn_not_completed');
    const read = requiredResult('read_thread', await secondAdapter.readThread({
      correlationId: 'p2-006-live-text-resume:read',
      threadId,
      includeTurns: true,
    }));
    sourcePresentThroughReadback = existsSync(sourcePath);
    if (!sourcePresentThroughReadback) throw new CanaryFailure('attachment_source_missing_before_readback_completed');
    exactMarkerRead = finalAgentText(read.thread) === marker;
    if (!exactMarkerRead) throw new CanaryFailure('dynamic_tool_marker_mismatch');
    if (dynamicToolCallCount !== 1) throw new CanaryFailure('dynamic_tool_call_count_mismatch');
    if (handlerDiagnostics.length !== 0) throw new CanaryFailure('dynamic_tool_diagnostics_present');
    const items = (Array.isArray(read.thread?.turns) ? read.thread.turns : [])
      .flatMap((candidateTurn) => Array.isArray(candidateTurn?.items) ? candidateTurn.items : []);
    providerHistoryItemTypes = items.map((item) => item?.type ?? null);
    const allowedItemTypes = new Set(['userMessage', 'reasoning', 'dynamicToolCall', 'agentMessage']);
    if (providerHistoryItemTypes.some((type) => !allowedItemTypes.has(type))) {
      throw new CanaryFailure('provider_history_disallowed_item');
    }
    providerHistoryDynamicToolItemCount = items.filter((item) => item?.type === 'dynamicToolCall').length;
    if (providerHistoryDynamicToolItemCount > 1) {
      throw new CanaryFailure('provider_history_dynamic_tool_count_invalid');
    }
    const serializedHistory = JSON.stringify(read.thread);
    providerHistoryPrivateLeak = [sourcePath, brokerRoot, physicalName, digestSentinel]
      .some((privateValue) => serializedHistory.includes(privateValue));
    if (providerHistoryPrivateLeak) throw new CanaryFailure('provider_history_private_value_leak');
    rmSync(sourcePath, { force: false });
    sourceRemovedAfterTerminalReadback = !existsSync(sourcePath);
    if (!sourceRemovedAfterTerminalReadback) {
      throw new CanaryFailure('attachment_source_remains_after_post_terminal_removal');
    }
  } catch (error) {
    failureCode = error instanceof CanaryFailure ? error.code : 'unexpected_failure';
  } finally {
    firstSubscription?.unsubscribe?.();
    secondSubscription?.unsubscribe?.();
    sourceAbsentBeforeArchive = !sourcePath || !existsSync(sourcePath);
    const archiveAdapter = secondAdapter ?? (firstProcessShutdown ? null : firstAdapter);
    if (archiveAdapter && threadId) {
      try {
        archived = requiredResult('archive_thread', await archiveAdapter.archiveThread({
          correlationId: 'p2-006-live-text-resume:archive', threadId,
        })).ok === true;
      } catch {
        if (!failureCode) failureCode = 'archive_thread_failed';
      }
    }
    if (secondAdapter) {
      try {
        requiredResult('second_adapter_shutdown', await secondAdapter.shutdown({
          correlationId: 'p2-006-live-text-resume:second-shutdown',
        }));
        secondProcessShutdown = true;
      } catch {
        if (!failureCode) failureCode = 'second_adapter_shutdown_failed';
      }
    }
    if (firstAdapter && !firstProcessShutdown) {
      try {
        requiredResult('first_adapter_shutdown', await firstAdapter.shutdown({
          correlationId: 'p2-006-live-text-resume:first-cleanup-shutdown',
        }));
        firstProcessShutdown = true;
      } catch {
        if (!failureCode) failureCode = 'first_adapter_shutdown_failed';
      }
    }
    if (temporaryRoot) {
      try {
        const bounded = resolvedDirectChild(temporaryDirectory, temporaryRoot).realCandidate;
        await rm(bounded, { recursive: true, force: false });
        cleanupConfirmed = !existsSync(bounded);
        if (!cleanupConfirmed && !failureCode) failureCode = 'temporary_root_cleanup_failed';
      } catch {
        if (!failureCode) failureCode = 'temporary_root_cleanup_failed';
      }
    }
  }

  const proof = {
    schema_version: 1,
    evidence_id: 'orquesta-p2-006-live-text-resume-sanitized-v1',
    status: failureCode === null ? 'passed' : 'failed',
    mode: 'text-resume',
    started_at: startedAt,
    finished_at: now(),
    pinned_runtime: {
      provider: 'codex_app_server',
      expected_version: PINNED_CODEX_VERSION,
      observed_version: runtimeAttestation?.version ?? null,
      executable_sha256: runtimeAttestation?.executableSha256 ?? null,
      executable_sha256_verified: runtimeAttestation?.executableSha256Verified === true,
      contract_ref: runtimeAttestation?.contractRef ?? null,
      receipt_kind: runtimeReceiptKind,
      sandbox: 'read-only',
      approval_policy: 'never',
      applied_profile_verified: appliedRuntimeProfileVerified,
    },
    attachment: {
      input_type: 'dynamicTool',
      generated_media_type: 'text/plain',
      first_process_shutdown: firstProcessShutdown,
      resumed_after_provider_restart: resumed,
      source_present_after_turn_accept: sourcePresentAfterTurnAccept,
      source_present_at_terminal: sourcePresentAtTerminal,
      source_present_through_readback: sourcePresentThroughReadback,
      source_removed_after_terminal_readback: sourceRemovedAfterTerminalReadback,
      provider_terminal: providerTerminalStatus !== null,
      provider_terminal_status: providerTerminalStatus,
      exact_marker_read: exactMarkerRead,
      dynamic_tool_call_count: dynamicToolCallCount,
      tool_arguments_contained_path: toolArgumentsContainedPath,
      provider_history_item_types: providerHistoryItemTypes,
      provider_history_dynamic_tool_item_count: providerHistoryDynamicToolItemCount,
      provider_history_private_leak: providerHistoryPrivateLeak,
    },
    cleanup: {
      disposable_threads_created: threadId ? 1 : 0,
      thread_archived: archived,
      first_process_shutdown: firstProcessShutdown,
      second_process_shutdown: secondProcessShutdown,
      source_absent_before_archive: sourceAbsentBeforeArchive,
      temporary_root_removed: cleanupConfirmed,
    },
    privacy: {
      raw_frames_persisted: false,
      prompt_or_answer_text_persisted: false,
      generated_marker_persisted: false,
      provider_identifiers_persisted: false,
      attachment_capability_persisted: false,
      local_paths_persisted: false,
      private_reasoning_persisted: false,
    },
    failure_code: failureCode,
    limits: {
      fake_fallback: false,
      arbitrary_file_attachment_proof_claimed: false,
      native_staging_cleanup_proof_claimed: false,
      real_window_proof_claimed: false,
      computer_use: false,
      browser_automation: false,
      product_activation: false,
    },
  };
  return assertSanitizedAttachmentProof(proof, secrets);
}

export async function runLiveAttachmentCanary({
  mode = 'image',
  adapterFactory = () => createAppServerAdapter({ sdkPackageRoot: BUNDLED_SDK_PACKAGE_ROOT }),
  runtimeAttestor = attestPinnedCodexRuntime,
  runtimeReceiptKind = 'injected-test-runtime',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => new Date().toISOString(),
  temporaryDirectory = tmpdir(),
  codeFactory = randomCode,
  sourceRemover = (path) => rmSync(path, { force: false }),
} = {}) {
  if (!CANARY_MODES.has(mode)) throw new TypeError(`unsupported attachment canary mode: ${mode}`);
  if (mode === 'text-resume') {
    return runTextResumeAttachmentCanary({
      adapterFactory,
      runtimeAttestor,
      runtimeReceiptKind,
      timeoutMs,
      now,
      temporaryDirectory,
    });
  }
  const startedAt = now();
  const code = codeFactory();
  if (!/^\d{6}$/u.test(code)) throw new TypeError('codeFactory must return exactly six digits');
  const tracker = createTracker();
  const secrets = [code, PROMPT, IMAGE_NAME];
  let temporaryRoot = null;
  let imagePath = null;
  let imageGenerated = false;
  let adapter = null;
  let subscription = null;
  let threadId = null;
  let turnId = null;
  let archived = false;
  let cleanupInterrupted = false;
  let cleanupConfirmed = false;
  let appliedRuntimeProfileVerified = false;
  let providerTerminalStatus = null;
  let turnStartFrames = 0;
  let turnStartFrameValidated = false;
  let exactOcrMatch = false;
  let sourcePresentAfterTurnAccept = false;
  let sourcePresentAtTerminal = false;
  let sourcePresentThroughReadback = false;
  let sourceRemovedAfterTerminalReadback = false;
  let sourceAbsentBeforeArchive = false;
  let failureCode = null;
  let runtimeAttestation = null;

  try {
    try {
      runtimeAttestation = await runtimeAttestor();
    } catch (error) {
      throw new CanaryFailure(error?.code ?? 'runtime_attestation_failed');
    }
    if (runtimeAttestation?.version !== PINNED_CODEX_VERSION
      || runtimeAttestation?.executableSha256Verified !== true
      || !/^[a-f0-9]{64}$/u.test(runtimeAttestation?.executableSha256 ?? '')) {
      throw new CanaryFailure('runtime_attestation_invalid');
    }
    temporaryRoot = await mkdtemp(join(resolve(temporaryDirectory), TEMPORARY_ROOT_PREFIX));
    temporaryRoot = resolvedDirectChild(temporaryDirectory, temporaryRoot).realCandidate;
    imagePath = join(temporaryRoot, IMAGE_NAME);
    secrets.push(temporaryRoot, imagePath);
    await writeFile(imagePath, renderCodePng(code), { flag: 'wx' });
    const image = await readFile(imagePath);
    imageGenerated = image.length > 32
      && image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!imageGenerated) throw new CanaryFailure('generated_png_invalid');

    adapter = adapterFactory();
    subscription = requiredResult('subscribe_events', await adapter.subscribeEvents({
      correlationId: 'p2-006-live-attachment:subscribe',
      listener: (event) => tracker.observe(event),
    })).subscription;
    const created = requiredResult('create_thread', await adapter.createThread({
      correlationId: 'p2-006-live-attachment:create',
      params: { cwd: temporaryRoot, sandbox: 'read-only', approvalPolicy: 'never' },
    }));
    threadId = created.thread_id;
    secrets.push(threadId);
    appliedRuntimeProfileVerified = sameExistingDirectory(created.runtime_profile?.cwd, temporaryRoot)
      && created.runtime_profile?.sandbox === 'read-only'
      && created.runtime_profile?.approval_policy === 'never';
    if (!appliedRuntimeProfileVerified) throw new CanaryFailure('runtime_profile_mismatch');

    const turn = requiredResult('start_turn', await adapter.startTurn({
      correlationId: 'p2-006-live-attachment:turn',
      threadId,
      input: [
        { type: 'text', text: PROMPT, text_elements: [] },
        { type: 'localImage', path: imagePath },
      ],
    }));
    turnId = turn.turn_id;
    secrets.push(turnId);
    sourcePresentAfterTurnAccept = existsSync(imagePath);
    if (!sourcePresentAfterTurnAccept) throw new CanaryFailure('attachment_source_missing_after_turn_accept');
    providerTerminalStatus = await tracker.waitForTerminal(turnId, timeoutMs);
    sourcePresentAtTerminal = existsSync(imagePath);
    if (!sourcePresentAtTerminal) throw new CanaryFailure('attachment_source_missing_before_terminal_observation');
    const frames = tracker.turnStartFrames();
    turnStartFrames = frames.length;
    turnStartFrameValidated = frames.length === 1
      && frames[0]?.source?.has_request_id === true
      && /^[a-f0-9]{64}$/u.test(frames[0]?.source?.frame_sha256 ?? '');
    if (!turnStartFrameValidated) throw new CanaryFailure('turn_start_frame_count_mismatch');
    if (providerTerminalStatus !== 'completed') {
      throw new CanaryFailure('attachment_turn_not_completed');
    }
    const read = requiredResult('read_thread', await adapter.readThread({
      correlationId: 'p2-006-live-attachment:read',
      threadId,
      includeTurns: true,
    }));
    const answer = finalAgentText(read.thread);
    if (answer) secrets.push(answer);
    sourcePresentThroughReadback = existsSync(imagePath);
    if (!sourcePresentThroughReadback) throw new CanaryFailure('attachment_source_missing_before_readback_completed');
    exactOcrMatch = answer === code;
    if (!exactOcrMatch) throw new CanaryFailure('attachment_ocr_mismatch');
    sourceRemover(imagePath);
    sourceRemovedAfterTerminalReadback = !existsSync(imagePath);
    if (!sourceRemovedAfterTerminalReadback) {
      throw new CanaryFailure('attachment_source_remains_after_post_terminal_removal');
    }
  } catch (error) {
    failureCode = error instanceof CanaryFailure ? error.code : 'unexpected_failure';
  } finally {
    subscription?.unsubscribe?.();
    if (adapter && threadId && turnId && providerTerminalStatus === null) {
      try {
        cleanupInterrupted = (await adapter.interruptTurn({
          correlationId: 'p2-006-live-attachment:cleanup-interrupt', threadId, turnId,
        }))?.ok === true;
      } catch {
        cleanupInterrupted = false;
      }
    }
    sourceAbsentBeforeArchive = !imagePath || !existsSync(imagePath);
    if (!sourceAbsentBeforeArchive && !failureCode) {
      failureCode = 'attachment_source_cleanup_before_archive_failed';
    }
    if (adapter && threadId) {
      try {
        archived = requiredResult('archive_thread', await adapter.archiveThread({
          correlationId: 'p2-006-live-attachment:archive', threadId,
        })).ok === true;
        if (!archived && !failureCode) failureCode = 'archive_thread_failed';
      } catch {
        if (!failureCode) failureCode = 'archive_thread_failed';
      }
    }
    if (adapter) {
      try {
        requiredResult('adapter_shutdown', await adapter.shutdown({
          correlationId: 'p2-006-live-attachment:shutdown',
        }));
      } catch {
        if (!failureCode) failureCode = 'adapter_shutdown_failed';
      }
    }
    if (temporaryRoot) {
      try {
        const bounded = resolvedDirectChild(temporaryDirectory, temporaryRoot).realCandidate;
        await rm(bounded, { recursive: true, force: false });
        cleanupConfirmed = !existsSync(bounded);
        if (!cleanupConfirmed && !failureCode) failureCode = 'temporary_root_cleanup_failed';
      } catch {
        if (!failureCode) failureCode = 'temporary_root_cleanup_failed';
      }
    }
  }

  const proof = {
    schema_version: 1,
    evidence_id: 'orquesta-p2-006-live-attachment-sanitized-v1',
    status: failureCode === null ? 'passed' : 'failed',
    mode: 'image',
    started_at: startedAt,
    finished_at: now(),
    pinned_runtime: {
      provider: 'codex_app_server',
      expected_version: PINNED_CODEX_VERSION,
      observed_version: runtimeAttestation?.version ?? null,
      executable_sha256: runtimeAttestation?.executableSha256 ?? null,
      executable_sha256_verified: runtimeAttestation?.executableSha256Verified === true,
      contract_ref: runtimeAttestation?.contractRef ?? null,
      receipt_kind: runtimeReceiptKind,
      sandbox: 'read-only',
      approval_policy: 'never',
      applied_profile_verified: appliedRuntimeProfileVerified,
    },
    attachment: {
      input_type: 'localImage',
      generated_media_type: 'image/png',
      generated_in_disposable_root: imageGenerated,
      source_present_after_turn_accept: sourcePresentAfterTurnAccept,
      source_present_at_terminal: sourcePresentAtTerminal,
      source_present_through_readback: sourcePresentThroughReadback,
      source_removed_after_terminal_readback: sourceRemovedAfterTerminalReadback,
      turn_start_provider_frames: turnStartFrames,
      turn_start_frame_validated: turnStartFrameValidated,
      provider_terminal: providerTerminalStatus !== null,
      provider_terminal_status: providerTerminalStatus,
      visual_ocr_exact_match: exactOcrMatch,
    },
    cleanup: {
      disposable_threads_created: threadId ? 1 : 0,
      thread_archived: archived,
      cleanup_interrupt_requested: cleanupInterrupted,
      source_absent_before_archive: sourceAbsentBeforeArchive,
      temporary_root_removed: cleanupConfirmed,
    },
    privacy: {
      raw_frames_persisted: false,
      prompt_or_answer_text_persisted: false,
      generated_code_persisted: false,
      generated_image_persisted: false,
      provider_identifiers_persisted: false,
      model_labels_persisted: false,
      local_paths_persisted: false,
      private_reasoning_persisted: false,
    },
    failure_code: failureCode,
    limits: {
      fake_fallback: false,
      arbitrary_file_attachment_proof_claimed: false,
      native_staging_cleanup_proof_claimed: false,
      real_window_proof_claimed: false,
      computer_use: false,
      browser_automation: false,
      product_activation: false,
    },
  };
  return assertSanitizedAttachmentProof(proof, secrets);
}

function parseArgs(argv) {
  const args = { output: null, mode: null, runtimeReceipt: null, repositoryRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (typeof next !== 'string' || next === '' || next.startsWith('--')) {
        throw new TypeError(`missing value for ${arg}`);
      }
      return next;
    };
    if (arg === '--output') args.output = value();
    else if (arg === '--mode') args.mode = value();
    else if (arg === '--runtime-receipt') args.runtimeReceipt = value();
    else if (arg === '--repository-root') args.repositoryRoot = value();
    else throw new TypeError(`unknown argument: ${arg}`);
  }
  if (!CANARY_MODES.has(args.mode)) {
    throw new TypeError('--mode must be image or text-resume');
  }
  if (!args.runtimeReceipt) throw new TypeError('--runtime-receipt is required');
  return args;
}

async function main() {
  if (!['1', 'true'].includes(String(process.env[LIVE_FLAG] ?? '').toLowerCase())) {
    throw new CanaryFailure('live_attachment_canary_flag_required');
  }
  const args = parseArgs(process.argv.slice(2));
  const runtimeComponent = await resolveRuntimeComponentReceipt({
    receiptPath: args.runtimeReceipt,
    repositoryRoot: args.repositoryRoot,
  });
  const proof = await runLiveAttachmentCanary({
    mode: args.mode,
    runtimeReceiptKind: runtimeComponent.receiptKind,
    adapterFactory: () => createAppServerAdapter({ sdkPackageRoot: runtimeComponent.sdkPackageRoot }),
    runtimeAttestor: () => attestPinnedCodexRuntime({
      sdkPackageRoot: runtimeComponent.sdkPackageRoot,
      manifestPath: runtimeComponent.manifestPath,
    }),
  });
  const rendered = `${JSON.stringify(proof, null, 2)}\n`;
  if (args.output) {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(dirname(resolve(args.output)), { recursive: true });
    writeFileSync(resolve(args.output), rendered, 'utf8');
  } else {
    process.stdout.write(rendered);
  }
  if (proof.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof CanaryFailure ? error.code : 'unexpected_failure'}\n`);
    process.exitCode = 1;
  });
}

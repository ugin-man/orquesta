import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  PROJECT_STORAGE,
  canonicalProjectRoot,
  ensureProjectStorageDirectory
} from './project-storage-layout';

const MAX_STATE_BYTES = 4 * 1_048_576;
const MAX_RESULT_BYTES = 1_048_576;
const MAX_DEFINITIONS = 100;
const MAX_ATTEMPTS = 50;
const SAFE_ID = /^[a-zA-Z0-9._:-]{1,128}$/u;

export type WorkflowCheck = {
  kind: 'contains' | 'not_contains';
  text: string;
  caseSensitive: boolean;
};

export interface WorkflowDefinition {
  workflowId: string;
  name: string;
  prompt: string;
  checks: WorkflowCheck[];
  createdAt: string;
  updatedAt: string;
}

export type WorkflowAttemptStatus = 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowAttemptRecord {
  attemptId: string;
  ordinal: number;
  status: WorkflowAttemptStatus;
  threadId: string | null;
  turnId: string | null;
  resultPath: string | null;
  resultPreview: string | null;
  checkOutcome: 'passed' | 'failed' | 'unassessed' | null;
  failedCheckIndexes: number[];
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
}

export type WorkflowBatchStatus = 'queued' | 'running' | 'cancelling' | 'completed' | 'partial' | 'failed' | 'cancelled';

export interface WorkflowBatchRecord {
  batchId: string;
  workflowId: string;
  definitionSnapshot: WorkflowDefinition;
  requestedRuns: number;
  status: WorkflowBatchStatus;
  attempts: WorkflowAttemptRecord[];
  createdAt: string;
  completedAt: string | null;
}

export interface WorkflowStateFile {
  version: 1;
  definitions: WorkflowDefinition[];
  batches: WorkflowBatchRecord[];
}

export interface WorkflowBatchMetrics {
  requestedRuns: number;
  terminalRuns: number;
  completedRuns: number;
  failedRuns: number;
  cancelledRuns: number;
  assessedRuns: number;
  passedRuns: number;
  executionReliabilityPercent: number;
  successRatePercent: number | null;
  outcomeConsistencyPercent: number | null;
  medianDurationMs: number | null;
}

export interface WorkflowCatalog {
  version: 1;
  definitions: WorkflowDefinition[];
  batches: Array<WorkflowBatchRecord & { metrics: WorkflowBatchMetrics }>;
  limits: { maxAttemptsPerBatch: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isNullableText(value: unknown, maximum: number): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= maximum);
}

function isCheck(value: unknown): value is WorkflowCheck {
  return isRecord(value)
    && (value.kind === 'contains' || value.kind === 'not_contains')
    && typeof value.text === 'string' && value.text.trim().length > 0 && value.text.length <= 1_024
    && typeof value.caseSensitive === 'boolean';
}

function isDefinition(value: unknown): value is WorkflowDefinition {
  return isRecord(value)
    && typeof value.workflowId === 'string' && SAFE_ID.test(value.workflowId)
    && typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 256
    && typeof value.prompt === 'string' && value.prompt.trim().length > 0 && value.prompt.length <= 65_536
    && Array.isArray(value.checks) && value.checks.length <= 16 && value.checks.every(isCheck)
    && isIso(value.createdAt) && isIso(value.updatedAt);
}

function isAttempt(value: unknown): value is WorkflowAttemptRecord {
  if (!isRecord(value)) return false;
  return typeof value.attemptId === 'string' && SAFE_ID.test(value.attemptId)
    && Number.isInteger(value.ordinal) && Number(value.ordinal) >= 1 && Number(value.ordinal) <= MAX_ATTEMPTS
    && ['queued', 'starting', 'running', 'completed', 'failed', 'cancelled'].includes(String(value.status))
    && isNullableText(value.threadId, 128) && isNullableText(value.turnId, 128)
    && isNullableText(value.resultPath, 32_768) && isNullableText(value.resultPreview, 1_024)
    && (value.checkOutcome === null || ['passed', 'failed', 'unassessed'].includes(String(value.checkOutcome)))
    && Array.isArray(value.failedCheckIndexes) && value.failedCheckIndexes.length <= 16
    && value.failedCheckIndexes.every((index) => Number.isInteger(index) && Number(index) >= 0 && Number(index) < 16)
    && isNullableText(value.errorCode, 128) && isNullableText(value.errorMessage, 4_096)
    && isIso(value.createdAt)
    && (value.startedAt === null || isIso(value.startedAt))
    && (value.completedAt === null || isIso(value.completedAt))
    && (value.durationMs === null || (Number.isFinite(value.durationMs) && Number(value.durationMs) >= 0));
}

function isBatch(value: unknown): value is WorkflowBatchRecord {
  if (!isRecord(value)) return false;
  if (typeof value.batchId !== 'string' || !SAFE_ID.test(value.batchId)
    || typeof value.workflowId !== 'string' || !SAFE_ID.test(value.workflowId)
    || !isDefinition(value.definitionSnapshot)
    || !Number.isInteger(value.requestedRuns) || Number(value.requestedRuns) < 1 || Number(value.requestedRuns) > MAX_ATTEMPTS
    || !['queued', 'running', 'cancelling', 'completed', 'partial', 'failed', 'cancelled'].includes(String(value.status))
    || !Array.isArray(value.attempts) || value.attempts.length !== value.requestedRuns || !value.attempts.every(isAttempt)
    || !isIso(value.createdAt) || (value.completedAt !== null && !isIso(value.completedAt))) return false;
  const attemptIds = new Set(value.attempts.map((attempt) => attempt.attemptId));
  const ordinals = new Set(value.attempts.map((attempt) => attempt.ordinal));
  return attemptIds.size === value.attempts.length && ordinals.size === value.attempts.length
    && value.workflowId === value.definitionSnapshot.workflowId;
}

export function parseWorkflowState(value: unknown): WorkflowStateFile {
  if (!isRecord(value) || value.version !== 1
    || !Array.isArray(value.definitions) || value.definitions.length > MAX_DEFINITIONS || !value.definitions.every(isDefinition)
    || !Array.isArray(value.batches) || !value.batches.every(isBatch)) {
    throw new Error('workflow state has an invalid versioned shape');
  }
  if (new Set(value.definitions.map((item) => item.workflowId)).size !== value.definitions.length) {
    throw new Error('workflow state contains duplicate definition ids');
  }
  if (new Set(value.batches.map((item) => item.batchId)).size !== value.batches.length) {
    throw new Error('workflow state contains duplicate batch ids');
  }
  return structuredClone(value as unknown as WorkflowStateFile);
}

function assertConfined(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('workflow path escapes selected project');
}

async function workflowDirectory(rootPath: string): Promise<{ root: string; directory: string }> {
  const root = await canonicalProjectRoot(rootPath);
  const directory = await ensureProjectStorageDirectory(root, PROJECT_STORAGE.workflowRoot);
  const resolved = await realpath(directory);
  assertConfined(root, resolved);
  return { root, directory: resolved };
}

async function statePath(rootPath: string): Promise<string> {
  return path.join((await workflowDirectory(rootPath)).directory, 'state.json');
}

async function workflowResultDirectory(rootPath: string, batchId: string): Promise<string> {
  if (!SAFE_ID.test(batchId)) throw new Error('workflow result identity is invalid');
  const { root, directory } = await workflowDirectory(rootPath);
  const results = path.join(directory, 'results');
  await mkdir(results, { recursive: true });
  const resolvedResults = await realpath(results);
  assertConfined(root, resolvedResults);
  const batch = path.join(resolvedResults, workflowBatchDirectoryName(batchId));
  await mkdir(batch, { recursive: true });
  const resolved = await realpath(batch);
  assertConfined(root, resolved);
  return resolved;
}

function workflowResultFilename(attemptId: string): string {
  return `attempt-${createHash('sha256').update(attemptId, 'utf8').digest('hex')}.md`;
}

function workflowBatchDirectoryName(batchId: string): string {
  return `batch-${createHash('sha256').update(batchId, 'utf8').digest('hex')}`;
}

export async function workflowResultPath(rootPath: string, batchId: string, attemptId: string): Promise<string> {
  if (!SAFE_ID.test(attemptId)) throw new Error('workflow result identity is invalid');
  return path.join(await workflowResultDirectory(rootPath, batchId), workflowResultFilename(attemptId));
}

export async function readWorkflowState(rootPath: string): Promise<WorkflowStateFile> {
  const filename = await statePath(rootPath);
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.size > MAX_STATE_BYTES) throw new Error('workflow state exceeds the supported size');
    const state = parseWorkflowState(JSON.parse(await readFile(filename, 'utf8')));
    for (const batch of state.batches) {
      for (const attempt of batch.attempts) {
        if (attempt.resultPath) {
          attempt.resultPath = path.join(
            path.dirname(filename),
            'results',
            workflowBatchDirectoryName(batch.batchId),
            workflowResultFilename(attempt.attemptId)
          );
        }
      }
    }
    return state;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { version: 1, definitions: [], batches: [] };
    throw error;
  }
}

export async function writeWorkflowState(rootPath: string, state: WorkflowStateFile): Promise<void> {
  const validated = parseWorkflowState(state);
  const filename = await statePath(rootPath);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const source = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(source, 'utf8') > MAX_STATE_BYTES) throw new Error('workflow state exceeds the supported size');
  try {
    await writeFile(temporary, source, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, filename);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function writeWorkflowResult(rootPath: string, batchId: string, attemptId: string, output: string): Promise<string> {
  if (!output.trim()) throw new Error('workflow completed without a result');
  if (Buffer.byteLength(output, 'utf8') > MAX_RESULT_BYTES) throw new Error('workflow result exceeds the supported size');
  const filename = await workflowResultPath(rootPath, batchId, attemptId);
  const source = output.endsWith('\n') ? output : `${output}\n`;
  try {
    await writeFile(filename, source, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (await readWorkflowResult(rootPath, batchId, attemptId) !== source) {
      throw new Error('existing workflow result differs from the recovered result');
    }
  }
  return filename;
}

export async function readWorkflowResult(rootPath: string, batchId: string, attemptId: string): Promise<string> {
  const { directory } = await workflowDirectory(rootPath);
  const current = path.join(directory, 'results', workflowBatchDirectoryName(batchId), workflowResultFilename(attemptId));
  const legacy = path.join(directory, 'results', batchId, `${attemptId}.md`);
  let handle;
  try {
    handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    handle = await open(legacy, constants.O_RDONLY | constants.O_NOFOLLOW);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_RESULT_BYTES) throw new Error('workflow result exceeds the supported size');
    return handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function percentage(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 100;
}

export function summarizeWorkflowBatch(batch: WorkflowBatchRecord): WorkflowBatchMetrics {
  const terminal = batch.attempts.filter((attempt) => ['completed', 'failed', 'cancelled'].includes(attempt.status));
  const completed = terminal.filter((attempt) => attempt.status === 'completed');
  const failed = terminal.filter((attempt) => attempt.status === 'failed');
  const cancelled = terminal.filter((attempt) => attempt.status === 'cancelled');
  const assessed = completed.filter((attempt) => attempt.checkOutcome === 'passed' || attempt.checkOutcome === 'failed');
  const passed = assessed.filter((attempt) => attempt.checkOutcome === 'passed');
  const durations = completed.flatMap((attempt) => attempt.durationMs === null ? [] : [attempt.durationMs]).sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const medianDurationMs = durations.length === 0 ? null
    : durations.length % 2 === 1 ? durations[middle] : Math.round((durations[middle - 1] + durations[middle]) / 2);
  return {
    requestedRuns: batch.requestedRuns,
    terminalRuns: terminal.length,
    completedRuns: completed.length,
    failedRuns: failed.length,
    cancelledRuns: cancelled.length,
    assessedRuns: assessed.length,
    passedRuns: passed.length,
    executionReliabilityPercent: percentage(completed.length, batch.requestedRuns),
    successRatePercent: assessed.length === 0 ? null : percentage(passed.length, assessed.length),
    outcomeConsistencyPercent: assessed.length === 0 ? null : percentage(Math.max(passed.length, assessed.length - passed.length), assessed.length),
    medianDurationMs
  };
}

export async function readWorkflowCatalog(rootPath: string): Promise<WorkflowCatalog> {
  const state = await readWorkflowState(rootPath);
  return {
    version: 1,
    definitions: state.definitions.map((definition) => structuredClone(definition)),
    batches: state.batches.slice(-50).reverse().map((batch) => ({
      ...structuredClone(batch),
      metrics: summarizeWorkflowBatch(batch)
    })),
    limits: { maxAttemptsPerBatch: MAX_ATTEMPTS }
  };
}

export const WORKFLOW_LIMITS = Object.freeze({ maxAttemptsPerBatch: MAX_ATTEMPTS });

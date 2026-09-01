import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InspectionKind, InspectionRunStatus, InspectionTargetUi } from '../contracts/orquesta-ui';
import {
  PROJECT_STORAGE,
  canonicalProjectRoot,
  ensureProjectStorageDirectory,
  projectStoragePath
} from './project-storage-layout';

const MAX_STATE_BYTES = 1_048_576;
const MAX_RUNS = 500;
const SAFE_ID = /^[a-zA-Z0-9._:-]{1,128}$/u;
const ACTIVE_STATUSES = new Set<InspectionRunStatus>(['queued', 'running', 'cancelling']);
const FINISHED_STATUSES = new Set<InspectionRunStatus>(['report_ready', 'partial', 'failed', 'cancelled', 'closed']);
const ALL_STATUSES = new Set<InspectionRunStatus>([...ACTIVE_STATUSES, ...FINISHED_STATUSES]);

export interface InspectionRuntimeBoundary {
  sandbox: 'read-only';
  approvalPolicy: 'never';
  webSearchMode: 'live' | 'disabled';
}

export interface InspectionRunRecord {
  runId: string;
  kind: InspectionKind;
  requestedBy: 'user';
  target: { kind: InspectionTargetUi['kind']; ids: string[] };
  focus: string | null;
  status: InspectionRunStatus;
  threadId: string | null;
  turnId: string | null;
  reportPath: string | null;
  sourceCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  runtimeBoundary: InspectionRuntimeBoundary | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  closedAt: string | null;
}

export interface InspectionStateFile {
  version: 1;
  runs: InspectionRunRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNullableText(value: unknown, maximum = 32_768): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= maximum);
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isTarget(value: unknown): value is InspectionRunRecord['target'] {
  if (!isRecord(value) || !['project', 'line', 'team', 'agents'].includes(String(value.kind))) return false;
  return Array.isArray(value.ids) && value.ids.length <= 32 && value.ids.every((id) => typeof id === 'string' && SAFE_ID.test(id));
}

function isBoundary(value: unknown): value is InspectionRuntimeBoundary | null {
  if (value === null) return true;
  return isRecord(value)
    && value.sandbox === 'read-only'
    && value.approvalPolicy === 'never'
    && ['live', 'disabled'].includes(String(value.webSearchMode));
}

function isRun(value: unknown): value is InspectionRunRecord {
  if (!isRecord(value)) return false;
  return typeof value.runId === 'string' && SAFE_ID.test(value.runId)
    && ['external_benchmark', 'adversarial_audit'].includes(String(value.kind))
    && value.requestedBy === 'user'
    && isTarget(value.target)
    && isNullableText(value.focus, 4_096)
    && ALL_STATUSES.has(value.status as InspectionRunStatus)
    && isNullableText(value.threadId, 128)
    && isNullableText(value.turnId, 128)
    && isNullableText(value.reportPath)
    && typeof value.sourceCount === 'number' && Number.isInteger(value.sourceCount) && value.sourceCount >= 0
    && isNullableText(value.errorCode, 128)
    && isNullableText(value.errorMessage, 4_096)
    && isBoundary(value.runtimeBoundary)
    && isIso(value.createdAt)
    && (value.startedAt === null || isIso(value.startedAt))
    && (value.completedAt === null || isIso(value.completedAt))
    && (value.closedAt === null || isIso(value.closedAt));
}

export function parseInspectionState(value: unknown): InspectionStateFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.runs) || value.runs.length > MAX_RUNS) {
    throw new Error('inspection-runs.json has an invalid versioned shape');
  }
  if (!value.runs.every(isRun)) throw new Error('inspection-runs.json contains an invalid run');
  const ids = new Set(value.runs.map((run) => run.runId));
  if (ids.size !== value.runs.length) throw new Error('inspection-runs.json contains duplicate run ids');
  return structuredClone(value as unknown as InspectionStateFile);
}

async function projectRoot(rootPath: string): Promise<string> {
  return canonicalProjectRoot(rootPath);
}

function assertConfined(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('inspection path escapes selected project');
}

async function prepareInspectionStorage(rootPath: string): Promise<{ root: string; state: string; results: string }> {
  const root = await projectRoot(rootPath);
  const results = await ensureProjectStorageDirectory(root, PROJECT_STORAGE.inspectionResults);
  const state = projectStoragePath(root, PROJECT_STORAGE.inspectionState);
  return { root, state, results };
}

async function statePath(rootPath: string): Promise<string> {
  return (await prepareInspectionStorage(rootPath)).state;
}

export async function inspectionReportPath(rootPath: string, runId: string): Promise<string> {
  if (!SAFE_ID.test(runId)) throw new Error('Inspection run id is invalid');
  const { root, results } = await prepareInspectionStorage(rootPath);
  assertConfined(root, results);
  return path.join(results, `${runId}.md`);
}

export async function readInspectionState(rootPath: string): Promise<InspectionStateFile> {
  const filename = await statePath(rootPath);
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.size > MAX_STATE_BYTES) throw new Error('inspection-runs.json exceeds the supported size');
    const state = parseInspectionState(JSON.parse(await readFile(filename, 'utf8')));
    const results = projectStoragePath(await projectRoot(rootPath), PROJECT_STORAGE.inspectionResults);
    for (const run of state.runs) {
      if (run.reportPath) run.reportPath = path.join(results, `${run.runId}.md`);
    }
    return state;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { version: 1, runs: [] };
    throw error;
  }
}

export async function writeInspectionState(rootPath: string, state: InspectionStateFile): Promise<void> {
  const validated = parseInspectionState(state);
  const filename = await statePath(rootPath);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const source = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(source, 'utf8') > MAX_STATE_BYTES) throw new Error('inspection-runs.json exceeds the supported size');
  try {
    await writeFile(temporary, source, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, filename);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

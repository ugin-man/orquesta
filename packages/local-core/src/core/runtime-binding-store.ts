import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeLaunchContext } from './protocol';
import {
  PROJECT_STORAGE,
  projectStorageFileBoundary
} from './project-storage-layout';

export type RuntimeMode = 'codex_hosted' | 'standalone' | 'migrating';
export type RuntimeTransport = 'codex_shared_app_server' | 'app_server';

export interface RuntimeBinding {
  schema_version: 1;
  project_id: string;
  project_root_fingerprint: string;
  mode: Exclude<RuntimeMode, 'migrating'>;
  runtime_authority_id: string;
  transport: RuntimeTransport;
  calling_thread_id: string | null;
  established_at: string;
  verified_at: string;
  migration: null;
}

export interface RuntimeBindingEvidence {
  binding: RuntimeBinding;
  filePath: string;
  sha256: string;
}

export interface EstablishRuntimeBindingInput {
  rootPath: string;
  projectId: string;
  launchContext: RuntimeLaunchContext;
  allowLegacyProjectIdAdoption?: boolean;
  now?: () => Date;
  authorityId?: () => string;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function safeId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 256 ? trimmed : null;
}

function safeIso(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

function normalizeRoot(value: string): string {
  const resolved = path.resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function hashRootSpelling(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function legacyRootFingerprints(canonicalRoot: string): ReadonlySet<string> {
  const historicalSpelling = path.resolve(canonicalRoot).replaceAll('\\', '/');
  return new Set([
    hashRootSpelling(historicalSpelling),
    hashRootSpelling(normalizeRoot(canonicalRoot))
  ]);
}

function isLegacyRootFingerprint(canonicalRoot: string, fingerprint: string): boolean {
  return legacyRootFingerprints(canonicalRoot).has(fingerprint);
}

async function fingerprintRoot(canonicalRoot: string): Promise<string> {
  const metadata = await stat(canonicalRoot, { bigint: true });
  return createHash('sha256')
    .update(`${process.platform}\0${metadata.dev}\0${metadata.ino}`, 'utf8')
    .digest('hex');
}

async function bindingPath(canonicalRoot: string, createParent = false): Promise<string> {
  const boundary = await projectStorageFileBoundary(
    canonicalRoot,
    PROJECT_STORAGE.runtimeBinding,
    { createParent }
  );
  return boundary.filePath;
}

function parseBinding(value: unknown): RuntimeBinding {
  const item = record(value);
  const projectId = safeId(item?.project_id);
  const rootFingerprint = typeof item?.project_root_fingerprint === 'string'
    && /^[a-f0-9]{64}$/u.test(item.project_root_fingerprint)
    ? item.project_root_fingerprint
    : null;
  const authorityId = safeId(item?.runtime_authority_id);
  const callingThreadId = item?.calling_thread_id === null ? null : safeId(item?.calling_thread_id);
  const establishedAt = safeIso(item?.established_at);
  const verifiedAt = safeIso(item?.verified_at);
  const mode = item?.mode;
  const transport = item?.transport;
  if (item?.schema_version !== 1
    || !projectId
    || !rootFingerprint
    || !authorityId
    || !establishedAt
    || !verifiedAt
    || !['codex_hosted', 'standalone'].includes(String(mode))
    || !['codex_shared_app_server', 'app_server'].includes(String(transport))
    || (mode === 'codex_hosted' && !callingThreadId)
    || (mode === 'standalone' && callingThreadId !== null)
    || item?.migration !== null) {
    throw new Error('Runtime binding is invalid');
  }
  return {
    schema_version: 1,
    project_id: projectId,
    project_root_fingerprint: rootFingerprint,
    mode: mode as RuntimeBinding['mode'],
    runtime_authority_id: authorityId,
    transport: transport as RuntimeTransport,
    calling_thread_id: callingThreadId,
    established_at: establishedAt,
    verified_at: verifiedAt,
    migration: null
  };
}

async function writeBinding(canonicalRoot: string, binding: RuntimeBinding): Promise<void> {
  const destination = await bindingPath(canonicalRoot, true);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(binding, null, 2)}\n`, 'utf8');
  await rename(temporary, destination);
}

export async function readRuntimeBinding(rootPath: string): Promise<RuntimeBinding | null> {
  const evidence = await readRuntimeBindingEvidence(rootPath);
  return evidence?.binding ?? null;
}

export async function readRuntimeBindingEvidence(rootPath: string): Promise<RuntimeBindingEvidence | null> {
  const canonicalRoot = await realpath(rootPath);
  try {
    const evidence = await readStoredBindingEvidence(canonicalRoot);
    const binding = evidence.binding;
    const currentFingerprint = await fingerprintRoot(canonicalRoot);
    if (binding.project_root_fingerprint !== currentFingerprint
      && !isLegacyRootFingerprint(canonicalRoot, binding.project_root_fingerprint)) {
      throw new Error('runtime_binding_project_mismatch');
    }
    return evidence;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readStoredBindingEvidence(canonicalRoot: string): Promise<RuntimeBindingEvidence> {
  const filePath = await bindingPath(canonicalRoot);
  const bytes = await readFile(filePath);
  return {
    binding: parseBinding(JSON.parse(bytes.toString('utf8'))),
    filePath,
    sha256: createHash('sha256').update(bytes).digest('hex')
  };
}

export async function establishRuntimeBinding(input: EstablishRuntimeBindingInput): Promise<RuntimeBinding> {
  const canonicalRoot = await realpath(input.rootPath);
  const projectId = safeId(input.projectId);
  if (!projectId) throw new Error('Runtime binding requires a project id');
  const rootFingerprint = await fingerprintRoot(canonicalRoot);
  const callingThreadId = input.launchContext.callingThreadId?.trim() || null;
  const mode: RuntimeBinding['mode'] = callingThreadId ? 'codex_hosted' : 'standalone';
  const transport: RuntimeTransport = callingThreadId ? 'codex_shared_app_server' : 'app_server';
  const now = (input.now ?? (() => new Date()))().toISOString();
  const existing = await readRuntimeBinding(canonicalRoot);
  if (existing) {
    const isStableBinding = existing.project_root_fingerprint === rootFingerprint;
    const isLegacySpellingBinding = isLegacyRootFingerprint(
      canonicalRoot,
      existing.project_root_fingerprint
    );
    if (!isStableBinding && !isLegacySpellingBinding) {
      throw new Error('runtime_binding_project_mismatch');
    }
    const legacyProjectIdMayBeAdopted = input.allowLegacyProjectIdAdoption === true
      && isLegacySpellingBinding;
    if (existing.project_id !== projectId && !legacyProjectIdMayBeAdopted) {
      throw new Error('runtime_binding_project_mismatch');
    }
    if (existing.mode !== mode || existing.transport !== transport) {
      throw new Error('runtime_mode_change_requires_explicit_migration');
    }
    if (existing.calling_thread_id !== callingThreadId) {
      throw new Error('runtime_authority_conflict');
    }
    const verified = {
      ...existing,
      project_id: projectId,
      project_root_fingerprint: rootFingerprint,
      verified_at: now
    };
    await writeBinding(canonicalRoot, verified);
    const evidence = await readRuntimeBindingEvidence(canonicalRoot);
    if (!evidence) throw new Error('runtime_binding_missing_after_write');
    return evidence.binding;
  }
  const binding: RuntimeBinding = {
    schema_version: 1,
    project_id: projectId,
    project_root_fingerprint: rootFingerprint,
    mode,
    runtime_authority_id: (input.authorityId ?? randomUUID)(),
    transport,
    calling_thread_id: callingThreadId,
    established_at: now,
    verified_at: now,
    migration: null
  };
  await writeBinding(canonicalRoot, binding);
  const evidence = await readRuntimeBindingEvidence(canonicalRoot);
  if (!evidence) throw new Error('runtime_binding_missing_after_write');
  return evidence.binding;
}

export async function assertRuntimeAuthority(
  rootPath: string,
  expected: Pick<RuntimeBinding, 'runtime_authority_id' | 'mode'>
): Promise<RuntimeBinding> {
  const binding = await readRuntimeBinding(rootPath);
  if (!binding) throw new Error('runtime_binding_missing');
  if (binding.runtime_authority_id !== expected.runtime_authority_id || binding.mode !== expected.mode) {
    throw new Error('runtime_authority_conflict');
  }
  return binding;
}

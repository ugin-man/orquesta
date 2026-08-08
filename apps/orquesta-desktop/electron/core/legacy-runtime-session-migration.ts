import { readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeBinding } from './runtime-binding-store';
import { pathIdentity } from './path-identity';

type JsonRecord = Record<string, unknown>;

export interface LegacyMigrationThread {
  id: string;
  cwd?: string;
  archived: boolean;
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function readSessions(rootPath: string): Promise<{
  canonicalRoot: string;
  statePath: string;
  state: JsonRecord;
  sessions: JsonRecord[];
}> {
  const canonicalRoot = await realpath(rootPath);
  const statePath = path.join(canonicalRoot, '.orquesta', 'state', 'sessions.json');
  const state = record(JSON.parse(await readFile(statePath, 'utf8')));
  if (!state || !Array.isArray(state.sessions)) throw new Error('legacy_runtime_sessions_state_invalid');
  const sessions = state.sessions.map((value) => record(value));
  if (sessions.some((session) => session === null)) throw new Error('legacy_runtime_sessions_state_invalid');
  return { canonicalRoot, statePath, state, sessions: sessions as JsonRecord[] };
}

async function visibleThreadIds(canonicalRoot: string, threads: LegacyMigrationThread[]): Promise<Set<string>> {
  const comparableRoot = (await pathIdentity(canonicalRoot)).key;
  const entries = await Promise.all(threads.map(async (thread) => {
    if (thread.archived || !thread.id.trim()) return [];
    if (thread.cwd && (await pathIdentity(thread.cwd)).key !== comparableRoot) return [];
    return [thread.id.trim()];
  }));
  return new Set(entries.flat());
}

function requiresMigration(session: JsonRecord): boolean {
  return !safeString(session.runtime_authority_id)
    || !safeString(session.visibility)
    || !safeString(session.session_kind);
}

export async function legacyCodexHostedSessionIds(
  rootPath: string,
  threads: LegacyMigrationThread[]
): Promise<string[]> {
  const { canonicalRoot, sessions } = await readSessions(rootPath);
  const visible = await visibleThreadIds(canonicalRoot, threads);
  return sessions.flatMap((session) => {
    const threadId = safeString(session.thread_id);
    return threadId && visible.has(threadId) && requiresMigration(session) ? [threadId] : [];
  });
}

export async function migrateLegacyCodexHostedSessions(input: {
  rootPath: string;
  binding: RuntimeBinding;
  threads: LegacyMigrationThread[];
  now?: () => Date;
}): Promise<string[]> {
  if (input.binding.mode !== 'codex_hosted') throw new Error('legacy_runtime_migration_requires_codex_hosted_binding');
  const { canonicalRoot, statePath, state, sessions } = await readSessions(input.rootPath);
  const visible = await visibleThreadIds(canonicalRoot, input.threads);
  const migratedThreadIds: string[] = [];

  const nextSessions = sessions.map((session) => {
    const threadId = safeString(session.thread_id);
    if (!threadId || !visible.has(threadId) || !requiresMigration(session)) return session;
    const authorityId = safeString(session.runtime_authority_id);
    const visibility = safeString(session.visibility);
    const sessionKind = safeString(session.session_kind);
    if ((authorityId && authorityId !== input.binding.runtime_authority_id)
      || (visibility && visibility !== 'codex_task')
      || (sessionKind && sessionKind !== 'persistent_agent')) {
      throw new Error(`legacy_runtime_migration_conflict:${threadId}`);
    }
    const agentId = safeString(session.agent_id) ?? 'unknown-agent';
    migratedThreadIds.push(threadId);
    return {
      ...session,
      runtime_authority_id: input.binding.runtime_authority_id,
      visibility: 'codex_task',
      profile_id: safeString(session.profile_id) ?? `legacy:${agentId}:v1`,
      session_kind: 'persistent_agent'
    };
  });

  if (!migratedThreadIds.length) return [];
  const now = (input.now ?? (() => new Date()))().toISOString();
  const next = { ...state, updated_at: now, sessions: nextSessions };
  const temporary = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await rename(temporary, statePath);
  return migratedThreadIds;
}

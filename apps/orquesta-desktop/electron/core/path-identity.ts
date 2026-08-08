import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export interface PathIdentity {
  /** A normalized, absolute spelling suitable for diagnostics and nonexistent paths. */
  resolvedPath: string;
  /** An opaque comparison key. Existing paths use filesystem identity where available. */
  key: string;
  exists: boolean;
}

function lexicalKey(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/u, '') || path.parse(path.resolve(value)).root;
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return `path:${normalized.replaceAll('\\', '/')}`;
}

/**
 * Resolves path identity without trusting its spelling. On Windows, a file index is shared
 * by long names, 8.3 aliases, case variants, and paths reached through a worktree spelling.
 * Missing paths deliberately retain only their lexical identity: we never infer that two
 * different nonexistent names will eventually refer to the same directory.
 */
export async function pathIdentity(value: string): Promise<PathIdentity> {
  const absolute = path.resolve(value);
  try {
    const [canonical, details] = await Promise.all([realpath(absolute), stat(absolute, { bigint: true })]);
    const filesystemKey = details.ino !== 0n ? `file:${details.dev}:${details.ino}` : lexicalKey(canonical);
    return { resolvedPath: canonical, key: filesystemKey, exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { resolvedPath: absolute, key: lexicalKey(absolute), exists: false };
  }
}

export async function samePathIdentity(left: string, right: string): Promise<boolean> {
  const [leftIdentity, rightIdentity] = await Promise.all([pathIdentity(left), pathIdentity(right)]);
  return leftIdentity.key === rightIdentity.key;
}

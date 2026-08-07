import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface SetupLaunchContext {
  source: 'argv' | 'environment' | 'e2e' | 'standalone';
  callingThreadId: string | null;
  capturedAt?: string;
}

function validateContext(value: unknown): SetupLaunchContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!['argv', 'environment', 'e2e', 'standalone'].includes(String(record.source))) return null;
  const callingThreadId = record.callingThreadId;
  if (callingThreadId !== null
    && (typeof callingThreadId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(callingThreadId))) {
    return null;
  }
  return {
    source: record.source as SetupLaunchContext['source'],
    callingThreadId: callingThreadId as string | null,
    capturedAt: typeof record.capturedAt === 'string' ? record.capturedAt : undefined
  };
}

async function contextPath(rootPath: string): Promise<string> {
  const canonicalRoot = await realpath(rootPath);
  return path.join(canonicalRoot, '.orquesta', 'setup', 'launch_context.json');
}

export async function writeSetupLaunchContext(rootPath: string, context: SetupLaunchContext): Promise<void> {
  const normalized = validateContext(context);
  if (!normalized) throw new Error('Setup launch context is invalid');
  const destination = await contextPath(rootPath);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({
    ...normalized,
    capturedAt: normalized.capturedAt ?? new Date().toISOString()
  }, null, 2)}\n`, 'utf8');
  await rename(temporary, destination);
}

export async function readSetupLaunchContext(rootPath: string): Promise<SetupLaunchContext | null> {
  try {
    const raw = await readFile(await contextPath(rootPath), 'utf8');
    return validateContext(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

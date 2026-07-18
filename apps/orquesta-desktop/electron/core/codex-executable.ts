import { access, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export interface CodexExecutableDiscoveryOptions {
  env?: Record<string, string | undefined>;
  exists?: (candidate: string) => Promise<boolean>;
  listDirectory?: (directory: string) => Promise<string[]>;
}

async function executableExists(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function directoryNames(directory: string): Promise<string[]> {
  try { return await readdir(directory); } catch { return []; }
}

export async function discoverCodexExecutable(options: CodexExecutableDiscoveryOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const exists = options.exists ?? executableExists;
  const listDirectory = options.listDirectory ?? directoryNames;
  const candidates: string[] = [];

  if (env.ORQUESTA_CODEX_PATH) candidates.push(path.resolve(env.ORQUESTA_CODEX_PATH));
  for (const directory of (env.PATH ?? '').split(path.delimiter).map((entry) => entry.trim()).filter(Boolean)) {
    candidates.push(path.join(directory, 'codex.exe'));
  }
  if (env.USERPROFILE) candidates.push(path.join(env.USERPROFILE, '.local', 'bin', 'codex.exe'));
  if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'Codex', 'codex.exe'));

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }

  const programFiles = env.ProgramFiles ?? env.ProgramW6432;
  if (programFiles) {
    const windowsApps = path.join(programFiles, 'WindowsApps');
    const packages = (await listDirectory(windowsApps))
      .filter((name) => /^OpenAI\.Codex_[^_]+_x64__/u.test(name))
      .sort((left, right) => right.localeCompare(left, 'en', { numeric: true, sensitivity: 'base' }));
    for (const packageName of packages) {
      const candidate = path.join(windowsApps, packageName, 'app', 'resources', 'codex.exe');
      if (await exists(candidate)) return candidate;
    }
  }

  throw new Error('Codex runtime was not found. Install Codex Desktop or a standalone Codex CLI, or set ORQUESTA_CODEX_PATH to codex.exe.');
}

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

const pinnedPackages = [
  { directory: 'codex-sdk', name: '@openai/codex-sdk', version: '0.144.5' },
  { directory: 'codex', name: '@openai/codex', version: '0.144.5' },
  { directory: 'codex-win32-x64', name: '@openai/codex', version: '0.144.5-win32-x64' }
] as const;

type RuntimeManifestFile = {
  path: string;
  bytes: number;
  sha256: string;
};

type RuntimeManifest = {
  schemaVersion: number;
  packages: Array<{ directory: string; name: string; version: string }>;
  files: RuntimeManifestFile[];
};

function assertSafeRelativeManifestPath(relativePath: unknown): asserts relativePath is string {
  if (
    typeof relativePath !== 'string'
    || relativePath.length === 0
    || relativePath.includes('\\')
    || path.posix.isAbsolute(relativePath)
    || relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`Unsafe manifest path: ${String(relativePath)}`);
  }
}

function parseManifest(contents: string): RuntimeManifest {
  const manifest = JSON.parse(contents) as Partial<RuntimeManifest>;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages) || !Array.isArray(manifest.files)) {
    throw new Error('Codex runtime manifest has an unsupported shape');
  }
  if (JSON.stringify(manifest.packages) !== JSON.stringify(pinnedPackages)) {
    throw new Error('Codex runtime manifest package identity mismatch');
  }
  if (manifest.files.length !== 4) {
    throw new Error('Codex runtime manifest must describe exactly four files');
  }

  for (const entry of manifest.files) {
    assertSafeRelativeManifestPath(entry?.path);
  }

  const expectedMetadataPaths = pinnedPackages.map(
    (pinnedPackage) => `node_modules/@openai/${pinnedPackage.directory}/package.json`
  );
  const paths = manifest.files.map((entry) => entry?.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error('Codex runtime manifest contains duplicate file paths');
  }
  for (const metadataPath of expectedMetadataPaths) {
    if (!paths.includes(metadataPath)) {
      throw new Error(`Codex runtime manifest is missing ${metadataPath}`);
    }
  }
  const executablePaths = paths.filter(
    (entryPath) => typeof entryPath === 'string'
      && entryPath.startsWith('node_modules/@openai/codex-win32-x64/')
      && entryPath.toLowerCase().endsWith('/codex.exe')
  );
  if (executablePaths.length !== 1) {
    throw new Error('Codex runtime manifest must describe exactly one pinned codex.exe');
  }
  return manifest as RuntimeManifest;
}

function resolveSafeManifestPath(runtimeRoot: string, relativePath: string): string {
  assertSafeRelativeManifestPath(relativePath);
  const resolvedRoot = path.resolve(runtimeRoot);
  const resolvedFile = path.resolve(resolvedRoot, ...relativePath.split('/'));
  if (!resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Unsafe manifest path: ${relativePath}`);
  }
  return resolvedFile;
}

async function hashRegularFile(filePath: string): Promise<{ bytes: number; sha256: string }> {
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`Codex runtime integrity target is not a regular file: ${filePath}`);
  }
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return { bytes: fileStat.size, sha256: hash.digest('hex') };
}

export async function verifyDesktopRuntimeIntegrity({ runtimeRoot }: { runtimeRoot: string }): Promise<{
  integrity: 'verified';
  filesVerified: number;
}> {
  const manifest = parseManifest(await readFile(path.join(runtimeRoot, 'runtime-manifest.json'), 'utf8'));

  for (const entry of manifest.files) {
    if (
      typeof entry.path !== 'string'
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0
      || typeof entry.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error('Codex runtime manifest contains an invalid file record');
    }
    const targetPath = resolveSafeManifestPath(runtimeRoot, entry.path);
    const actual = await hashRegularFile(targetPath);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      throw new Error(`Codex runtime integrity mismatch for ${entry.path}`);
    }
  }

  for (const pinnedPackage of pinnedPackages) {
    const metadataPath = path.join(runtimeRoot, 'node_modules', '@openai', pinnedPackage.directory, 'package.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { name?: unknown; version?: unknown };
    if (metadata.name !== pinnedPackage.name || metadata.version !== pinnedPackage.version) {
      throw new Error(`Codex runtime package metadata mismatch for ${pinnedPackage.directory}`);
    }
  }

  return { integrity: 'verified', filesVerified: manifest.files.length };
}

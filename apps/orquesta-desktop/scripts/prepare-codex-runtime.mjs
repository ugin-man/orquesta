import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const PINNED_CODEX_PACKAGES = Object.freeze([
  Object.freeze({ directory: 'codex-sdk', name: '@openai/codex-sdk', version: '0.144.5' }),
  Object.freeze({ directory: 'codex', name: '@openai/codex', version: '0.144.5' }),
  Object.freeze({ directory: 'codex-win32-x64', name: '@openai/codex', version: '0.144.5-win32-x64' })
]);

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function assertRegistryLockEntry(lock, pinnedPackage) {
  const key = `node_modules/@openai/${pinnedPackage.directory}`;
  const entry = lock.packages?.[key];
  if (entry?.version !== pinnedPackage.version) {
    throw new Error(`Codex runtime lockfile version mismatch for ${pinnedPackage.directory}`);
  }
  let resolved;
  try {
    resolved = new URL(entry.resolved);
  } catch {
    throw new Error(`Codex runtime lockfile resolved URL is missing for ${pinnedPackage.directory}`);
  }
  if (resolved.protocol !== 'https:' || resolved.hostname !== 'registry.npmjs.org') {
    throw new Error(`Codex runtime lockfile resolved URL is not the public npm registry for ${pinnedPackage.directory}`);
  }
  if (typeof entry.integrity !== 'string' || entry.integrity.length === 0) {
    throw new Error(`Codex runtime lockfile integrity is missing for ${pinnedPackage.directory}`);
  }
}

async function findRegularFilesNamed(root, fileName) {
  const matches = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Codex runtime package contains an unsupported symbolic link: ${entryPath}`);
      }
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
        matches.push(entryPath);
      }
    }
  }
  await visit(root);
  return matches;
}

async function describeFile(runtimeRoot, filePath) {
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`Codex runtime manifest source is not a regular file: ${filePath}`);
  }
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return {
    path: path.relative(runtimeRoot, filePath).split(path.sep).join('/'),
    bytes: fileStat.size,
    sha256: hash.digest('hex')
  };
}

export async function prepareCodexRuntime({ appRoot, stagingRoot }) {
  const openAiSourceRoot = path.join(appRoot, 'node_modules', '@openai');
  const lock = await readJson(path.join(appRoot, 'package-lock.json'));

  for (const pinnedPackage of PINNED_CODEX_PACKAGES) {
    const metadata = await readJson(path.join(openAiSourceRoot, pinnedPackage.directory, 'package.json'));
    if (metadata.name !== pinnedPackage.name) {
      throw new Error(`Codex runtime package name mismatch for ${pinnedPackage.directory}`);
    }
    if (metadata.version !== pinnedPackage.version) {
      throw new Error(`Codex runtime package version mismatch for ${pinnedPackage.directory}`);
    }
    assertRegistryLockEntry(lock, pinnedPackage);
  }

  const runtimeRoot = path.join(stagingRoot, 'codex-runtime');
  const openAiTargetRoot = path.join(runtimeRoot, 'node_modules', '@openai');
  await rm(runtimeRoot, { force: true, recursive: true });
  await mkdir(openAiTargetRoot, { recursive: true });

  for (const pinnedPackage of PINNED_CODEX_PACKAGES) {
    await cp(
      path.join(openAiSourceRoot, pinnedPackage.directory),
      path.join(openAiTargetRoot, pinnedPackage.directory),
      { recursive: true }
    );
  }

  const executableMatches = await findRegularFilesNamed(
    path.join(openAiTargetRoot, 'codex-win32-x64'),
    'codex.exe'
  );
  if (executableMatches.length !== 1) {
    throw new Error(`Expected exactly one staged codex.exe, found ${executableMatches.length}`);
  }

  const manifestFiles = [];
  for (const pinnedPackage of PINNED_CODEX_PACKAGES) {
    manifestFiles.push(await describeFile(
      runtimeRoot,
      path.join(openAiTargetRoot, pinnedPackage.directory, 'package.json')
    ));
  }
  manifestFiles.push(await describeFile(runtimeRoot, executableMatches[0]));
  await writeFile(
    path.join(runtimeRoot, 'runtime-manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, packages: PINNED_CODEX_PACKAGES, files: manifestFiles }, null, 2)}\n`,
    'utf8'
  );

  return path.join(openAiTargetRoot, 'codex-sdk');
}

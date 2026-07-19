import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const PACKAGED_CODEX_PACKAGES = Object.freeze([
  Object.freeze({ directory: 'codex-sdk', name: '@openai/codex-sdk', version: '0.144.5' }),
  Object.freeze({ directory: 'codex', name: '@openai/codex', version: '0.144.5' }),
  Object.freeze({ directory: 'codex-win32-x64', name: '@openai/codex', version: '0.144.5-win32-x64' })
]);

async function hashRegularFile(filePath) {
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`Packaged Codex runtime target is not a regular file: ${filePath}`);
  }
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return { bytes: fileStat.size, sha256: hash.digest('hex') };
}

function safeManifestPath(runtimeRoot, relativePath) {
  if (
    typeof relativePath !== 'string'
    || relativePath.includes('\\')
    || relativePath.split('/').some((part) => !part || part === '.' || part === '..')
    || path.posix.isAbsolute(relativePath)
  ) throw new Error(`Unsafe packaged runtime manifest path: ${String(relativePath)}`);
  const root = path.resolve(runtimeRoot);
  const target = path.resolve(root, ...relativePath.split('/'));
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error(`Unsafe packaged runtime manifest path: ${relativePath}`);
  return target;
}

export async function verifyPackagedRuntime(resourcesRoot) {
  const runtimeRoot = path.join(path.resolve(resourcesRoot), 'codex-runtime');
  const openAiRoot = path.join(runtimeRoot, 'node_modules', '@openai');
  const entries = await readdir(openAiRoot, { withFileTypes: true });
  const expectedDirectories = PACKAGED_CODEX_PACKAGES.map((pkg) => pkg.directory).sort();
  const actualDirectories = entries.map((entry) => entry.name).sort();
  if (
    entries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())
    || JSON.stringify(actualDirectories) !== JSON.stringify(expectedDirectories)
  ) {
    throw new Error(`Packaged @openai runtime must contain exactly ${expectedDirectories.join(', ')}; found ${actualDirectories.join(', ')}`);
  }

  const manifest = JSON.parse(await readFile(path.join(runtimeRoot, 'runtime-manifest.json'), 'utf8'));
  if (
    manifest.schemaVersion !== 1
    || JSON.stringify(manifest.packages) !== JSON.stringify(PACKAGED_CODEX_PACKAGES)
    || !Array.isArray(manifest.files)
    || manifest.files.length !== 4
  ) throw new Error('Packaged Codex runtime manifest does not match the pinned runtime');

  const expectedMetadata = [];
  for (const pkg of PACKAGED_CODEX_PACKAGES) {
    const relativePath = `node_modules/@openai/${pkg.directory}/package.json`;
    expectedMetadata.push(relativePath);
    const metadata = JSON.parse(await readFile(path.join(openAiRoot, pkg.directory, 'package.json'), 'utf8'));
    if (metadata.name !== pkg.name || metadata.version !== pkg.version) {
      throw new Error(`Packaged runtime metadata mismatch for ${pkg.directory}/package.json`);
    }
  }

  const seenPaths = new Set();
  let executablePath = null;
  for (const file of manifest.files) {
    if (
      typeof file?.path !== 'string'
      || seenPaths.has(file.path)
      || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0
      || typeof file.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(file.sha256)
    ) throw new Error('Packaged Codex runtime manifest contains an invalid file record');
    seenPaths.add(file.path);
    const target = safeManifestPath(runtimeRoot, file.path);
    const actual = await hashRegularFile(target);
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) {
      throw new Error(`Packaged Codex runtime integrity mismatch for ${file.path}`);
    }
    if (file.path.startsWith('node_modules/@openai/codex-win32-x64/') && file.path.toLowerCase().endsWith('/codex.exe')) {
      if (executablePath) throw new Error('Packaged runtime contains more than one manifested codex.exe');
      executablePath = target;
    }
  }

  for (const relativePath of expectedMetadata) {
    if (!seenPaths.has(relativePath)) throw new Error(`Packaged runtime manifest is missing ${relativePath}`);
  }
  if (!executablePath) throw new Error('Packaged runtime manifest is missing a regular codex.exe');

  return {
    integrity: 'verified',
    packageDirectories: PACKAGED_CODEX_PACKAGES.map((pkg) => pkg.directory),
    executablePath,
    filesVerified: manifest.files.length
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const resourcesRoot = process.argv[2];
  if (!resourcesRoot) throw new Error('Usage: node scripts/verify-packaged-runtime.mjs <resources-directory>');
  console.log(JSON.stringify(await verifyPackagedRuntime(resourcesRoot), null, 2));
}

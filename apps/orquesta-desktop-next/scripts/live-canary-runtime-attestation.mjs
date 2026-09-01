import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { resolveBundledCodexRuntime } = require('../../../packages/codex-adapter/src');

export const PINNED_CODEX_VERSION = '0.144.5';
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const BUNDLED_SDK_PACKAGE_ROOT = resolve(
  SCRIPT_DIRECTORY,
  '..',
  'codex-runtime',
  'node_modules',
  '@openai',
  'codex-sdk',
);
const BUNDLED_RUNTIME_MANIFEST = resolve(
  SCRIPT_DIRECTORY,
  '..',
  'codex-runtime',
  'runtime-manifest.json',
);

class RuntimeAttestationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RuntimeAttestationError';
    this.code = code;
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export function verifyResolvedRuntimeMeasurement(runtime, manifest, actualSha256) {
  if (!runtime || typeof runtime !== 'object'
    || runtime.sdk_version !== PINNED_CODEX_VERSION
    || runtime.codex_version !== PINNED_CODEX_VERSION
    || typeof runtime.runtime_package !== 'string'
    || typeof runtime.target_triple !== 'string'
    || typeof runtime.executable_path !== 'string') {
    throw new RuntimeAttestationError('runtime_resolution_not_pinned');
  }
  if (!/^[a-f0-9]{64}$/u.test(actualSha256)) {
    throw new RuntimeAttestationError('runtime_executable_sha256_invalid');
  }
  const expectedPath = [
    'node_modules',
    ...runtime.runtime_package.split('/'),
    'vendor',
    runtime.target_triple,
    'bin',
    basename(runtime.executable_path),
  ].join('/');
  const entry = Array.isArray(manifest?.files)
    ? manifest.files.find((candidate) => candidate?.path?.replaceAll('\\', '/') === expectedPath)
    : null;
  if (!entry || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? '')) {
    throw new RuntimeAttestationError('runtime_manifest_executable_missing');
  }
  if (entry.sha256 !== actualSha256) {
    throw new RuntimeAttestationError('runtime_executable_sha256_mismatch');
  }
  return Object.freeze({
    version: runtime.codex_version,
    executableSha256: actualSha256,
    executableSha256Verified: true,
    contractRef: 'codex-runtime/runtime-manifest.json#schemaVersion=1',
  });
}

export async function attestPinnedCodexRuntime({
  sdkPackageRoot = BUNDLED_SDK_PACKAGE_ROOT,
  manifestPath = BUNDLED_RUNTIME_MANIFEST,
  runtimeResolver = resolveBundledCodexRuntime,
  fileHasher = sha256File,
  manifestReader = async (filePath) => JSON.parse(await readFile(filePath, 'utf8')),
} = {}) {
  const runtime = runtimeResolver({ sdkPackageRoot });
  const manifest = await manifestReader(manifestPath);
  const actualSha256 = await fileHasher(runtime.executable_path);
  return verifyResolvedRuntimeMeasurement(runtime, manifest, actualSha256);
}

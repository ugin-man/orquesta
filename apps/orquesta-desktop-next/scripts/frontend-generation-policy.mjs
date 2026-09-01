import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const generationMarkerName = '.orquesta-generation-pending.json';
export const buildIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const noncePattern = /^[0-9a-f]{32}$/u;

export function explicitLoadTestExclusions(environment = process.env) {
  return environment.ORQUESTA_EXPLICIT_LOAD_TESTS === '1' ? [] : ['tests/load/**'];
}

function isDirectChild(parent, candidate) {
  const childName = relative(parent, candidate);
  return (
    childName.length > 0 &&
    !isAbsolute(childName) &&
    !childName.startsWith(`..${sep}`) &&
    childName !== '..' &&
    dirname(childName) === '.'
  );
}

function samePath(left, right) {
  const first = resolve(left);
  const second = resolve(right);
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

export function validateGenerationOutput({ productRoot, outDir, buildId, nonce }) {
  if (!outDir || !buildId || !nonce) throw new Error('frontend_generation_staging_required');
  if (!isAbsolute(outDir)) throw new Error('frontend_generation_outside_allowed_root');
  const canonicalId = buildId.trim().toLowerCase();
  if (!buildIdPattern.test(canonicalId) || !noncePattern.test(nonce)) {
    throw new Error('frontend_generation_invalid_identity');
  }

  const generationParent = resolve(productRoot, '.build-generations', 'generations');
  const generationDir = resolve(outDir);
  if (
    !isDirectChild(generationParent, generationDir) ||
    basename(generationDir) !== canonicalId ||
    generationDir !== join(generationParent, canonicalId)
  ) {
    throw new Error('frontend_generation_outside_allowed_root');
  }

  const generationMetadata = lstatSync(generationDir);
  if (
    !generationMetadata.isDirectory() ||
    generationMetadata.isSymbolicLink() ||
    !samePath(realpathSync(generationDir), generationDir)
  ) {
    throw new Error('frontend_generation_reparse_output_directory');
  }

  const markerPath = join(generationDir, generationMarkerName);
  let marker;
  try {
    const markerMetadata = lstatSync(markerPath);
    if (
      !markerMetadata.isFile() ||
      markerMetadata.isSymbolicLink() ||
      !samePath(realpathSync(markerPath), markerPath)
    ) {
      throw new Error('invalid_marker');
    }
    marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  } catch {
    throw new Error('frontend_generation_fresh_marker_missing');
  }
  if (marker?.buildId !== canonicalId || marker?.nonce !== nonce) {
    throw new Error('frontend_generation_fresh_marker_mismatch');
  }
  return generationDir;
}

export function assertViteBundleCapacity(
  bundle,
  { maxEntries = 120, maxBytes = 60 * 1024 * 1024 } = {},
) {
  const outputs = Object.values(bundle);
  const directories = new Set();
  let totalBytes = 0;
  for (const [fileName, output] of Object.entries(bundle)) {
    const pathParts = fileName.replaceAll('\\', '/').split('/');
    if (
      fileName.startsWith('/') ||
      pathParts.some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error('frontend_generation_invalid_bundle_path');
    }
    for (let index = 1; index < pathParts.length; index += 1) {
      directories.add(pathParts.slice(0, index).join('/'));
    }
    if (output?.type === 'chunk' && typeof output.code === 'string') {
      totalBytes += Buffer.byteLength(output.code, 'utf8');
      continue;
    }
    if (output?.type === 'asset' && (typeof output.source === 'string' || ArrayBuffer.isView(output.source))) {
      totalBytes +=
        typeof output.source === 'string'
          ? Buffer.byteLength(output.source, 'utf8')
          : output.source.byteLength;
      continue;
    }
    throw new Error('frontend_generation_invalid_bundle_output');
  }
  const entries = outputs.length + directories.size;
  if (entries > maxEntries || totalBytes > maxBytes) {
    throw new Error(
      `frontend_generation_bundle_capacity_exceeded:${JSON.stringify({ entries, totalBytes })}`,
    );
  }
  return { entries, totalBytes };
}

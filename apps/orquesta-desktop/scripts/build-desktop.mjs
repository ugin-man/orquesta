import { rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';
import { resolveDesktopPaths } from './desktop-paths.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const paths = resolveDesktopPaths(path.resolve(scriptDirectory, '..'));

export async function buildDesktopHost() {
  await rm(paths.electronDist, { recursive: true, force: true });
  await mkdir(paths.electronDist, { recursive: true });

  const shared = {
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: true,
    logLevel: 'info',
    external: ['electron']
  };

  await Promise.all([
    build({ ...shared, entryPoints: [paths.mainEntry], outfile: path.join(paths.electronDist, 'main.cjs') }),
    build({ ...shared, entryPoints: [paths.preloadEntry], outfile: path.join(paths.electronDist, 'preload.cjs') }),
    build({ ...shared, entryPoints: [paths.coreEntry], outfile: path.join(paths.electronDist, 'core.cjs') })
  ]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildDesktopHost();
}

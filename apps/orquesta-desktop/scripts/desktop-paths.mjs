import path from 'node:path';

export function resolveDesktopPaths(appRoot) {
  const resolvedRoot = path.resolve(appRoot);
  return {
    appRoot: resolvedRoot,
    rendererDist: path.join(resolvedRoot, 'dist'),
    electronDist: path.join(resolvedRoot, 'dist-electron'),
    mainEntry: path.join(resolvedRoot, 'electron', 'main', 'index.ts'),
    preloadEntry: path.join(resolvedRoot, 'electron', 'preload', 'index.ts'),
    coreEntry: path.join(resolvedRoot, 'electron', 'core', 'index.ts')
  };
}

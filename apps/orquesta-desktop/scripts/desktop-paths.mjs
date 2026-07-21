import path from 'node:path';

export function resolveDesktopPaths(appRoot) {
  const resolvedRoot = path.resolve(appRoot);
  return {
    appRoot: resolvedRoot,
    rendererDist: path.join(resolvedRoot, 'dist'),
    electronDist: path.join(resolvedRoot, 'dist-electron'),
    contractSchemasSource: path.resolve(resolvedRoot, '..', '..', 'packages', 'contracts', 'schemas'),
    contractSchemasDist: path.join(resolvedRoot, 'schemas'),
    mainEntry: path.join(resolvedRoot, 'electron', 'main', 'index.ts'),
    preloadEntry: path.join(resolvedRoot, 'electron', 'preload', 'index.ts'),
    coreEntry: path.join(resolvedRoot, 'electron', 'core', 'index.ts'),
    e2eCoreEntry: path.join(resolvedRoot, 'electron', 'core', 'e2e-index.ts')
  };
}

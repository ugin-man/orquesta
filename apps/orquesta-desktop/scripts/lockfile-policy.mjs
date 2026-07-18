const npmRegistryPrefix = 'https://registry.npmjs.org/';
const approvedPinnedSources = new Set([
  'git+ssh://git@github.com/electron/node-gyp.git#06b29aafb7708acef8b3669835c8a7857ebc92d2',
  '../../packages/codex-adapter'
]);

export function isApprovedResolvedUrl(resolvedUrl) {
  return resolvedUrl.startsWith(npmRegistryPrefix) || approvedPinnedSources.has(resolvedUrl);
}

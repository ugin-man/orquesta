import path from 'node:path';

export type DesktopRuntimeLocationInput = {
  packaged: boolean;
  appRoot: string;
  resourcesPath: string;
};

export function resolveDesktopSdkPackageRoot(input: DesktopRuntimeLocationInput): string {
  const nodeModulesRoot = input.packaged
    ? path.win32.join(input.resourcesPath, 'codex-runtime', 'node_modules')
    : path.win32.join(input.appRoot, 'node_modules');
  return path.win32.join(nodeModulesRoot, '@openai', 'codex-sdk');
}

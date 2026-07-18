import { spawn } from 'node:child_process';
import path from 'node:path';
import * as canonicalAdapterModule from '@orquesta/codex-adapter';
import { DesktopCodexService, type CanonicalCodexAdapter } from './desktop-codex-service';
import { runDesktopCore } from './core-runner';

const scriptPath = process.env.ORQUESTA_E2E_CODEX_SCRIPT;
if (!scriptPath || !path.isAbsolute(scriptPath) || path.extname(scriptPath).toLowerCase() !== '.cjs') {
  throw new Error('E2E Core requires an absolute .cjs fake App Server path');
}

const createAppServerAdapter = (canonicalAdapterModule as unknown as {
  createAppServerAdapter(options: Record<string, unknown>): CanonicalCodexAdapter;
}).createAppServerAdapter;

const adapter = createAppServerAdapter({
  sdkPackageRoot: path.dirname(scriptPath),
  resolveRuntime: () => ({
    executable_path: process.execPath,
    sdk_package: '@openai/codex-sdk',
    sdk_version: '0.144.5',
    codex_package: '@openai/codex',
    codex_version: '0.144.5',
    runtime_package: '@openai/codex-win32-x64',
    runtime_package_version: '0.144.5-win32-x64',
    target_triple: 'x86_64-pc-windows-msvc'
  }),
  spawnProcess: (_executable: string, _args: string[], options: Record<string, unknown>) => spawn(
    process.execPath,
    [scriptPath],
    {
      ...options,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    }
  )
});

runDesktopCore(new DesktopCodexService({ adapter }));

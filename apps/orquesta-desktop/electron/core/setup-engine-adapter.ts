import type { SetupDraft, SetupStartResult } from '../../src/contracts/setup';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
// The canonical setup engine stays in Orquesta core and is bundled into the
// isolated Desktop Core worker for packaged builds.
// @ts-expect-error The canonical CommonJS module does not publish TypeScript declarations.
import setupEngineModule from '../../../../orquesta/scripts/setup-engine.js';
// @ts-expect-error Canonical CommonJS setup modules do not publish TypeScript declarations.
import setupPhaseHandlersModule from '../../../../orquesta/scripts/setup-phase-handlers.js';
// @ts-expect-error Canonical CommonJS setup modules do not publish TypeScript declarations.
import setupRunnerModule from '../../../../orquesta/scripts/setup-runner.js';
import type { SetupProgressEvent } from '../../src/contracts/setup';
import type { ProvisioningBatch } from './specialist-provisioner';

interface SetupEngineModule {
  createSetupEngine(): {
    start(input: { rootPath: string; draft: SetupDraft }): Promise<{
      result: SetupStartResult;
      setup_state: Record<string, unknown>;
    }>;
  };
}

interface SetupEngineLike {
  start(input: { rootPath: string; draft: SetupDraft }): Promise<{
    result: SetupStartResult;
    setup_state: Record<string, unknown>;
  }>;
}

interface SetupRunnerLike {
  run(input: { rootPath: string; setupId: string }): Promise<unknown>;
  resume(input: { rootPath: string; setupId: string }): Promise<unknown>;
  cancel(input: { rootPath: string; setupId: string }): Promise<unknown>;
}

interface DesktopSetupControllerOptions {
  engine?: SetupEngineLike;
  runner?: SetupRunnerLike;
  readSetupState?: (rootPath: string) => Promise<Record<string, unknown> | null>;
  provisionSpecialists?: (input: { rootPath: string; projectId: string; batch: ProvisioningBatch }) => Promise<ProvisioningBatch>;
  onProgress?: (progress: SetupProgressEvent) => void | Promise<void>;
  onBackgroundError?: (error: unknown) => void;
}

async function readSetupState(rootPath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path.join(rootPath, '.orquesta', 'setup', 'setup_state.json'), 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function createDesktopSetupController(options: DesktopSetupControllerOptions = {}) {
  const engine = options.engine ?? (setupEngineModule as SetupEngineModule).createSetupEngine();
  const runner = options.runner ?? (setupRunnerModule as {
    createSetupRunner(input: Record<string, unknown>): SetupRunnerLike;
  }).createSetupRunner({
    handlers: (setupPhaseHandlersModule as {
      createDefaultPhaseHandlers(input: Record<string, unknown>): Record<string, unknown>;
    }).createDefaultPhaseHandlers({ provisionSpecialists: options.provisionSpecialists }),
    onProgress: options.onProgress
  });
  const readState = options.readSetupState ?? readSetupState;
  const reportBackgroundError = options.onBackgroundError ?? (() => undefined);

  const launch = (promise: Promise<unknown>) => {
    void promise.catch(reportBackgroundError);
  };

  return {
    async start(input: { rootPath: string; draft: SetupDraft }): Promise<SetupStartResult> {
      const started = await engine.start(input);
      return started.result;
    },

    async resume(input: { rootPath: string }): Promise<void> {
      const state = await readState(input.rootPath);
      const setupId = typeof state?.setup_id === 'string' ? state.setup_id : null;
      const status = typeof state?.status === 'string' ? state.status : null;
      if (!setupId || !['active', 'preparing', 'running', 'in_progress', 'provisioning'].includes(status ?? '')) return;
      launch(runner.resume({ rootPath: input.rootPath, setupId }));
    },

    async cancel(input: { rootPath: string; setupId: string }): Promise<void> {
      await runner.cancel(input);
    }
  };
}

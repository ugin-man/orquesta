import type { SetupDraft, SetupStartResult } from '../../src/contracts/setup';
// The canonical setup engine stays in Orquesta core and is bundled into the
// isolated Desktop Core worker for packaged builds.
// @ts-expect-error The canonical CommonJS module does not publish TypeScript declarations.
import setupEngineModule from '../../../../orquesta/scripts/setup-engine.js';

interface SetupEngineModule {
  createSetupEngine(): {
    start(input: { rootPath: string; draft: SetupDraft }): Promise<{
      result: SetupStartResult;
      setup_state: Record<string, unknown>;
    }>;
  };
}

const engine = (setupEngineModule as SetupEngineModule).createSetupEngine();

export async function startDesktopSetup(input: { rootPath: string; draft: SetupDraft }): Promise<SetupStartResult> {
  return (await engine.start(input)).result;
}

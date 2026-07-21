import { describe, expect, test, vi } from 'vitest';
import type { SetupDraft } from '../../src/contracts/setup';
import { createDesktopSetupController } from './setup-engine-adapter';

const draft: SetupDraft = {
  revision: 1,
  status: 'draft',
  source: { kind: 'detected_root', rootPath: 'C:\\repo' },
  projectName: 'Demo',
  description: 'Demo setup',
  questions: [],
  answers: []
};

describe('Desktop setup controller', () => {
  test('returns the durable start result before the background runner finishes', async () => {
    let release!: () => void;
    const running = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn(async () => running);
    const engine = {
      start: vi.fn(async () => ({
        result: { setupId: 'SETUP-1', rootPath: 'C:\\repo', activePhaseId: 'environment' as const },
        setup_state: { setup_id: 'SETUP-1' }
      }))
    };
    const controller = createDesktopSetupController({
      engine,
      runner: { run, resume: vi.fn(), cancel: vi.fn() },
      readSetupState: vi.fn()
    });

    await expect(controller.start({ rootPath: 'C:\\repo', draft })).resolves.toEqual({
      setupId: 'SETUP-1', rootPath: 'C:\\repo', activePhaseId: 'environment'
    });
    expect(run).toHaveBeenCalledWith({ rootPath: 'C:\\repo', setupId: 'SETUP-1' });
    release();
    await running;
  });

  test('resumes one active setup and ignores terminal setup state', async () => {
    const resume = vi.fn(async () => undefined);
    const readSetupState = vi.fn()
      .mockResolvedValueOnce({ setup_id: 'SETUP-2', status: 'running' })
      .mockResolvedValueOnce({ setup_id: 'SETUP-2', status: 'completed' });
    const controller = createDesktopSetupController({
      engine: { start: vi.fn() },
      runner: { run: vi.fn(), resume, cancel: vi.fn() },
      readSetupState
    });

    await controller.resume({ rootPath: 'C:\\repo' });
    await controller.resume({ rootPath: 'C:\\repo' });

    expect(resume).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledWith({ rootPath: 'C:\\repo', setupId: 'SETUP-2' });
  });
});

import { describe, expect, test } from 'vitest';
import { resolveSetupLaunchIntent } from './setup-launch-intent';

describe('setup launch intent', () => {
  test('requires an explicit argv flag for one-time legacy runtime migration', () => {
    expect(resolveSetupLaunchIntent({
      argv: ['Orquesta.exe', '--orquesta-project', 'C:\\repo', '--orquesta-calling-thread', 'thread-1', '--orquesta-migrate-legacy-runtime'],
      env: {},
      cwd: 'C:\\cwd'
    })).toEqual({
      source: 'argv', rootPath: 'C:\\repo', callingThreadId: 'thread-1', legacyMigration: true
    });
    expect(resolveSetupLaunchIntent({
      argv: ['Orquesta.exe', '--orquesta-project', 'C:\\repo', '--orquesta-calling-thread', 'thread-1'],
      env: {},
      cwd: 'C:\\cwd'
    })).not.toHaveProperty('legacyMigration');
  });

  test('prefers an explicit project argument and ignores unrelated arguments', () => {
    expect(resolveSetupLaunchIntent({
      argv: [
        'Orquesta.exe',
        '--orquesta-project',
        'C:\\work\\demo',
        '--orquesta-calling-thread',
        '018f0000-0000-7000-8000-000000000001',
        'unrelated.txt'
      ],
      env: {},
      cwd: 'C:\\fallback'
    })).toEqual({
      source: 'argv',
      rootPath: 'C:\\work\\demo',
      callingThreadId: '018f0000-0000-7000-8000-000000000001'
    });
    expect(resolveSetupLaunchIntent({ argv: ['Orquesta.exe', 'unrelated.txt'], env: {}, cwd: 'C:\\fallback' })).toBeNull();
  });

  test('supports the Codex install environment and bounded E2E override', () => {
    expect(resolveSetupLaunchIntent({
      argv: ['Orquesta.exe'],
      env: {
        ORQUESTA_PROJECT_ROOT: 'C:\\work\\codex',
        CODEX_THREAD_ID: '018f0000-0000-7000-8000-000000000001'
      },
      cwd: 'C:\\fallback'
    })).toEqual({
      source: 'environment',
      rootPath: 'C:\\work\\codex',
      callingThreadId: '018f0000-0000-7000-8000-000000000001'
    });
    expect(resolveSetupLaunchIntent({
      argv: ['Orquesta.exe'], env: { ORQUESTA_E2E: '1', ORQUESTA_E2E_PROJECT_ROOT: 'C:\\work\\e2e' }, cwd: 'C:\\fallback'
    })).toEqual({ source: 'e2e', rootPath: 'C:\\work\\e2e', callingThreadId: null });
  });

  test('rejects empty and oversized roots', () => {
    expect(resolveSetupLaunchIntent({ argv: ['Orquesta.exe', '--orquesta-project='], env: {}, cwd: 'C:\\fallback' })).toBeNull();
    expect(resolveSetupLaunchIntent({ argv: ['Orquesta.exe'], env: { ORQUESTA_PROJECT_ROOT: 'x'.repeat(32_769) }, cwd: 'C:\\fallback' })).toBeNull();
  });
});

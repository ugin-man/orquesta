import { describe, expect, test } from 'vitest';
import { resolveSetupLaunchIntent } from './setup-launch-intent';

describe('setup launch intent', () => {
  test('prefers an explicit project argument and ignores unrelated arguments', () => {
    expect(resolveSetupLaunchIntent({
      argv: ['Orquesta.exe', '--orquesta-project', 'C:\\work\\demo', 'unrelated.txt'],
      env: {},
      cwd: 'C:\\fallback'
    })).toEqual({ source: 'argv', rootPath: 'C:\\work\\demo' });
    expect(resolveSetupLaunchIntent({ argv: ['Orquesta.exe', 'unrelated.txt'], env: {}, cwd: 'C:\\fallback' })).toBeNull();
  });

  test('supports the Codex install environment and bounded E2E override', () => {
    expect(resolveSetupLaunchIntent({
      argv: ['Orquesta.exe'], env: { ORQUESTA_PROJECT_ROOT: 'C:\\work\\codex' }, cwd: 'C:\\fallback'
    })).toEqual({ source: 'environment', rootPath: 'C:\\work\\codex' });
    expect(resolveSetupLaunchIntent({
      argv: ['Orquesta.exe'], env: { ORQUESTA_E2E: '1', ORQUESTA_E2E_PROJECT_ROOT: 'C:\\work\\e2e' }, cwd: 'C:\\fallback'
    })).toEqual({ source: 'e2e', rootPath: 'C:\\work\\e2e' });
  });

  test('rejects empty and oversized roots', () => {
    expect(resolveSetupLaunchIntent({ argv: ['Orquesta.exe', '--orquesta-project='], env: {}, cwd: 'C:\\fallback' })).toBeNull();
    expect(resolveSetupLaunchIntent({ argv: ['Orquesta.exe'], env: { ORQUESTA_PROJECT_ROOT: 'x'.repeat(32_769) }, cwd: 'C:\\fallback' })).toBeNull();
  });
});

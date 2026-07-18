import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { discoverCodexExecutable } from './codex-executable';

describe('discoverCodexExecutable', () => {
  test('prefers an explicit bounded runtime path', async () => {
    const exists = vi.fn(async (candidate: string) => candidate === 'C:\\tools\\codex.exe');
    await expect(discoverCodexExecutable({
      env: { ORQUESTA_CODEX_PATH: 'C:\\tools\\codex.exe', PATH: 'C:\\other' }, exists, listDirectory: vi.fn(async () => [])
    })).resolves.toBe('C:\\tools\\codex.exe');
  });

  test('discovers a standalone CLI before the packaged Desktop runtime', async () => {
    const standalone = path.join('C:\\bin', 'codex.exe');
    await expect(discoverCodexExecutable({
      env: { PATH: 'C:\\bin;C:\\other', ProgramFiles: 'C:\\Program Files' },
      exists: vi.fn(async (candidate: string) => candidate === standalone),
      listDirectory: vi.fn(async () => ['OpenAI.Codex_1.0.0_x64__publisher'])
    })).resolves.toBe(standalone);
  });

  test('uses the newest installed Codex Desktop resource without bundling another runtime', async () => {
    const newest = path.join('C:\\Program Files', 'WindowsApps', 'OpenAI.Codex_26.715.2305.0_x64__publisher', 'app', 'resources', 'codex.exe');
    await expect(discoverCodexExecutable({
      env: { PATH: '', ProgramFiles: 'C:\\Program Files' },
      exists: vi.fn(async (candidate: string) => candidate === newest),
      listDirectory: vi.fn(async () => ['OpenAI.Codex_26.700.1.0_x64__publisher', 'OpenAI.Codex_26.715.2305.0_x64__publisher'])
    })).resolves.toBe(newest);
  });

  test('returns a useful setup error when no Codex runtime is available', async () => {
    await expect(discoverCodexExecutable({ env: { PATH: '' }, exists: vi.fn(async () => false), listDirectory: vi.fn(async () => []) }))
      .rejects.toThrow('ORQUESTA_CODEX_PATH');
  });
});

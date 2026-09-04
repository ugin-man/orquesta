import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

describe('native window chrome configuration', () => {
  test('removes the duplicate operating-system title bar while preserving the window shadow', () => {
    const config = JSON.parse(readFileSync(path.resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8')) as {
      app: { windows: Array<{ label: string; decorations?: boolean; shadow?: boolean }> };
    };
    const main = config.app.windows.find((window) => window.label === 'main');

    expect(main).toMatchObject({ decorations: false, shadow: true });
  });

  test('grants only the native commands used by the integrated controls', () => {
    const capability = JSON.parse(readFileSync(path.resolve(process.cwd(), 'src-tauri/capabilities/default.json'), 'utf8')) as {
      permissions: string[];
    };

    expect(capability.permissions).toEqual(expect.arrayContaining([
      'core:window:allow-close',
      'core:window:allow-minimize',
      'core:window:allow-toggle-maximize',
      'core:window:allow-start-dragging',
    ]));
  });
});

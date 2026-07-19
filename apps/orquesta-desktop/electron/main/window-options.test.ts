import { describe, expect, test } from 'vitest';
import { createMainWindowOptions } from './window-options';

describe('createMainWindowOptions', () => {
  test('keeps the renderer isolated from Node and sandboxed', () => {
    const options = createMainWindowOptions('C:\\app\\preload.cjs');

    expect(options.webPreferences).toMatchObject({
      preload: 'C:\\app\\preload.cjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    });
  });

  test('keeps the approved renderer usable on the minimum window size', () => {
    const options = createMainWindowOptions('C:\\app\\preload.cjs');

    expect(options).toMatchObject({
      width: 1440,
      height: 900,
      minWidth: 1180,
      minHeight: 720,
      show: false,
      backgroundColor: '#ffffff'
    });
  });
});

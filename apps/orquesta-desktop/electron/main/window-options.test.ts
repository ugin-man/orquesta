import { describe, expect, test } from 'vitest';
import { createMainWindowOptions, createSplashWindowOptions, splashDocument } from './window-options';

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
      backgroundColor: '#efede8'
    });
  });
});

describe('splash window', () => {
  test('uses a transparent frameless window without privileged web APIs', () => {
    expect(createSplashWindowOptions()).toMatchObject({
      width: 320,
      height: 220,
      frame: false,
      transparent: true,
      show: false,
      skipTaskbar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
    });
  });

  test('renders an inline Orquesta mark without remote resources', () => {
    const document = splashDocument();
    expect(document).toContain('ORQUESTA');
    expect(document).not.toMatch(/https?:\/\//u);
  });
});

import { describe, expect, it } from 'vitest';

import { resolveDesktopSdkPackageRoot } from './runtime-location';

describe('resolveDesktopSdkPackageRoot', () => {
  it('uses the Desktop-local SDK package while developing', () => {
    expect(resolveDesktopSdkPackageRoot({
      packaged: false,
      appRoot: 'C:\\app',
      resourcesPath: 'ignored'
    })).toBe('C:\\app\\node_modules\\@openai\\codex-sdk');
  });

  it('uses the staged resource SDK package after packaging', () => {
    expect(resolveDesktopSdkPackageRoot({
      packaged: true,
      appRoot: 'ignored',
      resourcesPath: 'C:\\Program Files\\Orquesta\\resources'
    })).toBe('C:\\Program Files\\Orquesta\\resources\\codex-runtime\\node_modules\\@openai\\codex-sdk');
  });
});

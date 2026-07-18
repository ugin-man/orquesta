import { describe, expect, test } from 'vitest';
import { useFakeRuntimeCore } from './startup-mode';

describe('desktop startup mode', () => {
  test('uses the fake runtime Core only when the fake App Server was supplied', () => {
    expect(useFakeRuntimeCore({ ORQUESTA_E2E: '1' })).toBe(false);
    expect(useFakeRuntimeCore({ ORQUESTA_E2E: '1', ORQUESTA_E2E_CODEX_SCRIPT: 'C:\\fake.cjs' })).toBe(true);
    expect(useFakeRuntimeCore({ ORQUESTA_E2E: '0', ORQUESTA_E2E_CODEX_SCRIPT: 'C:\\fake.cjs' })).toBe(false);
  });
});

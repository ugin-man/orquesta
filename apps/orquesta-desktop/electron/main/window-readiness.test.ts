import { describe, expect, test, vi } from 'vitest';
import { createWindowReadinessGate } from './window-readiness';

describe('window readiness gate', () => {
  test('reveals once only after the browser window and renderer are both ready', () => {
    const reveal = vi.fn();
    const gate = createWindowReadinessGate(reveal, 6000, vi.fn(() => 1), vi.fn());

    gate.markWindowReady();
    expect(reveal).not.toHaveBeenCalled();
    gate.markRendererReady();
    gate.markRendererReady();
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  test('fallback reveals a renderer that never sends the ready signal', () => {
    const reveal = vi.fn();
    let fallback = () => undefined;
    createWindowReadinessGate(reveal, 6000, (callback) => { fallback = callback; return 1; }, vi.fn());

    fallback();
    expect(reveal).toHaveBeenCalledTimes(1);
  });
});

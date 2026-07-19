import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createStartupCurtainController } from '../../src/renderer/startup/startup-curtain';

describe('startup curtain controller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="startup-curtain"><img class="startup-curtain__logo"></div>';
    window.history.replaceState({}, '', '/');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false }))
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('waits 1400ms before starting the 300ms exit', () => {
    const controller = createStartupCurtainController();

    controller.markReady();
    vi.advanceTimersByTime(1399);
    expect(document.getElementById('startup-curtain')).not.toHaveClass('startup-curtain--exiting');

    vi.advanceTimersByTime(1);
    expect(document.getElementById('startup-curtain')).toHaveClass('startup-curtain--exiting');

    vi.advanceTimersByTime(300);
    expect(document.getElementById('startup-curtain')).toBeNull();
  });

  test('starts the exit immediately when readiness arrives after the minimum', () => {
    const controller = createStartupCurtainController();

    vi.advanceTimersByTime(1800);
    controller.markReady();

    expect(document.getElementById('startup-curtain')).toHaveClass('startup-curtain--exiting');
  });

  test('falls back after 6000ms when readiness never arrives', () => {
    createStartupCurtainController();

    vi.advanceTimersByTime(5999);
    expect(document.getElementById('startup-curtain')).not.toHaveClass('startup-curtain--exiting');
    vi.advanceTimersByTime(1);
    expect(document.getElementById('startup-curtain')).toHaveClass('startup-curtain--exiting');
  });

  test('removes immediately after readiness in instant mode', () => {
    window.history.replaceState({}, '', '/?startup=instant');
    const controller = createStartupCurtainController();

    controller.markReady();

    expect(document.getElementById('startup-curtain')).toBeNull();
  });

  test('uses a short fade duration when reduced motion is enabled', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true }))
    });
    const controller = createStartupCurtainController();

    controller.markReady();
    vi.advanceTimersByTime(1400 + 159);
    expect(document.getElementById('startup-curtain')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(document.getElementById('startup-curtain')).toBeNull();
  });
});

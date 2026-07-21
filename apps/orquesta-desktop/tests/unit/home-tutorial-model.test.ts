import { beforeEach, describe, expect, test } from 'vitest';
import {
  HOME_TUTORIAL_STEPS,
  readHomeTutorialPreference,
  shouldAutoStartHomeTutorial,
  writeHomeTutorialPreference
} from '../../src/renderer/features/tutorial/home-tutorial-model';

describe('Home tutorial model', () => {
  beforeEach(() => window.localStorage.clear());

  test('defines the same seven ordered pages in Japanese and English', () => {
    expect(HOME_TUTORIAL_STEPS.map((step) => step.id)).toEqual([
      'map', 'composer', 'user-tasks', 'now', 'dock', 'project', 'luca'
    ]);

    for (const step of HOME_TUTORIAL_STEPS) {
      expect(step.copy.ja.title.length).toBeGreaterThan(0);
      expect(step.copy.ja.body.length).toBeGreaterThan(0);
      expect(step.copy.en.title.length).toBeGreaterThan(0);
      expect(step.copy.en.body.length).toBeGreaterThan(0);
    }
  });

  test('stores only a completed or skipped version, not the current page', () => {
    writeHomeTutorialPreference(window.localStorage, 'skipped', new Date('2026-07-22T00:00:00.000Z'));

    expect(readHomeTutorialPreference(window.localStorage)).toEqual({
      version: 1,
      outcome: 'skipped',
      updatedAt: '2026-07-22T00:00:00.000Z'
    });
    expect(window.localStorage.getItem('orquesta.desktop.home-tutorial.v1')).not.toContain('step');
  });

  test('rejects malformed or obsolete saved preferences', () => {
    window.localStorage.setItem('orquesta.desktop.home-tutorial.v1', '{broken');
    expect(readHomeTutorialPreference(window.localStorage)).toBeNull();

    window.localStorage.setItem('orquesta.desktop.home-tutorial.v1', JSON.stringify({
      version: 0,
      outcome: 'completed',
      updatedAt: '2026-07-22T00:00:00.000Z'
    }));
    expect(readHomeTutorialPreference(window.localStorage)).toBeNull();
  });

  test('auto-starts only on an active setup to completed setup transition', () => {
    expect(shouldAutoStartHomeTutorial('running', 'completed', null)).toBe(true);
    expect(shouldAutoStartHomeTutorial(null, 'completed', null)).toBe(false);
    expect(shouldAutoStartHomeTutorial('completed', 'completed', null)).toBe(false);
    expect(shouldAutoStartHomeTutorial('running', 'completed', {
      version: 1,
      outcome: 'completed',
      updatedAt: '2026-07-22T00:00:00.000Z'
    })).toBe(false);
  });
});

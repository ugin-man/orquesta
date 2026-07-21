/// <reference types="vite/client" />

import { describe, expect, test } from 'vitest';
import css from '../../src/renderer/styles/global.css?raw';

describe('desktop review density', () => {
  test('keeps review workspaces wide and primary filters comfortably readable', () => {
    expect(css).toMatch(/\.workspace-surface\s*\{[^}]*right:\s*clamp\(72px,\s*8vw,\s*150px\);[^}]*left:\s*clamp\(72px,\s*8vw,\s*150px\);/s);
    expect(css).toMatch(/\.home-right-rail\s*\{[^}]*width:\s*276px;/s);
    expect(css).toMatch(/\.attention-card__counts button\s*\{[^}]*min-height:\s*30px;[^}]*font-size:\s*9px;/s);
    expect(css).toMatch(/\.user-task-filters button\s*\{[^}]*min-height:\s*40px;[^}]*font-size:\s*10px;/s);
  });

  test('aligns the home right rail and keeps expanded cards from occupying the same slot', () => {
    expect(css).toMatch(/\.home-right-rail\s*\{[^}]*top:\s*18px;[^}]*right:\s*clamp\(24px,\s*2\.4vw,\s*44px\);[^}]*width:\s*276px;[^}]*flex-direction:\s*column;[^}]*gap:\s*16px;/s);
    expect(css).toMatch(/\.project-status\s*\{[^}]*position:\s*relative;[^}]*align-self:\s*flex-end;[^}]*width:\s*220px;/s);
    expect(css).toMatch(/\.attention-card\s*\{[^}]*position:\s*relative;[^}]*width:\s*100%;/s);
  });

  test('uses the freed dock space for larger workspace targets', () => {
    expect(css).toMatch(/\.workspace-dock\s*\{[^}]*width:\s*276px;/s);
    expect(css).toMatch(/\.workspace-dock-item\s*\{[^}]*height:\s*40px;[^}]*min-width:\s*40px;[^}]*padding:\s*0 10px;/s);
    expect(css).toMatch(/\.workspace-dock-icon\s*\{[^}]*width:\s*17px;[^}]*height:\s*17px;/s);
    expect(css).toMatch(/\.workspace-dock-label\s*\{[^}]*font-size:\s*10px;/s);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/global.css'), 'utf8');

describe('desktop review density', () => {
  test('keeps review workspaces wide and primary filters comfortably readable', () => {
    expect(css).toMatch(/\.workspace-surface\s*\{[^}]*right:\s*clamp\(72px,\s*8vw,\s*150px\);[^}]*left:\s*clamp\(72px,\s*8vw,\s*150px\);/s);
    expect(css).toMatch(/\.attention-card\s*\{[^}]*width:\s*276px;/s);
    expect(css).toMatch(/\.attention-card__counts button\s*\{[^}]*min-height:\s*30px;[^}]*font-size:\s*9px;/s);
    expect(css).toMatch(/\.user-task-filters button\s*\{[^}]*min-height:\s*40px;[^}]*font-size:\s*10px;/s);
  });
});

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const styles = readFileSync(
  path.resolve(process.cwd(), 'src/styles.css'),
  'utf8',
);

function productionSources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return productionSources(absolute);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
}

describe('Desktop visual authority', () => {
  test('keeps the retired Operations Ledger stylesheet out of the active bundle', () => {
    expect(styles).not.toContain('Operations Ledger recovery');
    expect(styles).not.toContain('.operations-ledger-shell');
  });

  test('does not ship retired launcher, setup, rail, or context-sheet owners', () => {
    for (const selector of [
      'launcher-copy', 'launcher-projects', 'project-row', 'setup-home',
      'workspace-topbar', 'workspace-tabs', 'workspace-status', 'project-chip', 'runtime-chip',
      'left-rail', 'right-rail', 'phase-meter', 'now-card', 'attention-summary', 'workspace-main',
      'route-view', 'history-body', 'history-agents', 'message-history', 'roster-table',
      'inspection-launchers', 'operations-body', 'business-work-orders', 'inspection-grid',
      'inspection-card', 'agent-sheet', 'setup-banner',
    ]) {
      expect(styles, selector).not.toContain(`.${selector}`);
    }
  });

  test('scopes shared Work selectors to the current V5 workspace owner', () => {
    for (const selector of ['ledger-sidebar', 'selected-execution-head', 'ledger-details']) {
      const unscoped = new RegExp(`^\\.${selector}(?:[\\s:{.#>]|$)`, 'mu');
      expect(styles, selector).not.toMatch(unscoped);
      expect(styles).toContain(`.v5-workspace-shell .${selector}`);
    }
  });
});

describe('Renderer storage authority', () => {
  test('allows only the one-time legacy locale read and retirement', () => {
    const sourceRoot = path.resolve(process.cwd(), 'src');
    const sources = productionSources(sourceRoot).map((file) => ({
      file: path.relative(sourceRoot, file).replaceAll('\\', '/'),
      text: readFileSync(file, 'utf8'),
    }));
    expect(sources
      .filter(({ text }) => /\b(?:localStorage|sessionStorage|indexedDB)\b/.test(text))
      .map(({ file }) => file)).toEqual(['App.tsx']);

    const localStorageReferences = sources.flatMap(({ file, text }) =>
      [...text.matchAll(/\blocalStorage\b/g)].map(() => file));
    expect(localStorageReferences).toEqual(['App.tsx', 'App.tsx']);

    const calls = sources.flatMap(({ file, text }) => [...text.matchAll(
      /window\.localStorage\.(getItem|setItem|removeItem|clear)\(([^)]*)\)/g,
    )].map((match) => ({ file, method: match[1], argument: match[2] })));
    expect(calls).toEqual([
      { file: 'App.tsx', method: 'getItem', argument: "'orquesta.desktop-next.locale'" },
      { file: 'App.tsx', method: 'removeItem', argument: "'orquesta.desktop-next.locale'" },
    ]);
    expect(sources.map(({ text }) => text).join('\n')).not.toMatch(/\b(?:sessionStorage|indexedDB)\b/);
  });
});

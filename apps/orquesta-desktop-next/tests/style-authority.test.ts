import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const styles = readFileSync(
  path.resolve(process.cwd(), 'src/styles.css'),
  'utf8',
);

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
    for (const selector of ['ledger-sidebar']) {
      const unscoped = new RegExp(`^\\.${selector}(?:[\\s:{.#>]|$)`, 'mu');
      expect(styles, selector).not.toMatch(unscoped);
      expect(styles).toContain(`.v5-workspace-shell .${selector}`);
    }
    for (const removed of ['selected-execution-head', 'execution-progress', 'ledger-details', 'details-rail-head']) {
      expect(styles, removed).not.toContain(`.${removed}`);
    }
  });

  test('opens the composer runtime submenu to the right of its parent menu', () => {
    expect(styles).toMatch(/\.composer-runtime-menu\s*\{[^}]*--runtime-submenu-width:\s*228px;[^}]*--runtime-submenu-gap:\s*7px;[^}]*right:\s*calc\(var\(--runtime-submenu-width\) \+ var\(--runtime-submenu-gap\)\);/u);
    expect(styles).toMatch(/\.composer-runtime-submenu\s*\{[^}]*left:\s*calc\(100% \+ var\(--runtime-submenu-gap\)\);[^}]*right:\s*auto;[^}]*width:\s*var\(--runtime-submenu-width\);/u);
    expect(styles).not.toMatch(/\.composer-runtime-submenu\s*\{[^}]*right:\s*calc\(100% \+ 7px\);/u);
  });

  test('keeps a stable conversation axis between the left dock and right workspace', () => {
    expect(styles).toMatch(/--desired-conversation-balance:\s*var\(--left-dock-inset\);/u);
    expect(styles).toMatch(/--conversation-balance-inset:\s*clamp\(0px,[^;]+var\(--desired-conversation-balance\)\);/u);
    expect(styles).toMatch(/\.orquesta-thread-viewport\s*\{[^}]*padding:[^;]*var\(--conversation-balance-inset\)/u);
    expect(styles).toMatch(/\.orquesta-thread-message\s*\{[^}]*width:\s*min\(100%,\s*var\(--conversation-column-width\)\);[^}]*margin-inline:\s*auto;/u);
    expect(styles).toMatch(/\.ledger-composer-slot \.composer\s*\{[^}]*width:\s*min\(100%,\s*var\(--conversation-column-width\)\);[^}]*margin-inline:\s*auto;/u);
  });

  test('uses an icon-shaped project identity without a circular initial avatar', () => {
    expect(styles).toMatch(/\.ledger-project-icon\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;[^}]*display:\s*grid;[^}]*color:\s*rgba\(255,255,255,\.9\);[^}]*transform:\s*translateX\(-8px\);/u);
    expect(styles).toMatch(/\.ledger-project-icon svg\s*\{[^}]*width:\s*19px;[^}]*height:\s*19px;[^}]*stroke-width:\s*1\.65;/u);
    expect(styles).toMatch(/\.is-nav-compact \.ledger-project-block\s*\{[^}]*padding:\s*1px 0 10px;/u);
    expect(styles).toMatch(/\.is-nav-compact \.ledger-project-card\s*\{[^}]*grid-template-columns:\s*32px;[^}]*justify-content:\s*start;[^}]*padding:\s*5px 0 5px 19px;[^}]*border:\s*1px solid transparent;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;/u);
    expect(styles).toMatch(/\.is-nav-compact \.ledger-project-card \.ledger-project-icon\s*\{[^}]*color:\s*#b5b4c8;/u);
    expect(styles).not.toMatch(/\.is-nav-compact \.ledger-project-card\s*\{[^}]*border-left:\s*2px solid #7775ff;/u);
    expect(styles).not.toContain('.ledger-project-monogram');
  });

  test('integrates native window controls without adding a second title bar', () => {
    expect(styles).toMatch(/\.native-window-chrome\s*\{[^}]*position:\s*fixed;[^}]*height:\s*32px;[^}]*pointer-events:\s*none;/u);
    expect(styles).toMatch(/\.native-window-drag-strip\s*\{[^}]*top:\s*7px;[^}]*right:\s*138px;[^}]*left:\s*184px;[^}]*height:\s*12px;[^}]*pointer-events:\s*auto;/u);
    expect(styles).toMatch(/\.native-window-controls\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*46px\);[^}]*pointer-events:\s*auto;/u);
    expect(styles).toMatch(/\[data-native-window="true"\] \.v5-workspace-shell \.route-command-bar\s*\{\s*padding-right:\s*154px;/u);
    expect(styles).toMatch(/\[data-native-window="true"\] \.v5-workspace-shell \.execution-conversation\s*\{\s*padding-top:\s*32px;/u);
    expect(styles).toMatch(/\.native-window-close:hover\s*\{[^}]*background:\s*#c42b1c;[^}]*color:\s*#fff;/u);
  });

  test('uses the composer primary action for the active-turn Stop state', () => {
    expect(styles).toMatch(/\.send-button\.is-stop\s*\{[^}]*background:\s*#353540;/u);
    expect(styles).toMatch(/\.send-button\.is-stop svg:not\(\.lucide-loader-circle\)\s*\{[^}]*fill:\s*currentColor;[^}]*stroke-width:\s*0;/u);
    expect(styles).not.toContain('.send-button.is-steer');
  });

  test('presents project archiving as a reversible secondary action', () => {
    expect(styles).toMatch(/\.project-dialog-archive\s*\{[^}]*min-width:\s*92px;[^}]*border-left:\s*1px solid var\(--hair\);[^}]*background:\s*transparent;/u);
    expect(styles).toMatch(/\.project-archive-confirmation\s*\{[^}]*grid-template-columns:\s*38px minmax\(0,\s*1fr\);[^}]*padding:\s*28px 24px 30px;/u);
    expect(styles).toMatch(/\.settings-archive-item button\s*\{[^}]*min-width:\s*84px;[^}]*height:\s*34px;/u);
    expect(styles).not.toContain('.project-dialog-forget');
  });

  test('bounds expanded work details in their own compact scroll region', () => {
    expect(styles).toMatch(/\.orquesta-activity-group-details\s*\{[^}]*max-height:\s*min\(180px,28vh\);[^}]*overflow-y:\s*auto;[^}]*scrollbar-gutter:\s*stable;/u);
    expect(styles).toMatch(/\.orquesta-activity-row\s*\{[^}]*min-height:\s*24px;[^}]*grid-template-columns:\s*15px minmax\(0,1fr\) auto 13px;/u);
    expect(styles).toMatch(/\.orquesta-activity-command-output pre\s*\{[^}]*max-height:\s*180px;[^}]*overflow:\s*auto;/u);
    expect(styles).not.toContain('.orquesta-activity-detail-body');
    expect(styles).not.toContain('.orquesta-activity-output');
  });

  test('separates navigation dragging from the click-only Work restore handle', () => {
    expect(styles).toMatch(/--navigation-rail-width:\s*56px;/u);
    expect(styles).toMatch(/--navigation-panel-width:\s*184px;/u);
    expect(styles).toMatch(/@property --left-dock-inset\s*\{[^}]*syntax:\s*'<length>';[^}]*inherits:\s*true;[^}]*initial-value:\s*56px;/u);
    expect(styles).toMatch(/\.v5-workspace-shell\s*\{[^}]*transition:\s*grid-template-columns \.22s cubic-bezier\(\.22,\.75,\.18,1\),\s*--left-dock-inset \.22s cubic-bezier\(\.22,\.75,\.18,1\);/u);
    expect(styles).toMatch(/\.v5-workspace-shell\.route-work:not\(\.is-inactive\)\s*\{[^}]*grid-template-columns:\s*var\(--navigation-rail-width\) 0px 0px minmax\(0,\s*1fr\);/u);
    expect(styles).toMatch(/\.v5-workspace-shell\.route-work:not\(\.is-inactive\):not\(\.is-work-ledger-closed\)\s*\{[^}]*grid-template-columns:\s*var\(--navigation-rail-width\) var\(--work-ledger-width\) var\(--work-ledger-divider-width\) minmax\(0,\s*1fr\);/u);
    expect(styles).toMatch(/\.v5-workspace-shell\.route-work:not\(\.is-inactive\) > \.execution-workspace\s*\{[^}]*grid-column:\s*4;/u);
    expect(styles).toMatch(/\.v5-workspace-shell\.route-work\.is-work-ledger-opening:not\(\.is-inactive\)\s*\{[^}]*animation:\s*work-ledger-open \.22s cubic-bezier\(\.22,\.75,\.18,1\) both;/u);
    expect(styles).toMatch(/@keyframes work-ledger-open\s*\{\s*from\s*\{[^}]*grid-template-columns:\s*var\(--navigation-rail-width\) 0px 0px minmax\(0,\s*1fr\);[^}]*\}\s*to\s*\{[^}]*grid-template-columns:\s*var\(--navigation-rail-width\) var\(--work-ledger-width\) var\(--work-ledger-divider-width\) minmax\(0,\s*1fr\);/u);
    expect(styles).toMatch(/\.is-navigation-overlay-open:not\(\.is-inactive\) \.ledger-sidebar\s*\{[^}]*position:\s*absolute;[^}]*width:\s*var\(--navigation-panel-width\);/u);
    expect(styles).toMatch(/\.navigation-resize-segment\s*\{[^}]*touch-action:\s*none;[^}]*cursor:\s*col-resize;[^}]*pointer-events:\s*auto;/u);
    expect(styles).toMatch(/\.work-ledger-edge-handle\s*\{[^}]*left:\s*calc\(50% \+ 8px\);[^}]*width:\s*48px;[^}]*height:\s*280px;[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*cursor:\s*pointer;[^}]*pointer-events:\s*auto;/u);
    expect(styles).toMatch(/\.work-ledger-edge-glyph\s*\{[^}]*width:\s*44px;[^}]*height:\s*240px;[^}]*color:\s*rgba\(73,72,94,\.24\);[^}]*transform:\s*translateX\(-16px\);/u);
    expect(styles).toMatch(/\.work-ledger-edge-glyph svg\s*\{[^}]*width:\s*38px;[^}]*height:\s*240px;[^}]*stroke-width:\s*1\.3;[^}]*transform:\s*scaleX\(2\);/u);
    expect(styles).toMatch(/\.work-ledger-divider\s*\{[^}]*touch-action:\s*none;[^}]*cursor:\s*col-resize;/u);
    expect(styles).not.toContain('.global-navigation-open');
    expect(styles).not.toContain('.global-navigation-close');
    expect(styles).not.toContain('.navigation-overlay-dismiss');
    expect(styles).not.toContain('.work-ledger-close');
    expect(styles).not.toContain('.work-ledger-restore');
    expect(styles).not.toContain('.pane-edge-toggle');
    expect(styles).not.toContain('.sidebar-collapse-toggle');
    expect(styles).not.toContain('.work-ledger-open-button');
  });
});

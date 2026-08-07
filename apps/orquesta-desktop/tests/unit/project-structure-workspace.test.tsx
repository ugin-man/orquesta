import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import type { ProjectStructureUiSnapshot } from '../../src/contracts/orquesta-ui';
import { I18nProvider } from '../../src/renderer/features/i18n/I18nProvider';
import { ProjectStructureWorkspace } from '../../src/renderer/features/settings/ProjectStructureWorkspace';

const structure: ProjectStructureUiSnapshot = {
  available: true,
  status: 'healthy',
  generatedAt: '2026-08-01T10:20:28.873Z',
  indexedFileCount: 1362,
  canonicalSourceCount: 1,
  lifecycleCounts: { current: 1344, superseded: 0, archived: 18, quarantined: 0, deleteCandidate: 0 },
  issueCounts: { error: 0, warning: 0, suggestion: 1 },
  canonicalSources: [{ sourceRef: '.orquesta/project/layout.json', componentId: 'runtime-state', lifecycle: 'current', authority: 'canonical', readPolicy: 'task_candidate' }],
  retiredSources: [{ sourceRef: '.orquesta/archive/state.json.bak', componentId: 'runtime-state', lifecycle: 'archived', authority: 'supporting', readPolicy: 'explicit_only' }],
  issues: [{ severity: 'suggestion', code: 'duplicate_current_content', message: 'Two icon files have identical content.', sourceRefs: ['assets/orquesta.ico', 'public/favicon.ico'] }],
  specialistContexts: [{ taskId: 'T-STRUCTURE', taskTitle: 'Inspect project structure', ownerAgentId: 'implementation-001', taskState: 'in_progress', active: true, requiredReading: ['docs/design.md'] }],
  contextOverview: { viewId: 'PSCV-0123456789abcdef', candidateSourceCount: 736, excludedSourceCount: 605, warnings: [] },
  migration: { planId: 'PSMP-0123456789abcdef', resultId: 'PSMR-0123456789abcdef', status: 'applied', operationCount: 18, destructiveOperationCount: 0, approvalDecision: 'accepted', appliedAt: '2026-08-01T10:19:46.668Z', verificationStatus: 'passed', rollbackStepCount: 18 },
  limitation: null
};

function renderWorkspace() {
  return render(<I18nProvider initialLocale="ja"><ProjectStructureWorkspace structure={structure} /></I18nProvider>);
}

describe('ProjectStructureWorkspace', () => {
  test('keeps the structure summary bounded and switches between the five views', async () => {
    const user = userEvent.setup();
    renderWorkspace();

    expect(screen.getByText('1362')).toBeVisible();
    expect(screen.getByText('.orquesta/project/layout.json')).toBeVisible();

    await user.click(screen.getByRole('button', { name: /旧版と隔離/ }));
    expect(screen.getByText('.orquesta/archive/state.json.bak')).toBeVisible();

    await user.click(screen.getByRole('button', { name: /構造警告/ }));
    expect(screen.getByText('duplicate_current_content')).toBeVisible();

    await user.click(screen.getByRole('button', { name: /専門家の資料/ }));
    expect(screen.getByText('T-STRUCTURE')).toBeVisible();
    expect(screen.getByText('docs/design.md')).toBeVisible();

    await user.click(screen.getByRole('button', { name: /Migration Plan/ }));
    expect(screen.getByText('PSMP-0123456789abcdef')).toBeVisible();
    expect(screen.getByText('PSMR-0123456789abcdef')).toBeVisible();
    expect(screen.getByText('通過')).toBeVisible();
  });

  test('explains that Core data is unavailable instead of inventing state', () => {
    render(<I18nProvider initialLocale="en"><ProjectStructureWorkspace /></I18nProvider>);
    expect(screen.getByText(/does not have a structure inventory yet/i)).toBeVisible();
  });
});

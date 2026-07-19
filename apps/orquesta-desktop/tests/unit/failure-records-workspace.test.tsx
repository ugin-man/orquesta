import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import type { FailureUiModel } from '../../src/contracts/orquesta-ui';
import { I18nProvider } from '../../src/renderer/features/i18n/I18nProvider';
import {
  createDefaultFailureRecordView,
  FailureRecordsWorkspace,
  type FailureRecordView
} from '../../src/renderer/features/records/FailureRecordsWorkspace';

const failures: FailureUiModel[] = [
  {
    id: 'FC1', source: 'cluster', failureClass: 'network.timeout', title: 'Network timeout', summary: 'The source timed out repeatedly.',
    severity: 'high', status: 'open', resolution: 'open', occurrenceCount: 4,
    firstOccurredAt: '2026-07-18T09:00:00Z', lastOccurredAt: '2026-07-19T10:00:00Z', taskIds: ['T1', 'T2'], sourceAgentIds: ['connector'],
    suspectedOwner: 'shared', repairStatus: 'waiting', cause: 'The remote source stopped responding.', fix: 'Retry after the source recovers.',
    prevention: ['Use a bounded retry.'], evidence: ['timeout 1', 'timeout 2'],
    occurrences: [
      { id: 'IC2', source: 'candidate', status: 'clustered', summary: 'Second timeout.', occurredAt: '2026-07-19T10:00:00Z', taskId: 'T2', sourceAgentId: 'connector', evidence: ['timeout 2'], attemptedFixes: ['Changed endpoint.'], outcome: null },
      { id: 'IC1', source: 'candidate', status: 'clustered', summary: 'First timeout.', occurredAt: '2026-07-18T09:00:00Z', taskId: 'T1', sourceAgentId: 'connector', evidence: ['timeout 1'], attemptedFixes: [], outcome: null }
    ]
  },
  {
    id: 'failure-class:filesystem.lock', source: 'incident', failureClass: 'filesystem.lock', title: 'State lock failed', summary: 'Could not create the lock.',
    severity: 'medium', status: 'open', resolution: 'open', occurrenceCount: 1,
    firstOccurredAt: '2026-07-19T08:00:00Z', lastOccurredAt: '2026-07-19T08:00:00Z', taskIds: ['T3'], sourceAgentIds: ['coder'],
    suspectedOwner: 'codex', repairStatus: 'open', cause: 'Another process held the file.', fix: null, prevention: [], evidence: ['EACCES'],
    occurrences: [{ id: 'F1', source: 'incident', status: 'open', summary: 'Could not create the lock.', occurredAt: '2026-07-19T08:00:00Z', taskId: 'T3', sourceAgentId: 'coder', evidence: ['EACCES'], attemptedFixes: ['Retried once.'], outcome: null }]
  },
  {
    id: 'failure-class:encoding.corruption', source: 'incident', failureClass: 'encoding.corruption', title: 'Encoding repaired', summary: 'The JSON file was rebuilt.',
    severity: 'medium', status: 'resolved', resolution: 'resolved', occurrenceCount: 1,
    firstOccurredAt: '2026-07-17T08:00:00Z', lastOccurredAt: '2026-07-17T08:00:00Z', taskIds: ['T0'], sourceAgentIds: ['orchestrator'],
    suspectedOwner: 'codex', repairStatus: 'resolved', cause: 'The file was not UTF-8.', fix: 'Rebuilt the file as UTF-8.', prevention: ['Read with explicit UTF-8.'], evidence: ['JSON parsed.'],
    occurrences: [{ id: 'F0', source: 'incident', status: 'resolved', summary: 'The JSON file was rebuilt.', occurredAt: '2026-07-17T08:00:00Z', taskId: 'T0', sourceAgentId: 'orchestrator', evidence: ['JSON parsed.'], attemptedFixes: [], outcome: 'Rebuilt the file as UTF-8.' }]
  },
  {
    id: 'IC9', source: 'candidate', failureClass: 'browser.runtime', title: 'Browser startup candidate', summary: 'Startup returned an unclassified error.',
    severity: 'low', status: 'candidate', resolution: 'open', occurrenceCount: 1,
    firstOccurredAt: '2026-07-19T07:00:00Z', lastOccurredAt: '2026-07-19T07:00:00Z', taskIds: ['T4'], sourceAgentIds: ['reviewer'],
    suspectedOwner: 'unknown', repairStatus: 'candidate', cause: null, fix: null, prevention: [], evidence: ['systemError'],
    occurrences: [{ id: 'IC9', source: 'candidate', status: 'candidate', summary: 'Startup returned an unclassified error.', occurredAt: '2026-07-19T07:00:00Z', taskId: 'T4', sourceAgentId: 'reviewer', evidence: ['systemError'], attemptedFixes: [], outcome: null }]
  }
];

function Harness({ initialView = createDefaultFailureRecordView() }: { initialView?: FailureRecordView }) {
  const [view, setView] = useState(initialView);
  return <I18nProvider initialLocale="en"><FailureRecordsWorkspace failures={failures} view={view} onViewChange={setView} /></I18nProvider>;
}

describe('FailureRecordsWorkspace', () => {
  test('switches unresolved, repeated, resolved, and all records without mixing their meaning', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const scopes = screen.getByRole('navigation', { name: 'Failure scopes' });
    expect(within(scopes).getByRole('button', { name: 'Unresolved 3' })).toHaveAttribute('aria-current', 'page');
    expect(within(scopes).getByRole('button', { name: 'Repeated 1' })).toBeVisible();
    expect(within(scopes).getByRole('button', { name: 'Resolved 1' })).toBeVisible();
    expect(within(scopes).getByRole('button', { name: 'All 4' })).toBeVisible();
    expect(screen.getByRole('button', { name: /FC1 · Network timeout/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /encoding.corruption/ })).not.toBeInTheDocument();

    await user.click(within(scopes).getByRole('button', { name: 'Repeated 1' }));
    expect(screen.getByRole('button', { name: /FC1 · Network timeout/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /filesystem.lock/ })).not.toBeInTheDocument();

    await user.click(within(scopes).getByRole('button', { name: 'Resolved 1' }));
    expect(screen.getByRole('button', { name: /encoding.corruption/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /FC1 · Network timeout/ })).not.toBeInTheDocument();
  });

  test('searches and filters the comparison list, then shows provenance and repair detail', async () => {
    const user = userEvent.setup();
    render(<Harness initialView={{ ...createDefaultFailureRecordView(), scope: 'all' }} />);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Severity' }), 'low');
    expect(screen.getByText('Candidate')).toBeVisible();
    expect(screen.getByRole('button', { name: /IC9 · Browser startup candidate/ })).toBeVisible();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Severity' }), 'all');
    await user.type(screen.getByRole('searchbox', { name: 'Search errors' }), 'T2');
    expect(screen.getByRole('button', { name: /FC1 · Network timeout/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /filesystem.lock/ })).not.toBeInTheDocument();

    await user.clear(screen.getByRole('searchbox', { name: 'Search errors' }));
    await user.click(screen.getByRole('button', { name: /FC1 · Network timeout/ }));
    const detail = screen.getByRole('region', { name: 'Failure FC1 detail' });
    expect(within(detail).getByText('4 occurrences')).toBeVisible();
    expect(within(detail).getByText('Changed endpoint.')).toBeVisible();
    expect(within(detail).getByText('Retry after the source recovers.')).toBeVisible();
  });
});

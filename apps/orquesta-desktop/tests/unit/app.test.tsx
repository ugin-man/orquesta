import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { BridgeEvent, ConversationPage } from '../../src/contracts/bridge';
import type { FailureUiModel, OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { MockOrquestaBridge } from '../../src/bridges/mock-bridge';
import { fixtureCatalog } from '../../src/fixtures';
import { attention } from '../../src/fixtures/helpers';
import { DesktopRendererApp, resolveInitialLocale } from '../../src/renderer/app/DesktopRendererApp';
import { writeHomeTutorialPreference } from '../../src/renderer/features/tutorial/home-tutorial-model';

describe('DesktopRendererApp', () => {
  test('reports startup readiness once after the snapshot is prepared', async () => {
    const onStartupReady = vi.fn();

    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} onStartupReady={onStartupReady} />);

    await screen.findByText('Demo data');
    await waitFor(() => expect(onStartupReady).toHaveBeenCalledTimes(1));
  });

  test('reports startup readiness when the recovery screen is prepared', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    vi.spyOn(bridge, 'getInitialSnapshot').mockRejectedValue(new Error('broken snapshot'));
    const onStartupReady = vi.fn();

    render(<DesktopRendererApp bridge={bridge} initialLocale="en" onStartupReady={onStartupReady} />);

    await screen.findByText('Renderer snapshot unavailable');
    await waitFor(() => expect(onStartupReady).toHaveBeenCalledTimes(1));
  });

  test('uses a persisted locale unless an explicit locale is supplied', () => {
    window.localStorage.setItem('orquesta.desktop.locale', 'ja');
    expect(resolveInitialLocale()).toBe('ja');
    expect(resolveInitialLocale('en')).toBe('en');
    window.localStorage.removeItem('orquesta.desktop.locale');
  });

  test('distinguishes project loading from the no-project onboarding state', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    const base = await bridge.getInitialSnapshot();
    let resolveSnapshot!: (snapshot: OrquestaUiSnapshot) => void;
    vi.spyOn(bridge, 'getInitialSnapshot').mockReturnValue(new Promise((resolve) => { resolveSnapshot = resolve; }));
    render(<DesktopRendererApp bridge={bridge} initialLocale="ja" />);

    expect(screen.getByText('プロジェクトを読み込み中…')).toBeVisible();
    await act(async () => resolveSnapshot({ ...base, project: { ...base.project, id: 'no-project', title: 'No project' } }));
    expect(await screen.findByRole('heading', { name: '最初のOrquestaプロジェクトを開く' })).toBeVisible();
  });

  test('shows a bounded recovery screen when the repository snapshot fails', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    vi.spyOn(bridge, 'getInitialSnapshot').mockRejectedValue(new Error('tasks.json is malformed'));
    render(<DesktopRendererApp bridge={bridge} initialLocale="en" />);

    expect(await screen.findByText('Renderer snapshot unavailable')).toBeVisible();
    expect(screen.getByText('tasks.json is malformed')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open project folder' })).toBeVisible();
  });

  test('leaves the recovery screen when opening another project publishes a valid snapshot', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    const recovered = await bridge.getInitialSnapshot();
    let publish!: (event: BridgeEvent) => void;
    vi.spyOn(bridge, 'getInitialSnapshot').mockRejectedValue(new Error('agents.json is malformed'));
    vi.spyOn(bridge, 'subscribe').mockImplementation((listener) => { publish = listener; return () => undefined; });
    render(<DesktopRendererApp bridge={bridge} initialLocale="en" />);

    expect(await screen.findByText('Renderer snapshot unavailable')).toBeVisible();
    act(() => publish({ type: 'snapshot_changed', snapshot: recovered }));

    expect(await screen.findByText('Demo data')).toBeVisible();
    expect(screen.queryByText('Renderer snapshot unavailable')).not.toBeInTheDocument();
  });

  test('recovers the first-project action when the folder picker throws', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    const base = await bridge.getInitialSnapshot();
    vi.spyOn(bridge, 'getInitialSnapshot').mockResolvedValue({ ...base, project: { ...base.project, id: 'no-project', title: 'No project' } });
    vi.spyOn(bridge, 'requestOpenProject').mockRejectedValue(new Error('Project picker disconnected'));
    render(<DesktopRendererApp bridge={bridge} initialLocale="en" />);

    const open = await screen.findByRole('button', { name: 'Open project folder' });
    await userEvent.click(open);
    expect(await screen.findByText('Project picker disconnected')).toBeVisible();
    expect(open).toBeEnabled();
  });

  test('restores the project draft after relaunch', async () => {
    window.localStorage.setItem('orquesta.desktop.draft.active-project', 'Continue the implementation');
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Continue the implementation'));
    window.localStorage.removeItem('orquesta.desktop.draft.active-project');
  });

  test('labels demo data and opens an agent inspector', async () => {
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} />);
    expect(await screen.findByText('Demo data')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Analyst, Working' }));
    expect(screen.getByLabelText('Analyst detail')).toBeVisible();
  });

  test('uses repository display state instead of real-data presence for the top status', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    const base = await bridge.getInitialSnapshot();
    vi.spyOn(bridge, 'getInitialSnapshot').mockResolvedValue({
      ...base,
      project: {
        ...base.project,
        isDemoData: false,
        repositoryDisplayState: 'snapshot'
      }
    });

    const { container } = render(<DesktopRendererApp bridge={bridge} initialLocale="en" />);

    expect(await screen.findByText('Repository state loaded')).toBeVisible();
    expect(container.querySelector('.repository-status-pill--snapshot')).not.toBeNull();
    expect(container.querySelector('.repository-status-pill--watching')).toBeNull();
  });

  test('does not expose active edge motion for dispatch-only evidence', async () => {
    const { container } = render(<DesktopRendererApp bridge={new MockOrquestaBridge('unknown-evidence')} />);
    await screen.findByText('Demo data');
    await waitFor(() => expect(container.querySelectorAll('.map-edge-flow')).toHaveLength(0));
  });

  test('keeps four workspaces in one persistent dock', async () => {
    const user = userEvent.setup();
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="ja" />);

    const navigation = await screen.findByRole('navigation', { name: 'ワークスペース' });
    expect(within(navigation).getByRole('button', { name: 'Home' })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: /ユーザータスク/ })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: '記録' })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: '設定' })).toBeVisible();
    expect(within(navigation).queryByRole('button', { name: 'その他' })).not.toBeInTheDocument();

    await user.click(within(navigation).getByRole('button', { name: /ユーザータスク/ }));
    expect(screen.getByRole('heading', { name: 'ユーザータスク' })).toBeVisible();
    expect(screen.queryByLabelText('Orquesta map')).not.toBeInTheDocument();
  });

  test('launches a temporary inspection from Team Management without approving a role', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    const startInspection = vi.spyOn(bridge, 'startInspection');
    const approveAgentProposal = vi.spyOn(bridge, 'approveAgentProposal');
    render(<DesktopRendererApp bridge={bridge} initialLocale="ja" />);

    await userEvent.click(await screen.findByRole('button', { name: 'チーム管理' }));
    await userEvent.click(screen.getByRole('button', { name: '外部比較を起動' }));

    await waitFor(() => expect(startInspection).toHaveBeenCalledWith({
      kind: 'external_benchmark', target: { kind: 'project', ids: [] }, focus: null
    }));
    expect(await screen.findByRole('button', { name: '外部比較を中止' })).toBeVisible();
    expect(approveAgentProposal).not.toHaveBeenCalled();
  });

  test('opens an inspection detail from the map and cancels it without opening Team Management', async () => {
    const bridge = new MockOrquestaBridge('inspection-running');
    const cancelInspection = vi.spyOn(bridge, 'cancelInspection');
    render(<DesktopRendererApp bridge={bridge} initialLocale="ja" />);

    await userEvent.click(await screen.findByRole('button', { name: '敵対監査, 実行中' }));

    expect(await screen.findByRole('complementary', { name: '敵対監査の詳細' })).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'チーム管理' })).not.toBeInTheDocument();
    expect(screen.getByText('Two independent production lines')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: '敵対監査を中止' }));

    await waitFor(() => expect(cancelInspection).toHaveBeenCalledWith('AUDIT-RUNNING'));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: '敵対監査の詳細' })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '敵対監査, 実行中' })).not.toBeInTheDocument();
  });
  test('opens a Team Management inspection report in the Records inspection workspace', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    const snapshot = await bridge.getInitialSnapshot();
    const completedRun = {
      runId: 'AUDIT-001', kind: 'adversarial_audit' as const, displayName: 'Adversarial audit', status: 'report_ready' as const,
      target: { kind: 'project' as const, ids: [], label: snapshot.project.title }, focus: null, threadId: 'thread-audit', turnId: 'turn-audit',
      reportPath: '.orquesta/reports/inspections/AUDIT-001.md', sourceCount: 0, errorCode: null, errorMessage: null,
      createdAt: '2026-07-21T10:00:00.000Z', completedAt: '2026-07-21T10:01:00.000Z'
    };
    snapshot.inspectionRuns = [completedRun];
    snapshot.inspectionTemplates = snapshot.inspectionTemplates.map((template) => template.kind === 'adversarial_audit'
      ? { ...template, lastReportRunId: completedRun.runId }
      : template);
    vi.spyOn(bridge, 'getInitialSnapshot').mockResolvedValue(snapshot);
    vi.spyOn(bridge, 'readInspectionReport').mockResolvedValue({ runId: completedRun.runId, markdown: '## Audit finding\n\nNo critical issue.' });
    render(<DesktopRendererApp bridge={bridge} initialLocale="ja" />);

    await userEvent.click(await screen.findByRole('button', { name: 'チーム管理' }));
    await userEvent.click(screen.getByRole('button', { name: '敵対監査の直近レポート' }));

    expect(await screen.findByRole('button', { name: '検査' })).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByRole('dialog', { name: '敵対監査レポート' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Audit finding' })).toBeVisible();
  });

  test('uses the unresolved user task count for the only dock badge', async () => {
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);
    const navigation = await screen.findByRole('navigation', { name: 'Workspaces' });
    expect(within(navigation).getByRole('button', { name: 'User Tasks 3' })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: 'Records' })).toBeVisible();
  });

  test('updates the User Tasks count only after the canonical snapshot changes', async () => {
    const user = userEvent.setup();
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);
    const navigation = await screen.findByRole('navigation', { name: 'Workspaces' });

    await user.click(within(navigation).getByRole('button', { name: 'User Tasks 3' }));
    await user.type(screen.getByRole('textbox', { name: 'Answer' }), 'Ship the foundation first.');
    await user.click(screen.getByRole('button', { name: 'Send answer' }));

    expect(await within(navigation).findByRole('button', { name: 'User Tasks 2' })).toBeVisible();
  });

  test('routes a repository-backed response to its source agent when direct resolution is unsupported', async () => {
    const user = userEvent.setup();
    const bridge = new MockOrquestaBridge('active-project');
    vi.spyOn(bridge, 'resolveAttentionItem').mockResolvedValue({ status: 'unsupported', correlationId: 'unsupported-1', reason: 'Canonical state is read-only.', retryable: false });
    const sendMessage = vi.spyOn(bridge, 'sendMessage').mockResolvedValue({ status: 'accepted', correlationId: 'sent-1' });
    render(<DesktopRendererApp bridge={bridge} initialLocale="en" />);

    await user.click(await screen.findByRole('button', { name: 'User Tasks 3' }));
    await user.type(screen.getByRole('textbox', { name: 'Answer' }), 'Keep the scope narrow.');
    await user.click(screen.getByRole('button', { name: 'Send answer' }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      targetAgentId: 'analyst',
      text: expect.stringContaining('Keep the scope narrow.')
    })));
    expect(screen.getByText('Sent · waiting for update')).toBeVisible();
  });

  test('keeps project switching on Home instead of competing with workspace headings', async () => {
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);
    const navigation = await screen.findByRole('navigation', { name: 'Workspaces' });
    expect(screen.getByLabelText('Project launcher')).toBeVisible();

    await userEvent.click(within(navigation).getByRole('button', { name: /User Tasks/ }));
    expect(screen.queryByLabelText('Project launcher')).not.toBeInTheDocument();

    await userEvent.click(within(navigation).getByRole('button', { name: 'Home' }));
    expect(screen.getByLabelText('Project launcher')).toBeVisible();
  });

  test('opens the temporary Luca question panel from Home', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    render(<DesktopRendererApp bridge={bridge} initialLocale="en" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Ask Luca' }));
    const luca = screen.getByRole('complementary', { name: 'Luca' });
    expect(within(luca).getByRole('button', { name: 'Ask freely' })).toBeVisible();
    await userEvent.click(within(luca).getByRole('button', { name: 'What is happening now?' }));

    expect(await within(luca).findByText('これはプロトタイプのLuca回答です。現在のプロジェクト記録だけを説明しています。')).toBeVisible();
  });
  test('opens active work as a Home quick view before navigating to Records', async () => {
    const user = userEvent.setup();
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);

    await user.click(await screen.findByRole('button', { name: 'View all work' }));

    const quickView = screen.getByRole('dialog', { name: 'Active work' });
    expect(quickView).toBeVisible();
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');

    await user.click(within(quickView).getByRole('button', { name: 'View all Records' }));
    expect(screen.getByRole('button', { name: 'Records' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('dialog', { name: 'Active work' })).not.toBeInTheDocument();
  });

  test('opens User Tasks as a Home quick view before navigating to the full workspace', async () => {
    const user = userEvent.setup();
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);

    await user.click(await screen.findByRole('button', { name: 'Open all User Tasks' }));

    const quickView = screen.getByRole('dialog', { name: 'User Tasks' });
    expect(quickView).toBeVisible();
    expect(within(quickView).getByText('Approve data access plan.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');

    await user.click(within(quickView).getByRole('button', { name: 'View all User Tasks' }));
    expect(screen.getByRole('button', { name: 'User Tasks 3' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('dialog', { name: 'User Tasks' })).not.toBeInTheDocument();
  });

  test('shows taskless canonical attention in the inline User Tasks detail', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    const base = await bridge.getInitialSnapshot();
    vi.spyOn(bridge, 'getInitialSnapshot').mockResolvedValue({
      ...base,
      attention: [attention({ id: 'UT1', type: 'repair', actionKind: 'do', title: 'Run local check', summary: 'Open the packaged app.' })]
    });
    render(<DesktopRendererApp bridge={bridge} initialLocale="en" />);

    await userEvent.click(await screen.findByRole('button', { name: 'User Tasks 1' }));
    const detail = screen.getByRole('region', { name: 'User task detail' });
    expect(within(detail).getByRole('heading', { name: 'Run local check' })).toBeVisible();
    expect(screen.queryByLabelText('Attention action UT1')).not.toBeInTheDocument();
  });

  test('keeps a task visible in User Tasks when its referenced task is missing', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    const base = await bridge.getInitialSnapshot();
    vi.spyOn(bridge, 'getInitialSnapshot').mockResolvedValue({
      ...base,
      attention: [attention({ id: 'UT-DANGLING', taskId: 'PRUNED-9', type: 'question', title: 'Clarify pruned work', summary: 'The source task is no longer in the snapshot.' })]
    });
    render(<DesktopRendererApp bridge={bridge} initialLocale="en" />);

    await userEvent.click(await screen.findByRole('button', { name: 'User Tasks 1' }));
    const detail = screen.getByRole('region', { name: 'User task detail' });
    expect(within(detail).getByRole('heading', { name: 'Clarify pruned work' })).toBeVisible();
    expect(within(detail).getByText('PRUNED-9')).toBeVisible();
  });

  test('keeps tasks, errors, conversation, decisions, and timeline inside Records', async () => {
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Records' }));
    const types = screen.getByRole('navigation', { name: 'Record types' });
    expect(within(types).getByRole('button', { name: 'Tasks' })).toBeVisible();
    expect(within(types).getByRole('button', { name: 'Errors' })).toBeVisible();
    expect(within(types).getByRole('button', { name: 'Conversation' })).toBeVisible();
    expect(within(types).getByRole('button', { name: 'Decisions' })).toBeVisible();
    expect(within(types).getByRole('button', { name: 'Timeline' })).toBeVisible();
  });

  test('opens task records inline and deep-links Home work into the selected task', async () => {
    const user = userEvent.setup();
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);

    await user.click(await screen.findByRole('button', { name: 'Records' }));
    expect(screen.getByLabelText('Task summary')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /T70 · Implement parser/ }));
    expect(screen.getByRole('dialog', { name: 'Task T70 detail' })).toBeVisible();
    expect(screen.queryByLabelText('Task T70')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Home' }));
    const now = await screen.findByLabelText('NOW');
    await user.click(within(now).getByRole('button', { name: /T68/ }));
    expect(screen.getByRole('button', { name: 'Records' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('dialog', { name: 'Task T68 detail' })).toBeVisible();
  });

  test('review revision uses failure cards with modal detail and preserves the selected scope', async () => {
    const user = userEvent.setup();
    const bridge = new MockOrquestaBridge('active-project');
    const base = await bridge.getInitialSnapshot();
    const failures: FailureUiModel[] = [
      {
        id: 'FC-REPEAT', source: 'cluster', failureClass: 'network.timeout', title: 'Repeated network timeout', summary: 'The source timed out twice.', severity: 'high', status: 'open', resolution: 'open', occurrenceCount: 2,
        firstOccurredAt: '2026-07-18T09:00:00Z', lastOccurredAt: '2026-07-19T09:00:00Z', taskIds: ['T66'], sourceAgentIds: ['connector'], suspectedOwner: 'shared', repairStatus: 'waiting', cause: 'Remote source unavailable.', fix: 'Retry after recovery.', prevention: [], evidence: ['timeout'],
        occurrences: [{ id: 'IC-1', source: 'candidate', status: 'clustered', summary: 'Timeout.', occurredAt: '2026-07-19T09:00:00Z', taskId: 'T66', sourceAgentId: 'connector', evidence: ['timeout'], attemptedFixes: [], outcome: null }]
      },
      {
        id: 'failure-class:encoding.corruption', source: 'incident', failureClass: 'encoding.corruption', title: 'Encoding repaired', summary: 'The state file was rebuilt.', severity: 'medium', status: 'resolved', resolution: 'resolved', occurrenceCount: 1,
        firstOccurredAt: '2026-07-17T09:00:00Z', lastOccurredAt: '2026-07-17T09:00:00Z', taskIds: ['T64'], sourceAgentIds: ['orchestrator'], suspectedOwner: 'codex', repairStatus: 'resolved', cause: 'Invalid encoding.', fix: 'Rebuilt as UTF-8.', prevention: ['Read explicitly as UTF-8.'], evidence: ['JSON parsed.'],
        occurrences: [{ id: 'F-OLD', source: 'incident', status: 'resolved', summary: 'The state file was rebuilt.', occurredAt: '2026-07-17T09:00:00Z', taskId: 'T64', sourceAgentId: 'orchestrator', evidence: ['JSON parsed.'], attemptedFixes: [], outcome: 'Rebuilt as UTF-8.' }]
      }
    ];
    vi.spyOn(bridge, 'getInitialSnapshot').mockResolvedValue({ ...base, failures });
    render(<DesktopRendererApp bridge={bridge} initialLocale="en" />);

    await user.click(await screen.findByRole('button', { name: 'Records' }));
    await user.click(screen.getByRole('button', { name: 'Errors' }));
    const scope = screen.getByLabelText('Failure scope');
    expect(scope).toHaveValue('open');
    await user.selectOptions(scope, 'resolved');
    expect(screen.getByTestId('failure-record-grid')).toBeVisible();
    await user.click(screen.getByRole('button', { name: /encoding.corruption/ }));
    expect(screen.getByRole('dialog', { name: 'Failure failure-class:encoding.corruption detail' })).toHaveTextContent('Rebuilt as UTF-8.');
    await user.click(screen.getByTestId('failure-record-modal-backdrop'));
    expect(screen.queryByRole('dialog', { name: 'Failure failure-class:encoding.corruption detail' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Tasks' }));
    await user.click(screen.getByRole('button', { name: 'Errors' }));
    expect(screen.getByLabelText('Failure scope')).toHaveValue('resolved');
  });

  test('uses the conversation workspace to switch logical targets and show the real delivery route', async () => {
    const user = userEvent.setup();
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);
    await user.click(await screen.findByRole('button', { name: 'Records' }));
    await user.click(screen.getByRole('button', { name: 'Conversation' }));

    const channels = await screen.findByRole('navigation', { name: 'Conversation channels' });
    expect(within(channels).getByText('Coordinator')).toBeVisible();
    expect(within(channels).getByText('Agent routes')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Conversation · Orchestrator' })).toBeVisible();
    expect(screen.getByText('Actual delivery')).toBeVisible();
    expect(screen.getByText('Coordinator Codex thread')).toBeVisible();
    expect(screen.getByText('Direct coordinator message')).toBeVisible();

    await user.click(within(channels).getByRole('button', { name: 'Analyst · Analyst' }));
    expect(await screen.findByRole('heading', { name: 'Conversation · Analyst' })).toBeVisible();
    expect(screen.getByText('agent_id=analyst')).toBeVisible();
    expect(screen.getByText('The analysis route is active.')).toBeVisible();
    expect(screen.getByLabelText('Target agent')).toHaveValue('analyst');
  });

  test('keeps Luca available as an independent read-only conversation channel', async () => {
    const user = userEvent.setup();
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);
    await user.click(await screen.findByRole('button', { name: 'Records' }));
    await user.click(screen.getByRole('button', { name: 'Conversation' }));

    const channels = await screen.findByRole('navigation', { name: 'Conversation channels' });
    await user.click(within(channels).getByRole('button', { name: 'Luca · Project explainer' }));

    expect(await screen.findByRole('heading', { name: 'Conversation · Luca' })).toBeVisible();
    expect(screen.getByText('Luca Codex thread')).toBeVisible();
    expect(screen.getByText('Read-only project explanation')).toBeVisible();
  });

  test('shows resolved user decisions with filters and the recorded outcome', async () => {
    const user = userEvent.setup();
    const bridge = new MockOrquestaBridge('active-project');
    const listAttentionHistory = vi.spyOn(bridge, 'listAttentionHistory');
    render(<DesktopRendererApp bridge={bridge} initialLocale="en" />);

    await user.click(await screen.findByRole('button', { name: 'Records' }));
    await user.click(screen.getByRole('button', { name: 'Decisions' }));

    const filters = await screen.findByRole('navigation', { name: 'Decision types' });
    expect(within(filters).getByRole('button', { name: 'All 2' })).toBeVisible();
    expect(within(filters).getByRole('button', { name: 'Answers 1' })).toBeVisible();
    expect(within(filters).getByRole('button', { name: 'Approvals 0' })).toBeVisible();
    expect(within(filters).getByRole('button', { name: 'Reviews 1' })).toBeVisible();
    expect(within(filters).getByRole('button', { name: 'Manual work 0' })).toBeVisible();
    expect(listAttentionHistory).toHaveBeenCalledOnce();

    const detail = screen.getByRole('region', { name: 'Decision detail' });
    expect(within(detail).getByRole('heading', { name: 'Question answered' })).toBeVisible();
    expect(within(detail).getByText('Confirm the approved reference image.')).toBeVisible();
    expect(within(detail).getByText('Image attached')).toBeVisible();
    expect(within(detail).getByText('T69')).toBeVisible();
    expect(within(detail).getAllByText('Not recorded')).toHaveLength(2);

    await user.click(within(filters).getByRole('button', { name: 'Reviews 1' }));
    expect(within(detail).getByRole('heading', { name: 'Report accepted' })).toBeVisible();
  });

  test('aggregates the project timeline and opens the matching primary record', async () => {
    const user = userEvent.setup();
    const bridge = new MockOrquestaBridge('active-project');
    const listConversation = vi.spyOn(bridge, 'listConversation');
    render(<DesktopRendererApp bridge={bridge} initialLocale="en" />);

    await user.click(await screen.findByRole('button', { name: 'Records' }));
    await user.click(screen.getByRole('button', { name: 'Timeline' }));

    const filters = await screen.findByRole('navigation', { name: 'Timeline types' });
    expect(within(filters).getByRole('button', { name: 'All 13' })).toBeVisible();
    expect(within(filters).getByRole('button', { name: 'Tasks 6' })).toBeVisible();
    expect(within(filters).getByRole('button', { name: 'Errors 3' })).toBeVisible();
    expect(within(filters).getByRole('button', { name: 'Conversation 2' })).toBeVisible();
    expect(within(filters).getByRole('button', { name: 'Decisions 2' })).toBeVisible();
    expect(listConversation).toHaveBeenCalledWith({ targetAgentId: 'orchestrator', cursor: null, limit: 100 });
    expect(listConversation).toHaveBeenCalledWith({ targetAgentId: 'analyst', cursor: null, limit: 100 });
    expect(screen.getByText('3 messages · Build the approved desktop Renderer and keep the Electron boundary clean.')).toBeVisible();

    await user.click(within(filters).getByRole('button', { name: 'Errors 3' }));
    await user.click(screen.getByRole('button', { name: 'Error · FC66 · External API timeout' }));

    expect(screen.getByRole('button', { name: 'Errors' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('dialog', { name: 'Failure FC66 detail' })).toBeVisible();
  });

  test('review revision bounds a large timeline to 200 rendered records at a time', async () => {
    const user = userEvent.setup();
    const bridge = new MockOrquestaBridge('active-project');
    const base = await bridge.getInitialSnapshot();
    const seed = base.tasks[0]!;
    const tasks = Array.from({ length: 450 }, (_, index) => ({ ...seed, id: `TL${String(index + 1).padStart(4, '0')}`, title: `Timeline task ${index + 1}` }));
    vi.spyOn(bridge, 'getInitialSnapshot').mockResolvedValue({ ...base, tasks });
    render(<DesktopRendererApp bridge={bridge} initialLocale="en" />);

    await user.click(await screen.findByRole('button', { name: 'Records' }));
    await user.click(screen.getByRole('button', { name: 'Timeline' }));

    expect(await screen.findByLabelText('200 of 457 events')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show 200 more' }));
    expect(screen.getByLabelText('400 of 457 events')).toBeVisible();
  }, 10_000);

  test('closes stale conversation content when its agent disappears from the same project', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    const base = await bridge.getInitialSnapshot();
    let publish!: (event: BridgeEvent) => void;
    vi.spyOn(bridge, 'subscribe').mockImplementation((listener) => { publish = listener; return () => undefined; });
    render(<DesktopRendererApp bridge={bridge} initialLocale="en" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Records' }));
    await userEvent.click(screen.getByRole('button', { name: 'Conversation' }));
    await userEvent.selectOptions(screen.getByLabelText('Target agent'), 'analyst');
    expect(await screen.findByRole('heading', { name: 'Conversation · Analyst' })).toBeVisible();

    act(() => publish({ type: 'snapshot_changed', snapshot: { ...base, agents: base.agents.filter((agent) => agent.id !== 'analyst') } }));
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('heading', { name: 'Conversation · Analyst' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Target agent')).toHaveValue('orchestrator');
  });

  test('ignores a delayed conversation response after its requested agent disappears', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    const base = await bridge.getInitialSnapshot();
    const listConversation = bridge.listConversation.bind(bridge);
    let publish!: (event: BridgeEvent) => void;
    let resolveAnalyst!: (page: ConversationPage) => void;
    vi.spyOn(bridge, 'subscribe').mockImplementation((listener) => { publish = listener; return () => undefined; });
    vi.spyOn(bridge, 'listConversation').mockImplementation((query) => query.targetAgentId === 'analyst'
      ? new Promise((resolve) => { resolveAnalyst = resolve; })
      : listConversation(query));
    render(<DesktopRendererApp bridge={bridge} initialLocale="en" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Records' }));
    await userEvent.click(screen.getByRole('button', { name: 'Conversation' }));
    expect(await screen.findByRole('heading', { name: 'Conversation · Orchestrator' })).toBeVisible();
    await userEvent.selectOptions(screen.getByLabelText('Target agent'), 'analyst');
    act(() => publish({ type: 'snapshot_changed', snapshot: { ...base, agents: base.agents.filter((agent) => agent.id !== 'analyst') } }));
    await act(async () => resolveAnalyst({
      items: [{ id: 'stale-analyst', role: 'agent', targetAgentId: 'analyst', authorLabel: 'Analyst', text: 'Stale response', createdAt: '2026-07-19T00:00:00Z', evidenceLabel: 'stale' }],
      nextCursor: null
    }));

    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText('Stale response')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Target agent')).toHaveValue('orchestrator');
  });

  test('consolidates Settings state and Project Route without a More workspace', async () => {
    const user = userEvent.setup();
    const bridge = new MockOrquestaBridge('active-project');
    const getRuntimeInfo = vi.spyOn(bridge, 'getRuntimeInfo');
    render(<DesktopRendererApp bridge={bridge} initialLocale="en" />);

    await user.click(await screen.findByRole('button', { name: 'Settings' }));
    const sections = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(sections).getByRole('button', { name: 'Display' })).toHaveAttribute('aria-current', 'page');
    expect(within(sections).getByRole('button', { name: 'Notifications' })).toBeVisible();
    expect(within(sections).getByRole('button', { name: 'Codex connection' })).toBeVisible();
    expect(within(sections).getByRole('button', { name: 'Startup & project' })).toBeVisible();
    expect(within(sections).getByRole('button', { name: 'Status & diagnostics' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Display' })).toBeVisible();
    expect(screen.getByText('Display language')).toBeVisible();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();

    await user.click(within(sections).getByRole('button', { name: 'Notifications' }));
    expect(screen.getByText('Notification settings have not been designed yet.')).toBeVisible();
    expect(screen.queryByText('Temporary notifications')).not.toBeInTheDocument();
    await user.click(within(sections).getByRole('button', { name: 'Codex connection' }));
    expect(await screen.findByRole('heading', { name: 'Codex connection' })).toBeVisible();
    expect(screen.getByText('Codex settings have not been designed yet.')).toBeVisible();
    expect(getRuntimeInfo).not.toHaveBeenCalled();

    await user.click(within(sections).getByRole('button', { name: 'Startup & project' }));
    await user.click(screen.getByRole('button', { name: 'Open Project Route' }));
    expect(screen.getByRole('dialog', { name: 'Project Route' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Close Project Route' }));

    await user.click(within(sections).getByRole('button', { name: 'Status & diagnostics' }));
    expect(screen.getByRole('heading', { name: 'Status & diagnostics' })).toBeVisible();
    expect(screen.getByText('Repository status')).toBeVisible();
    await waitFor(() => expect(getRuntimeInfo).toHaveBeenCalledWith({ probe: false }));
    await user.click(screen.getByRole('button', { name: 'Open Operations' }));
    expect(screen.getByRole('dialog', { name: 'Operations' })).toBeVisible();
  });

  test('keeps project switching discoverable in the top-left launcher', async () => {
    const user = userEvent.setup();
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);

    const launcher = await screen.findByLabelText('Project launcher');
    expect(within(launcher).getByText('Local Multi-Agent Orchestration')).toBeVisible();
    await user.click(within(launcher).getByRole('button', { name: 'Project actions' }));
    expect(within(launcher).getByRole('button', { name: 'Switch project' })).toBeVisible();
    expect(within(launcher).getByRole('button', { name: 'Open project folder' })).toBeVisible();
    expect(within(launcher).queryByRole('button', { name: 'Open Project Route' })).not.toBeInTheDocument();
  });

  test('opens the selected conversation from the persistent Composer history button', async () => {
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Conversation history · Orchestrator' }));
    expect(await screen.findByRole('heading', { name: 'Conversation · Orchestrator' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Records' })).toHaveAttribute('aria-current', 'page');
  });


  test('uses the project connection accent instead of the agent working dot', async () => {
    const { container } = render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} />);
    await screen.findByText('Demo data');
    expect(container.querySelector('.project-status .status-dot--success')).not.toBeNull();
  });

  test('keeps Project Status and User Tasks in one aligned home rail', async () => {
    const { container } = render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} />);
    await screen.findByText('Demo data');

    const rail = container.querySelector('.home-right-rail');
    expect(rail).not.toBeNull();
    expect(rail!.children).toHaveLength(2);
    expect(rail!.children[0]).toHaveClass('project-status');
    expect(rail!.children[1]).toHaveClass('attention-card');
  });

  test('switches Japanese and English from Settings', async () => {
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);
    await screen.findByText('Demo data');
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await userEvent.click(screen.getByRole('button', { name: '日本語' }));
    expect(screen.getByRole('heading', { name: '設定' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  test('starts the Home tutorial from Display settings and restores Home', async () => {
    window.localStorage.removeItem('orquesta.desktop.home-tutorial.v1');
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 100, left: 100, top: 100, right: 500, bottom: 300, width: 400, height: 200, toJSON: () => ({})
    } as DOMRect);
    const user = userEvent.setup();
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="ja" />);

    const navigation = await screen.findByRole('navigation', { name: 'ワークスペース' });
    await user.click(within(navigation).getByRole('button', { name: '設定' }));
    await user.click(screen.getByRole('button', { name: 'ホーム画面のチュートリアルを開始' }));

    expect(await screen.findByRole('dialog', { name: 'Orquestaマップ' })).toBeVisible();
    expect(screen.getByText('1 / 7')).toBeVisible();
    expect(screen.getByLabelText('Orquesta Map')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '次へ' }));
    expect(await screen.findByRole('dialog', { name: '統括者への入力' })).toBeVisible();
    rectSpy.mockRestore();
  });

  test('renders the Home tutorial in English after the locale changes', async () => {
    window.localStorage.removeItem('orquesta.desktop.home-tutorial.v1');
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 100, left: 100, top: 100, right: 500, bottom: 300, width: 400, height: 200, toJSON: () => ({})
    } as DOMRect);
    const user = userEvent.setup();
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="ja" />);

    const navigation = await screen.findByRole('navigation', { name: 'ワークスペース' });
    await user.click(within(navigation).getByRole('button', { name: '設定' }));
    await user.click(screen.getByRole('button', { name: 'English' }));
    await user.click(screen.getByRole('button', { name: 'Start tutorial' }));

    expect(await screen.findByRole('dialog', { name: 'Orquesta map' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeVisible();
    rectSpy.mockRestore();
  });

  test('does not reload the project snapshot when the composer target changes', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    const getInitialSnapshot = vi.spyOn(bridge, 'getInitialSnapshot');
    render(<DesktopRendererApp bridge={bridge} />);
    await screen.findByText('Demo data');

    await userEvent.selectOptions(screen.getByLabelText('Target agent'), 'analyst');
    await waitFor(() => expect(screen.getByLabelText('Target agent')).toHaveValue('analyst'));

    expect(getInitialSnapshot).toHaveBeenCalledTimes(1);
  });

  test('routes an active setup snapshot to the dedicated setup experience', async () => {
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('setup-running')} initialLocale="ja" />);

    expect(await screen.findByRole('main', { name: 'Orquesta 初回セットアップ' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Orquestaの基盤を構築しています' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'ホーム' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Orquesta map')).not.toBeInTheDocument();
  });

  test('auto-starts the Home tutorial once when setup changes from running to completed', async () => {
    window.localStorage.removeItem('orquesta.desktop.home-tutorial.v1');
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 100, y: 100, left: 100, top: 100, right: 500, bottom: 300, width: 400, height: 200, toJSON: () => ({})
    } as DOMRect);
    const bridge = new MockOrquestaBridge('setup-running');
    let publish!: (event: BridgeEvent) => void;
    vi.spyOn(bridge, 'subscribe').mockImplementation((listener) => { publish = listener; return () => undefined; });
    render(<DesktopRendererApp bridge={bridge} initialLocale="en" />);
    await screen.findByRole('main', { name: 'Orquesta 初回セットアップ' });

    const complete = structuredClone(fixtureCatalog['active-project'].snapshot);
    complete.setup = {
      ...structuredClone(fixtureCatalog['setup-running'].snapshot.setup!),
      status: 'completed',
      currentPhaseId: null,
      currentActivity: null,
      nextActivity: null,
      phases: fixtureCatalog['setup-running'].snapshot.setup!.phases.map((phase) => ({ ...phase, status: 'complete' as const })),
      canCancel: false
    };
    act(() => publish({ type: 'snapshot_changed', snapshot: complete }));

    expect(await screen.findByRole('dialog', { name: 'Orquesta map' })).toBeVisible();
    rectSpy.mockRestore();
  });

  test('does not auto-start for an already completed setup or after a saved outcome', async () => {
    window.localStorage.removeItem('orquesta.desktop.home-tutorial.v1');
    const complete = structuredClone(fixtureCatalog['active-project'].snapshot);
    complete.setup = {
      ...structuredClone(fixtureCatalog['setup-running'].snapshot.setup!),
      status: 'completed',
      currentPhaseId: null,
      currentActivity: null,
      nextActivity: null,
      phases: fixtureCatalog['setup-running'].snapshot.setup!.phases.map((phase) => ({ ...phase, status: 'complete' as const })),
      canCancel: false
    };
    const completedBridge = new MockOrquestaBridge('active-project');
    vi.spyOn(completedBridge, 'getInitialSnapshot').mockResolvedValue(complete);
    const first = render(<DesktopRendererApp bridge={completedBridge} initialLocale="en" />);
    await screen.findByText('Demo data');
    expect(screen.queryByRole('dialog', { name: 'Orquesta map' })).not.toBeInTheDocument();
    first.unmount();

    writeHomeTutorialPreference(window.localStorage, 'skipped', new Date('2026-07-22T00:00:00.000Z'));
    const runningBridge = new MockOrquestaBridge('setup-running');
    let publish!: (event: BridgeEvent) => void;
    vi.spyOn(runningBridge, 'subscribe').mockImplementation((listener) => { publish = listener; return () => undefined; });
    render(<DesktopRendererApp bridge={runningBridge} initialLocale="en" />);
    await screen.findByRole('main', { name: 'Orquesta 初回セットアップ' });
    act(() => publish({ type: 'snapshot_changed', snapshot: complete }));

    await screen.findByText('Demo data');
    expect(screen.queryByRole('dialog', { name: 'Orquesta map' })).not.toBeInTheDocument();
  });

});

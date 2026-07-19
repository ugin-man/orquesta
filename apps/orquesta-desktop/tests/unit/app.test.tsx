import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { BridgeEvent, ConversationPage } from '../../src/contracts/bridge';
import type { OrquestaUiSnapshot } from '../../src/contracts/orquesta-ui';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { MockOrquestaBridge } from '../../src/bridges/mock-bridge';
import { attention } from '../../src/fixtures/helpers';
import { DesktopRendererApp, resolveInitialLocale } from '../../src/renderer/app/DesktopRendererApp';

describe('DesktopRendererApp', () => {
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

  test('keeps frequent workspaces in one persistent dock', async () => {
    const user = userEvent.setup();
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="ja" />);

    const navigation = await screen.findByRole('navigation', { name: 'ワークスペース' });
    expect(within(navigation).getByRole('button', { name: 'Home' })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: /ユーザータスク/ })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: '記録' })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: '設定' })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: 'その他' })).toBeVisible();

    await user.click(within(navigation).getByRole('button', { name: /ユーザータスク/ }));
    expect(screen.getByRole('heading', { name: 'ユーザータスク' })).toBeVisible();
    expect(screen.queryByLabelText('Orquesta map')).not.toBeInTheDocument();
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

  test('reloads and labels the conversation when the Composer target changes', async () => {
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Records' }));
    await userEvent.click(screen.getByRole('button', { name: 'Conversation' }));
    expect(await screen.findByRole('heading', { name: 'Conversation · Orchestrator' })).toBeVisible();

    await userEvent.selectOptions(screen.getByLabelText('Target agent'), 'analyst');
    expect(await screen.findByRole('heading', { name: 'Conversation · Analyst' })).toBeVisible();
  });

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

    expect(screen.getByRole('heading', { name: 'Conversation · Orchestrator' })).toBeVisible();
    expect(screen.queryByText('Stale response')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Target agent')).toHaveValue('orchestrator');
  });

  test('keeps Settings explicit and More limited to Project Route', async () => {
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    expect(screen.getByText('Display language')).toBeVisible();
    expect(screen.getByText('Diagnostics')).toBeVisible();

    await userEvent.click(await screen.findByRole('button', { name: 'More' }));
    expect(screen.getByText('Project Route')).toBeVisible();
    expect(screen.queryByText('Team Management')).not.toBeInTheDocument();
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

  test('switches Japanese and English from Settings', async () => {
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);
    await screen.findByText('Demo data');
    await userEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await userEvent.click(screen.getByRole('button', { name: '日本語' }));
    expect(screen.getByRole('heading', { name: '設定' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeVisible();
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

});

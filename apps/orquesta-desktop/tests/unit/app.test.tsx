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
    expect(within(navigation).getByRole('button', { name: /要対応/ })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: /Tasks/ })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: /Failures/ })).toBeVisible();
    expect(within(navigation).getByRole('button', { name: '会話' })).toBeVisible();

    await user.click(within(navigation).getByRole('button', { name: /Tasks/ }));
    expect(screen.getByRole('heading', { name: 'Tasks' })).toBeVisible();
    expect(screen.queryByLabelText('Orquesta map')).not.toBeInTheDocument();
  });

  test('uses canonical task review states for the Tasks badge', async () => {
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);
    const navigation = await screen.findByRole('navigation', { name: 'Workspaces' });
    expect(within(navigation).getByRole('button', { name: 'Tasks 3' })).toBeVisible();
  });

  test('opens a local detail for taskless canonical attention instead of a dead bridge action', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    const base = await bridge.getInitialSnapshot();
    vi.spyOn(bridge, 'getInitialSnapshot').mockResolvedValue({
      ...base,
      attention: [attention({ id: 'UT1', type: 'repair', actionKind: 'do', title: 'Run local check', summary: 'Open the packaged app.' })]
    });
    render(<DesktopRendererApp bridge={bridge} initialLocale="en" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Attention 1' }));
    await userEvent.click(screen.getByRole('button', { name: /Run local check/ }));
    expect(screen.getByLabelText('Attention action UT1')).toBeVisible();
  });

  test('falls back to local attention detail when a referenced task is missing', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    const base = await bridge.getInitialSnapshot();
    vi.spyOn(bridge, 'getInitialSnapshot').mockResolvedValue({
      ...base,
      attention: [attention({ id: 'UT-DANGLING', taskId: 'PRUNED-9', type: 'question', title: 'Clarify pruned work', summary: 'The source task is no longer in the snapshot.' })]
    });
    render(<DesktopRendererApp bridge={bridge} initialLocale="en" />);

    await userEvent.click(await screen.findByRole('button', { name: 'Attention 1' }));
    await userEvent.click(screen.getByRole('button', { name: /Clarify pruned work/ }));
    expect(screen.getByLabelText('Attention action UT-DANGLING')).toBeVisible();
  });

  test('keeps the Failures badge and current list on the same item set', async () => {
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Failures 1' }));
    const failures = screen.getByLabelText('Failures');
    expect(within(failures).getAllByRole('button')).toHaveLength(1);
  });

  test('reloads and labels the conversation when the Composer target changes', async () => {
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Conversation' }));
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

    await userEvent.click(await screen.findByRole('button', { name: 'Conversation' }));
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

    await userEvent.click(await screen.findByRole('button', { name: 'Conversation' }));
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

  test('exposes repository diagnostics from More without a dead navigation item', async () => {
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);
    await userEvent.click(await screen.findByRole('button', { name: 'More' }));
    expect(screen.getByText('Diagnostics')).toBeVisible();
    expect(screen.getByText('Local bridge ready')).toBeVisible();
  });

  test('keeps project switching discoverable in the top-left launcher', async () => {
    const user = userEvent.setup();
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);

    const launcher = await screen.findByLabelText('Project launcher');
    expect(within(launcher).getByText('Local Multi-Agent Orchestration')).toBeVisible();
    await user.click(within(launcher).getByRole('button', { name: 'Project actions' }));
    expect(within(launcher).getByRole('button', { name: 'Switch project' })).toBeVisible();
    expect(within(launcher).getByRole('button', { name: 'Open project folder' })).toBeVisible();
    expect(within(launcher).getByRole('button', { name: 'Open Project Route' })).toBeVisible();
  });


  test('uses the project connection accent instead of the agent working dot', async () => {
    const { container } = render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} />);
    await screen.findByText('Demo data');
    expect(container.querySelector('.project-status .status-dot--success')).not.toBeNull();
  });

  test('switches Japanese and English from More settings', async () => {
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);
    await screen.findByText('Demo data');
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    await userEvent.click(screen.getByRole('button', { name: '日本語' }));
    expect(screen.getByRole('heading', { name: 'その他' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(screen.getByRole('heading', { name: 'More' })).toBeVisible();
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

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { MockOrquestaBridge } from '../../src/bridges/mock-bridge';
import { DesktopRendererApp, resolveInitialLocale } from '../../src/renderer/app/DesktopRendererApp';

describe('DesktopRendererApp', () => {
  test('uses a persisted locale unless an explicit locale is supplied', () => {
    window.localStorage.setItem('orquesta.desktop.locale', 'ja');
    expect(resolveInitialLocale()).toBe('ja');
    expect(resolveInitialLocale('en')).toBe('en');
    window.localStorage.removeItem('orquesta.desktop.locale');
  });

  test('restores the project draft after relaunch', async () => {
    window.localStorage.setItem('orquesta.desktop.draft.active-project', 'Continue the implementation');
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Continue the implementation'));
    window.localStorage.removeItem('orquesta.desktop.draft.active-project');
  });

  test('labels prototype data and opens an agent inspector', async () => {
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} />);
    expect(await screen.findByText('Prototype data')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Analyst, Working' }));
    expect(screen.getByLabelText('Analyst detail')).toBeVisible();
  });

  test('does not expose active edge motion for dispatch-only evidence', async () => {
    const { container } = render(<DesktopRendererApp bridge={new MockOrquestaBridge('unknown-evidence')} />);
    await screen.findByText('Prototype data');
    await waitFor(() => expect(container.querySelectorAll('.map-edge-flow')).toHaveLength(0));
  });


  test('uses the project connection accent instead of the agent working dot', async () => {
    const { container } = render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} />);
    await screen.findByText('Prototype data');
    expect(container.querySelector('.project-status .status-dot--success')).not.toBeNull();
  });

  test('switches Japanese and English from the project status card', async () => {
    render(<DesktopRendererApp bridge={new MockOrquestaBridge('active-project')} initialLocale="en" />);
    await screen.findByText('Prototype data');
    await userEvent.click(screen.getByRole('button', { name: '日本語' }));
    expect(screen.getByText('プロジェクト状況')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(screen.getByText('PROJECT STATUS')).toBeVisible();
  });

  test('does not reload the project snapshot when the composer target changes', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    const getInitialSnapshot = vi.spyOn(bridge, 'getInitialSnapshot');
    render(<DesktopRendererApp bridge={bridge} />);
    await screen.findByText('Prototype data');

    await userEvent.selectOptions(screen.getByLabelText('Target agent'), 'analyst');
    await waitFor(() => expect(screen.getByLabelText('Target agent')).toHaveValue('analyst'));

    expect(getInitialSnapshot).toHaveBeenCalledTimes(1);
  });

});

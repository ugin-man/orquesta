import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { SetupDraft } from '../../src/contracts/setup';
import { MockOrquestaBridge } from '../../src/bridges/mock-bridge';
import { SetupIntake } from '../../src/renderer/features/setup/SetupIntake';

const draft: SetupDraft = {
  revision: 1,
  status: 'draft',
  source: { kind: 'detected_root', rootPath: 'C:\\work\\orquesta' },
  projectName: 'Orquesta',
  description: 'A desktop multi-agent workspace.',
  questions: [
    { questionId: 'primary-goal', prompt: '最初に完成させたいものは何ですか？', required: false }
  ],
  answers: []
};

describe('SetupIntake', () => {
  test('keeps project source, intake, account, and approval on one screen', async () => {
    const bridge = new MockOrquestaBridge('active-project');
    vi.spyOn(bridge, 'readSetupDraft').mockResolvedValue(draft);
    vi.spyOn(bridge, 'readSetupAccount').mockResolvedValue({
      status: 'authenticated', accountType: 'chatgpt', requiresOpenaiAuth: true
    });

    render(<SetupIntake bridge={bridge} locale="ja" />);

    expect(await screen.findByRole('heading', { name: 'Orquestaを始める' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'この場所で始める' })).toBeVisible();
    expect(screen.getByRole('button', { name: '既存フォルダを選ぶ' })).toBeVisible();
    expect(screen.getByRole('button', { name: '新しいプロジェクト' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'GitHubから始める' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'プロジェクト名' })).toHaveValue('Orquesta');
    expect(screen.getByRole('textbox', { name: '説明' })).toHaveValue('A desktop multi-agent workspace.');
    expect(screen.getByRole('textbox', { name: '最初に完成させたいものは何ですか？' })).toBeVisible();
    expect(screen.getByText('ChatGPTで接続済み')).toBeVisible();
    expect(screen.getByRole('region', { name: '開始前の確認' })).toHaveTextContent(/基礎エージェント\s*3体/u);
  });

  test('starts only from the explicit approval action and includes optional answers', async () => {
    const user = userEvent.setup();
    const bridge = new MockOrquestaBridge('active-project');
    vi.spyOn(bridge, 'readSetupDraft').mockResolvedValue(draft);
    vi.spyOn(bridge, 'readSetupAccount').mockResolvedValue({
      status: 'authenticated', accountType: 'chatgpt', requiresOpenaiAuth: true
    });
    const start = vi.spyOn(bridge, 'startSetup').mockResolvedValue({
      setupId: 'SETUP-1', rootPath: 'C:\\work\\orquesta', activePhaseId: 'environment'
    });

    render(<SetupIntake bridge={bridge} locale="ja" />);
    await user.type(await screen.findByRole('textbox', { name: '最初に完成させたいものは何ですか？' }), 'Desktop版');
    expect(start).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'セットアップを開始' }));

    await waitFor(() => expect(start).toHaveBeenCalledWith(expect.objectContaining({
      answers: [{ questionId: 'primary-goal', answer: 'Desktop版' }]
    })));
  });

  test('shows GitHub preflight guidance without cloning from the renderer', async () => {
    const user = userEvent.setup();
    const bridge = new MockOrquestaBridge('active-project');
    vi.spyOn(bridge, 'readSetupDraft').mockResolvedValue(draft);
    vi.spyOn(bridge, 'readSetupAccount').mockResolvedValue({
      status: 'authenticated', accountType: 'chatgpt', requiresOpenaiAuth: true
    });

    render(<SetupIntake bridge={bridge} locale="ja" />);
    await user.click(await screen.findByRole('button', { name: 'GitHubから始める' }));
    const source = screen.getByRole('group', { name: 'GitHubリポジトリ' });
    expect(within(source).getByRole('textbox', { name: '公開GitHub URL' })).toBeVisible();
    expect(within(source).getByText(/private、Git LFS、submodule/)).toBeVisible();
  });
});

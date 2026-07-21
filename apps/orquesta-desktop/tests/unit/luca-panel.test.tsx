import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { LucaPanel } from '../../src/renderer/features/luca/LucaPanel';

describe('LucaPanel', () => {
  test('shows fixed questions before revealing the custom input', async () => {
    render(<LucaPanel
      context={{ kind: 'task', id: 'T001' }}
      locale="ja"
      state={{ kind: 'idle' }}
      onAsk={vi.fn()}
      onClose={vi.fn()}
    />);

    expect(screen.getByRole('button', { name: 'このタスクを簡単に説明して' })).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '自由に聞く' }));
    expect(screen.getByRole('textbox', { name: 'Lucaへの質問' })).toBeVisible();
  });

  test('does not submit another question while pending', async () => {
    const onAsk = vi.fn();
    render(<LucaPanel
      context={{ kind: 'home' }}
      locale="ja"
      state={{ kind: 'pending', questionId: 'home.current' }}
      onAsk={onAsk}
      onClose={vi.fn()}
    />);

    await userEvent.click(screen.getByRole('button', { name: '今、何をしている？' }));
    expect(onAsk).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Lucaが記録を確認しています');
  });

  test('renders a structured answer and its evidence limits', () => {
    render(<LucaPanel
      context={{ kind: 'failure', id: 'F001' }}
      locale="ja"
      state={{
        kind: 'answer',
        payload: {
          answer: '保存処理に失敗しています。',
          points: ['再試行前にパスを確認します。'],
          uncertainties: ['実行環境の権限は記録されていません。'],
          references: [{ kind: 'failure', id: 'F001', label: 'F001' }]
        }
      }}
      onAsk={vi.fn()}
      onClose={vi.fn()}
    />);

    expect(screen.getByText('保存処理に失敗しています。')).toBeVisible();
    expect(screen.getByText('実行環境の権限は記録されていません。')).toBeVisible();
    expect(screen.getByText('F001')).toBeVisible();
  });
});

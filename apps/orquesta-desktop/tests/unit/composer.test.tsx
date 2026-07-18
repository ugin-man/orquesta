import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CommandComposer } from '../../src/renderer/features/composer/CommandComposer';
import { I18nProvider } from '../../src/renderer/features/i18n/I18nProvider';
import { fixtureCatalog } from '../../src/fixtures';

function renderComposer(onSend = vi.fn()) {
  const agents = fixtureCatalog['active-project'].snapshot.agents;
  render(
    <I18nProvider initialLocale="en">
      <CommandComposer
        agents={agents}
        online
        sending={false}
        value="Run acceptance checks"
        targetAgentId="orchestrator"
        error={null}
        onTargetChange={() => undefined}
        onChange={() => undefined}
        onSend={onSend}
        onOpenHistory={() => undefined}
      />
    </I18nProvider>
  );
  return onSend;
}

describe('CommandComposer', () => {
  it('sends on Enter', () => {
    const onSend = renderComposer();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: false });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('keeps Shift+Enter for a newline', () => {
    const onSend = renderComposer();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });
});

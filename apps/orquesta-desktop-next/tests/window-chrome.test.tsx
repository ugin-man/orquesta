import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const windowActions = vi.hoisted(() => ({
  minimize: vi.fn(() => Promise.resolve()),
  toggleMaximize: vi.fn(() => Promise.resolve()),
  close: vi.fn(() => Promise.resolve()),
  startDragging: vi.fn(() => Promise.resolve()),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => windowActions,
}));

import { WindowChrome } from '../src/features/window/WindowChrome';

describe('integrated native window chrome', () => {
  afterEach(cleanup);

  beforeEach(() => {
    windowActions.minimize.mockClear();
    windowActions.toggleMaximize.mockClear();
    windowActions.close.mockClear();
    windowActions.startDragging.mockClear();
  });

  test('exposes a drag strip and the three Windows actions without a product title', () => {
    const view = render(<WindowChrome locale="ja" />);

    expect(view.container.querySelector('[data-tauri-drag-region]')).not.toBeNull();
    expect(screen.getByRole('button', { name: '最小化' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '最大化または元に戻す' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '閉じる' })).toBeInTheDocument();
    expect(screen.queryByText('Orquesta Next')).toBeNull();
  });

  test('routes each control to the current native window', () => {
    const view = render(<WindowChrome locale="en" />);

    fireEvent.mouseDown(view.container.querySelector('.native-window-drag-strip')!, { button: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Maximize or restore' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(windowActions.startDragging).toHaveBeenCalledOnce();
    expect(windowActions.minimize).toHaveBeenCalledOnce();
    expect(windowActions.toggleMaximize).toHaveBeenCalledOnce();
    expect(windowActions.close).toHaveBeenCalledOnce();
  });

  test('keeps Browser Preview controls visual-only', () => {
    const view = render(<WindowChrome locale="en" interactive={false} />);

    fireEvent.mouseDown(view.container.querySelector('.native-window-drag-strip')!, { button: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Maximize or restore' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(windowActions.startDragging).not.toHaveBeenCalled();
    expect(windowActions.minimize).not.toHaveBeenCalled();
    expect(windowActions.toggleMaximize).not.toHaveBeenCalled();
    expect(windowActions.close).not.toHaveBeenCalled();
  });
});

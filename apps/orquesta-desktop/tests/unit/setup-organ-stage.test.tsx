import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { setupRunningFixture } from '../../src/fixtures/setup-running';
import { SetupOrganStage } from '../../src/renderer/features/setup/SetupOrganStage';

describe('SetupOrganStage', () => {
  test('loads the supplied six-phase organ scene without demo controls', async () => {
    const { container } = render(<SetupOrganStage setup={setupRunningFixture.snapshot.setup!} />);

    expect(screen.getByRole('status')).toHaveTextContent('機構を準備しています');
    await waitFor(() => expect(screen.getByRole('img', { name: /パイプオルガン機構/ })).toBeVisible());
    expect(container.querySelector('[data-renderer="three-webgl"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-pipe-id]')).toHaveLength(51);
    expect(container.querySelector('[data-demo-controls]')).toBeNull();
  });
});

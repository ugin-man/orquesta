import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RuntimeInfoUi } from '../../src/contracts/bridge';
import { emptyV4OperationsSnapshot, type V4OperationsSnapshot } from '../../src/contracts/orquesta-ui';
import { I18nProvider } from '../../src/renderer/features/i18n/I18nProvider';
import { V4Operations } from '../../src/renderer/features/operations/V4Operations';

const runtime: RuntimeInfoUi = {
  status: 'ready', adapter: 'app_server', sdkVersion: '0.144.5', codexVersion: '0.144.5',
  runtimeVersion: '0.144.5-win32-x64', targetTriple: 'x86_64-pc-windows-msvc',
  platformFamily: 'windows', platformOs: 'windows', userAgent: 'orquesta-desktop', integrity: 'verified',
};

const operations: V4OperationsSnapshot = {
  available: true,
  revision: 42,
  taskIntent: {
    id: 'TI-desktop', desiredOutcome: 'Ship the complete desktop control plane',
    acceptanceCriteria: ['The packaged app exposes canonical V4 evidence'], rawRequestRef: 'request:desktop',
  },
  capabilityNeeds: [{
    id: 'NEED-runtime', description: 'Pinned Codex runtime', kind: 'runtime', requiredLevel: 'exact',
    status: 'resolved', confidence: 96,
  }],
  providers: [{
    id: 'provider-codex', type: 'package', sourceUri: 'npm:@openai/codex', capabilities: ['runtime'],
    trustTier: 'trusted', availability: 'available', version: '0.144.5', lastVerifiedAt: '2026-07-19T00:00:00.000Z',
    evidenceRefs: ['package-lock:@openai/codex'],
  }],
  candidateEvaluations: [{
    id: 'EVAL-codex', candidateId: 'provider-codex', needId: 'NEED-runtime', score: 94,
    eligibility: 'eligible', hardGates: [{ name: 'version', status: 'pass', reason: 'Pinned exact version' }], actualModel: null,
  }],
  latestResolutions: [{
    id: 'RES-runtime', needId: 'NEED-runtime', mode: 'reuse', providerId: 'provider-codex',
    approvalStatus: 'approved', totalCost: 0,
  }],
  contextPack: {
    id: 'CP-desktop', ownerAgentId: 'implementation-001', objective: 'Integrate V4 into Desktop',
    requiredReading: ['README.md'], resolutionIds: ['RES-runtime'], status: 'ready',
  },
  acquisitionSnapshots: [{
    queryId: 'LSQ-desktop', needId: 'NEED-runtime', queryTerms: ['codex runtime'],
    requestedAt: '2026-07-19T00:00:00.000Z', maxRequests: 8, consumedRequests: 2, remainingRequests: 6,
    sources: [{
      connectorId: 'official_docs', trustTier: 'official', status: 'success', fetchedAt: '2026-07-19T00:00:00.000Z',
      expiresAt: '2026-07-20T00:00:00.000Z', candidateIds: ['provider-codex'],
      sourceEvidenceRefs: ['docs:codex'], cacheStatus: 'fresh',
    }],
  }],
  auditionResults: [{
    planId: 'AP-desktop', verdict: 'passed', observedProfile: 'workspace-write',
    cleanupEvidence: ['cleanup:verified'], evidenceRefs: ['artifact:audition'],
  }],
  installRequest: { id: 'INSTALL-1', status: 'authorized', candidateId: 'provider-codex', expiresAt: null },
  evidenceChains: [{
    correlationId: 'CORR-desktop', items: [
      { id: 'EVID-dispatch', kind: 'runtime_dispatch', correlationId: 'CORR-desktop', threadId: 'thread-1', turnId: null, predecessorId: null, ref: 'request:1', sequence: 38 },
      { id: 'EVID-turn', kind: 'runtime_event', correlationId: 'CORR-desktop', threadId: 'thread-1', turnId: 'turn-1', predecessorId: 'EVID-dispatch', ref: null, sequence: 39 },
    ],
  }],
  runtimeCorrelations: [{ correlationId: 'CORR-desktop', dispatchEvidenceId: 'EVID-dispatch', activeThreadId: 'thread-1', activeTurnId: 'turn-1' }],
  auditTimeline: [{
    sequence: 41, eventId: 'EV-audit', type: 'candidate.audit.recorded', actorId: 'auditor',
    responsibility: 'static_audit', commandName: 'candidate.audit.record', scoutSkipReason: null, evidenceRefs: ['report:audit'],
  }],
  phaseReviews: [{ phaseId: 'phase-2', status: 'ready_for_user_review', reviewPacketRef: 'report:phase2', buildRef: 'build:desktop' }],
  limitation: null,
};

function renderOperations(input: {
  locale?: 'en' | 'ja';
  value?: V4OperationsSnapshot;
  getRuntimeInfo?: (input: { probe: boolean }) => Promise<RuntimeInfoUi>;
} = {}) {
  const getRuntimeInfo = vi.fn(input.getRuntimeInfo ?? (async () => runtime));
  render(
    <I18nProvider initialLocale={input.locale ?? 'en'}>
      <V4Operations operations={input.value ?? operations} getRuntimeInfo={getRuntimeInfo} onClose={vi.fn()} />
    </I18nProvider>,
  );
  return { getRuntimeInfo };
}

afterEach(() => cleanup());

describe('V4Operations', () => {
  test.each([[1366, 768], [1440, 900]])('keeps four keyboard tabs and panel-local scrolling at %ix%i', async (width, height) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
    renderOperations();

    const tablist = screen.getByRole('tablist', { name: 'Operations views' });
    expect(within(tablist).getAllByRole('tab')).toHaveLength(4);
    expect(screen.getByRole('tabpanel')).toHaveClass('operations-panel__scroll');
    expect(document.querySelector('.operations-overlay')).toHaveClass('operations-overlay--bounded');

    const first = within(tablist).getByRole('tab', { name: 'Capability' });
    first.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(within(tablist).getByRole('tab', { name: 'Acquisition' })).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(within(tablist).getByRole('tab', { name: 'Evidence' })).toHaveFocus();
  });

  test('shows canonical Capability, Acquisition, Audit, and Evidence data', async () => {
    renderOperations();
    expect(screen.getByText('Ship the complete desktop control plane')).toBeVisible();

    await userEvent.click(screen.getByRole('tab', { name: 'Acquisition' }));
    expect(screen.getByText('npm:@openai/codex')).toBeVisible();
    expect(screen.getByText('6 requests remaining')).toBeVisible();

    await userEvent.click(screen.getByRole('tab', { name: 'Audit' }));
    expect(screen.getByText('candidate.audit.record')).toBeVisible();
    expect(screen.getByText(/static_audit/)).toBeVisible();

    await userEvent.click(screen.getByRole('tab', { name: 'Evidence' }));
    expect(screen.getAllByText('EVID-dispatch').length).toBeGreaterThan(0);
    expect(screen.getByText('0.144.5-win32-x64')).toBeVisible();
  });

  test('loads runtime metadata without probing and probes only after explicit refresh', async () => {
    const { getRuntimeInfo } = renderOperations();
    await waitFor(() => expect(getRuntimeInfo).toHaveBeenCalledWith({ probe: false }));
    expect(getRuntimeInfo).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('tab', { name: 'Evidence' }));
    await userEvent.click(screen.getByRole('button', { name: 'Refresh runtime status' }));
    await waitFor(() => expect(getRuntimeInfo).toHaveBeenLastCalledWith({ probe: true }));
  });

  test('switches the operations labels between English and Japanese', async () => {
    renderOperations();
    await userEvent.click(screen.getByRole('button', { name: '日本語' }));
    expect(screen.getByRole('tab', { name: '能力' })).toBeVisible();
    expect(screen.getByRole('tab', { name: '探索' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(screen.getByRole('tab', { name: 'Capability' })).toBeVisible();
  });

  test('distinguishes an empty canonical journal from an unavailable journal', async () => {
    const empty = { ...emptyV4OperationsSnapshot(), available: true, limitation: null };
    const first = renderOperations({ value: empty });
    expect(screen.getByText('No V4 capability state has been recorded yet.')).toBeVisible();
    await waitFor(() => expect(first.getRuntimeInfo).toHaveBeenCalledWith({ probe: false }));
    cleanup();

    const second = renderOperations({ value: emptyV4OperationsSnapshot('Journal recovery required at sequence 17') });
    expect(screen.getAllByText('V4 operational state is unavailable').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Journal recovery required at sequence 17').length).toBeGreaterThan(0);
    await waitFor(() => expect(second.getRuntimeInfo).toHaveBeenCalledWith({ probe: false }));
  });
});

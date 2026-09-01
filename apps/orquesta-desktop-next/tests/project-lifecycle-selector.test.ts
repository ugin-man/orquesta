import { describe, expect, test } from 'vitest';
import {
  projectLifecycleAllowsUserMutation,
  selectApplicationSurface,
  selectCurrentUserOrchestratorId,
  selectProjectLifecycle,
  selectProjectSurface,
  type ProjectLifecycle,
} from '../src/application/selectors';
import { createInitialApplicationState, type ApplicationState } from '../src/application/state';
import { userMessage } from '../src/application/user-message';
import type { ProjectBootstrapResult, RuntimeAuthority } from '../src/domain/models';
import { previewSnapshot } from '../src/testing/preview-client';
import { parseWorkspaceSnapshot } from '../src/domain/validation';

const authority: RuntimeAuthority = {
  projectId: previewSnapshot.project.id,
  activationToken: 'preview-activation',
  rendererSessionId: 'preview-renderer',
  rendererGeneration: 1,
};

const readyBootstrap: ProjectBootstrapResult = { status: 'ready', noWrite: true, reason: null };

function activeState(patch: Partial<ApplicationState> = {}): ApplicationState {
  return {
    ...createInitialApplicationState(),
    phase: 'workspace',
    projects: [structuredClone(previewSnapshot.project)],
    selectedProjectId: previewSnapshot.project.id,
    runtimeAuthority: authority,
    snapshot: structuredClone(previewSnapshot),
    selectedAgentId: 'orchestrator',
    projectBootstrap: readyBootstrap,
    ...patch,
  };
}

describe('project lifecycle selector', () => {
  const cases: Array<[ProjectLifecycle, ApplicationState]> = [
    ['no_project', createInitialApplicationState()],
    ['registered_inactive', activeState({ runtimeAuthority: null, snapshot: null, selectedAgentId: null })],
    ['activating', activeState({ phase: 'activating', runtimeAuthority: null, snapshot: null, selectedAgentId: null })],
    ['hydrating_snapshot', activeState({ snapshot: null, selectedAgentId: null, projectBootstrap: null })],
    ['bootstrapping_foundation', activeState({
      snapshot: { ...structuredClone(previewSnapshot), agents: [] },
      selectedAgentId: null,
      projectBootstrap: null,
      projectStartPending: true,
    })],
    ['preparation_failed', activeState({
      snapshot: { ...structuredClone(previewSnapshot), agents: [] },
      selectedAgentId: null,
      projectBootstrap: null,
      projectStartPending: false,
      error: userMessage('generic_failure'),
    })],
    ['ready', activeState()],
    ['migration_required', activeState({
      projectBootstrap: { status: 'migration_required', noWrite: true, reason: 'legacy', classification: 'legacy_v2' },
    })],
    ['recovery_required', activeState({
      projectBootstrap: { status: 'recovery_required', noWrite: true, reason: 'repair required' },
    })],
    ['stopping', activeState({ phase: 'stopping' })],
  ];

  test.each(cases)('classifies %s from one canonical state machine', (expected, state) => {
    expect(selectProjectLifecycle(state)).toBe(expected);
  });

  test.each(cases)('derives the complete surface and mutation boundary for %s', (expected, state) => {
    const lifecycle = selectProjectLifecycle(state);
    expect(lifecycle).toBe(expected);
    expect(projectLifecycleAllowsUserMutation(lifecycle)).toBe(expected === 'ready');
    expect(selectProjectSurface(lifecycle)).toBe(({
      no_project: 'empty', registered_inactive: 'inactive', activating: 'preparing',
      hydrating_snapshot: 'preparing', bootstrapping_foundation: 'preparing', ready: 'ready',
      preparation_failed: 'preparation_failed',
      migration_required: 'migration_required', recovery_required: 'recovery_required', stopping: 'stopping',
    } satisfies Record<ProjectLifecycle, ReturnType<typeof selectProjectSurface>>)[expected]);
  });

  test('blocked migration wins even when a complete agent snapshot remains present', () => {
    const state = activeState({
      projectBootstrap: { status: 'migration_required', noWrite: true, reason: 'legacy', classification: 'legacy_v2' },
      snapshot: structuredClone(previewSnapshot),
      selectedAgentId: 'orchestrator',
    });
    const lifecycle = selectProjectLifecycle(state);
    expect(lifecycle).toBe('migration_required');
    expect(selectProjectSurface(lifecycle)).toBe('migration_required');
    expect(projectLifecycleAllowsUserMutation(lifecycle)).toBe(false);
  });

  test('application surface has one owner for startup, fatal failure, and workspace states', () => {
    expect(selectApplicationSurface(createInitialApplicationState())).toBe('startup');
    expect(selectApplicationSurface({ ...createInitialApplicationState(), phase: 'failed', error: userMessage('generic_failure') })).toBe('failure');
    expect(selectApplicationSurface(activeState())).toBe('workspace');
  });

  test('current-user participant binding owns orchestrator selection without arbitrary root fallback', () => {
    const snapshot = structuredClone(previewSnapshot);
    snapshot.participants = [{
      id: 'user', displayName: 'User', roleLabel: 'Owner', isCurrentUser: true,
      orchestratorAgentId: 'security',
    }];
    expect(selectCurrentUserOrchestratorId(snapshot)).toBe('security');
    snapshot.participants[0].orchestratorAgentId = 'missing';
    expect(selectCurrentUserOrchestratorId(snapshot)).toBeNull();
    expect(selectProjectLifecycle(activeState({ snapshot, projectBootstrap: { status: 'ready', noWrite: true, reason: null } })))
      .toBe('recovery_required');
    snapshot.participants = [];
    expect(selectCurrentUserOrchestratorId(snapshot)).toBeNull();
    expect(() => parseWorkspaceSnapshot(snapshot)).toThrow('Workspace current-user authority is invalid.');
    expect(selectProjectLifecycle(activeState({ snapshot, projectBootstrap: { status: 'ready', noWrite: true, reason: null } })))
      .toBe('recovery_required');
  });
});

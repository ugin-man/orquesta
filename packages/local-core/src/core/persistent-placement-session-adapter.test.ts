import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import executionKernel from '@orquesta/execution-kernel';
import type { AgentV3, PlacementTaskV3 } from '@orquesta/contracts';
import {
  establishRuntimeBinding,
  readRuntimeBindingEvidence,
  type RuntimeBindingEvidence
} from './runtime-binding-store';
import { SessionBindingStore } from './session-binding-store';
import { PersistentPlacementSessionAdapter } from './persistent-placement-session-adapter';

const roots: string[] = [];
const PROJECT_ID = 'project-placement';
const INTENT_ID = 'PI-0123456789ab';
const AGENT_ID = 'implementation-0123456789ab-1';
const TASK_ID = 'placement:0123456789ab:1';
const NOW = '2026-08-24T06:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function task(): PlacementTaskV3 {
  const base = {
    task_id: TASK_ID,
    task_kind: 'specialist_work' as const,
    placement_intent_id: INTENT_ID,
    assigned_agent_id: AGENT_ID,
    owner_agent_id: AGENT_ID,
    role_id: 'implementation',
    role_version: 1,
    purpose: 'Implement the bounded feature.',
    acceptance_criteria: ['Complete the implementation and return durable evidence.'],
    state: 'assigned' as const,
    dependencies: [],
    blocked_by: [],
    result_summary: null,
    accepted_at: null,
    specialist_report_required: true as const,
    created_at: NOW,
    updated_at: NOW
  };
  return { ...base, placement_fingerprint: executionKernel.taskFingerprint(base) };
}

function agent(): AgentV3 {
  return {
    agent_id: AGENT_ID,
    role_id: 'implementation',
    role_version: 1,
    mission: 'Implement the bounded feature.',
    context_scope: ['project'],
    lifecycle_state: 'provisioning',
    origin: 'controller',
    created_from_ref: { kind: 'task', id: TASK_ID },
    retired_at: null
  };
}

async function fixture() {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'orquesta-persistent-placement-session-'));
  roots.push(rootPath);
  await establishRuntimeBinding({
    rootPath,
    projectId: PROJECT_ID,
    launchContext: { source: 'standalone', callingThreadId: null },
    authorityId: () => 'runtime-authority-a',
    now: () => new Date(NOW)
  });
  const evidence = await readRuntimeBindingEvidence(rootPath) as RuntimeBindingEvidence;
  const verify = async (input: { rootPath: string; projectId: string; runtimeAuthorityId: string }) => {
    const observed = await readRuntimeBindingEvidence(input.rootPath);
    if (!observed || observed.sha256 !== evidence.sha256
      || observed.binding.project_id !== input.projectId
      || observed.binding.runtime_authority_id !== input.runtimeAuthorityId) {
      throw new Error('runtime_authority_changed');
    }
  };
  const store = new SessionBindingStore({ verifyRuntimeAuthority: verify });
  await store.initializeFresh({ rootPath, projectId: PROJECT_ID });
  return { rootPath, evidence, store };
}

function provisionInput() {
  return {
    projectId: PROJECT_ID,
    placementIntentId: INTENT_ID,
    requestId: `placement:${INTENT_ID}:${AGENT_ID}`,
    task: task(),
    agent: agent()
  };
}

test('binds one accepted persistent session and reuses it without another provider dispatch', async () => {
  const project = await fixture();
  const runtime = {
    sendMessage: vi.fn(async () => ({
      threadId: 'thread-placement-1',
      turnId: 'turn-placement-1',
      modelEvidence: {
        recommendedModel: null,
        requestedModel: null,
        appliedModel: null,
        actualModel: null,
        actualModelEvidence: 'unknown' as const
      }
    }))
  };
  const adapter = await PersistentPlacementSessionAdapter.create({
    rootPath: project.rootPath,
    projectId: PROJECT_ID,
    runtime,
    sessionStore: project.store,
    runtimeEvidence: project.evidence,
    now: () => new Date('2026-08-24T06:00:01.000Z')
  });

  const first = await adapter.provisionPersistentAgent(provisionInput());
  const second = await adapter.provisionPersistentAgent(provisionInput());
  expect(second).toEqual(first);
  expect(first).toMatchObject({
    status: 'accepted',
    agent_id: AGENT_ID,
    thread_id: 'thread-placement-1',
    accepted_at: '2026-08-24T06:00:01.000Z'
  });
  expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  expect(runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    messageId: `placement:${INTENT_ID}:${AGENT_ID}`,
    threadId: null,
    targetAgentId: AGENT_ID
  }));
  expect(await adapter.findAcceptedBinding({
    projectId: PROJECT_ID,
    placementIntentId: INTENT_ID,
    requestId: `placement:${INTENT_ID}:${AGENT_ID}`,
    taskId: TASK_ID,
    agentId: AGENT_ID
  })).toEqual(first);
});

test('fails before provider dispatch when the session authority was not initialized', async () => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'orquesta-persistent-placement-no-state-'));
  roots.push(rootPath);
  await establishRuntimeBinding({
    rootPath,
    projectId: PROJECT_ID,
    launchContext: { source: 'standalone', callingThreadId: null },
    authorityId: () => 'runtime-authority-a',
    now: () => new Date(NOW)
  });
  const runtime = { sendMessage: vi.fn() };
  const adapter = await PersistentPlacementSessionAdapter.create({ rootPath, projectId: PROJECT_ID, runtime });
  await expect(adapter.provisionPersistentAgent(provisionInput()))
    .rejects.toMatchObject({ code: 'PLACEMENT_SESSION_STATE_NOT_INITIALIZED' });
  expect(runtime.sendMessage).not.toHaveBeenCalled();
});

test('does not persist a provider result after runtime authority bytes change', async () => {
  const project = await fixture();
  const bindingPath = project.evidence.filePath;
  const runtime = {
    sendMessage: vi.fn(async () => {
      const binding = JSON.parse(await readFile(bindingPath, 'utf8'));
      binding.verified_at = '2026-08-24T06:00:02.000Z';
      await writeFile(bindingPath, `${JSON.stringify(binding, null, 2)}\n`, 'utf8');
      return {
        threadId: 'thread-placement-1',
        turnId: 'turn-placement-1',
        modelEvidence: {
          recommendedModel: null,
          requestedModel: null,
          appliedModel: null,
          actualModel: null,
          actualModelEvidence: 'unknown' as const
        }
      };
    })
  };
  const adapter = await PersistentPlacementSessionAdapter.create({
    rootPath: project.rootPath,
    projectId: PROJECT_ID,
    runtime,
    sessionStore: project.store,
    runtimeEvidence: project.evidence,
    now: () => new Date('2026-08-24T06:00:03.000Z')
  });

  await expect(adapter.provisionPersistentAgent(provisionInput()))
    .rejects.toMatchObject({ code: 'PLACEMENT_SESSION_RUNTIME_AUTHORITY_CHANGED' });
  const state = await project.store.read(project.rootPath, PROJECT_ID);
  expect(state).toMatchObject({ status: 'ready', state: { sessions: [] } });
});

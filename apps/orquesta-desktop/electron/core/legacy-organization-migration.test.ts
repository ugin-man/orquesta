import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import * as migrationModule from './legacy-organization-migration';
import { readRepositorySnapshot } from './repository-reader';

const roots: string[] = [];
const NOW = '2026-07-28T05:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function legacyRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orquesta-legacy-explicit-'));
  roots.push(root);
  const stateRoot = path.join(root, '.orquesta', 'state');
  await writeJson(path.join(stateRoot, 'agents.json'), {
    version: 1,
    agents: [
      { agent_id: 'orchestrator', role: 'orchestrator', status: 'active', thread_id: 'thread-orchestrator' },
      { agent_id: 'implementation-001', role: 'implementation', status: 'standby', thread_id: 'thread-implementation' }
    ]
  });
  await writeJson(path.join(stateRoot, 'sessions.json'), { version: 1, sessions: [] });
  await writeJson(path.join(stateRoot, 'tasks.json'), { version: 1, tasks: [] });
  return root;
}

function mapping() {
  return {
    lines: [{
      line_id: 'primary-line',
      display_name: 'Primary line',
      goal: 'Continue the existing product work.',
      deliverable_ids: ['primary-deliverable'],
      completion_root_ids: ['legacy-continuation'],
      scope: ['.'],
      owner_agent_id: 'orchestrator',
      dedicated_lead_agent_id: null,
      status: 'active',
      approval_source: 'setup_confirmation'
    }],
    teams: [{
      team_id: 'primary-implementation',
      line_id: 'primary-line',
      display_name: 'Implementation',
      purpose: 'Continue existing implementation work.',
      lifecycle_state: 'active'
    }],
    assignments: [{
      agent_id: 'implementation-001',
      team_id: 'primary-implementation',
      position: 'member',
      ordinal: 1
    }]
  };
}

describe('explicit legacy organization migration', () => {
  test('blocks ordinary organization reads until reviewed migration completes', async () => {
    const rootPath = await legacyRepository();
    await expect(readRepositorySnapshot(rootPath))
      .rejects.toThrow('legacy_organization_requires_explicit_migration');

    const stateRoot = path.join(rootPath, '.orquesta', 'state');
    await expect(readFile(path.join(stateRoot, 'roles.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(stateRoot, 'organization.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await migrationModule.applyLegacyOrganizationMigration({
      projectId: 'legacy-project',
      rootPath,
      expectedRevision: 0,
      ...mapping(),
      now: () => NOW
    });
    await expect(readRepositorySnapshot(rootPath)).resolves.toMatchObject({
      organization: { source: 'explicit', revision: 1 }
    });
  });

  test('accepts an empty roster and rejects partial or schema-v2 state without explicit organization files', () => {
    expect(() => migrationModule.assertExplicitOrganizationState({
      agentsState: { version: 1, agents: [] },
      rolesState: undefined,
      organizationState: undefined
    })).not.toThrow();
    expect(() => migrationModule.assertExplicitOrganizationState({
      agentsState: { version: 1, agents: [{ agent_id: 'orchestrator' }] },
      rolesState: { schema_version: 1, roles: [] },
      organizationState: undefined
    })).toThrow(/incomplete organization state/i);
    expect(() => migrationModule.assertExplicitOrganizationState({
      agentsState: undefined,
      rolesState: { schema_version: 1, roles: [] },
      organizationState: undefined
    })).toThrow(/incomplete organization state/i);
    expect(() => migrationModule.assertExplicitOrganizationState({
      agentsState: { schema_version: 2, agents: [{ agent_id: 'orchestrator' }] },
      rolesState: undefined,
      organizationState: undefined
    })).toThrow(/schema v2 agents exist without roles\.json and organization\.json/i);
  });

  test('previews without writes, applies an exact reviewed mapping once, and stays idempotent', async () => {
    const rootPath = await legacyRepository();
    const api = migrationModule as unknown as {
      readLegacyOrganizationMigration?: (input: {
        projectId: string;
        rootPath: string;
        now?: () => string;
      }) => Promise<Record<string, unknown>>;
      applyLegacyOrganizationMigration?: (input: {
        projectId: string;
        rootPath: string;
        expectedRevision: number;
        lines: Array<Record<string, unknown>>;
        teams: Array<Record<string, unknown>>;
        assignments: Array<Record<string, unknown>>;
        now?: () => string;
      }) => Promise<Record<string, unknown>>;
    };
    expect(api.readLegacyOrganizationMigration).toBeTypeOf('function');
    expect(api.applyLegacyOrganizationMigration).toBeTypeOf('function');

    const preview = await api.readLegacyOrganizationMigration!({
      projectId: 'legacy-project',
      rootPath,
      now: () => NOW
    });
    expect(preview).toMatchObject({
      status: 'review_required',
      revision: 0,
      unassignedProductionAgentIds: ['implementation-001']
    });
    await expect(readFile(path.join(rootPath, '.orquesta', 'state', 'organization.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });

    const applied = await api.applyLegacyOrganizationMigration!({
      projectId: 'legacy-project',
      rootPath,
      expectedRevision: 0,
      ...mapping(),
      now: () => NOW
    });
    expect(applied).toMatchObject({ status: 'complete', revision: 1 });
    const agents = JSON.parse(await readFile(path.join(rootPath, '.orquesta', 'state', 'agents.json'), 'utf8')) as {
      organization_migration: { status: string; mapped_line_by_agent: Record<string, string> };
    };
    expect(agents.organization_migration).toMatchObject({
      status: 'complete',
      mapped_line_by_agent: { 'implementation-001': 'primary-line' }
    });

    const repeated = await api.applyLegacyOrganizationMigration!({
      projectId: 'legacy-project',
      rootPath,
      expectedRevision: 1,
      ...mapping(),
      now: () => '2026-07-28T05:05:00.000Z'
    });
    expect(repeated).toMatchObject({ status: 'complete', revision: 1 });
  });

  test('rejects stale or invalid reviewed mappings without writing an intermediate migration', async () => {
    const rootPath = await legacyRepository();
    const invalid = {
      ...mapping(),
      assignments: [{
        agent_id: 'implementation-001',
        team_id: 'missing-team',
        position: 'member',
        ordinal: 1
      }]
    };

    await expect(migrationModule.applyLegacyOrganizationMigration({
      projectId: 'legacy-project',
      rootPath,
      expectedRevision: 1,
      ...mapping(),
      now: () => NOW
    })).rejects.toThrow(/revision/i);
    await expect(migrationModule.applyLegacyOrganizationMigration({
      projectId: 'legacy-project',
      rootPath,
      expectedRevision: 0,
      ...invalid,
      now: () => NOW
    })).rejects.toThrow(/unknown team_id/i);
    await expect(readFile(path.join(rootPath, '.orquesta', 'state', 'organization.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(rootPath, '.orquesta', 'state', 'roles.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('completes an empty exact mapping when the legacy project has no production agents', async () => {
    const rootPath = await legacyRepository();
    const agentsPath = path.join(rootPath, '.orquesta', 'state', 'agents.json');
    await writeJson(agentsPath, {
      version: 1,
      agents: [{ agent_id: 'orchestrator', role: 'orchestrator', status: 'active', thread_id: 'thread-orchestrator' }]
    });

    const preview = await migrationModule.readLegacyOrganizationMigration({
      projectId: 'foundation-only',
      rootPath,
      now: () => NOW
    });
    expect(preview).toMatchObject({ status: 'review_required', revision: 0, unassignedProductionAgentIds: [] });

    await expect(migrationModule.applyLegacyOrganizationMigration({
      projectId: 'foundation-only',
      rootPath,
      expectedRevision: 0,
      lines: [],
      teams: [],
      assignments: [],
      now: () => NOW
    })).resolves.toMatchObject({ status: 'complete', revision: 1 });
  });
});

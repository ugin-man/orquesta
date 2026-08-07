import { access } from 'node:fs/promises';
import path from 'node:path';
// The canonical migration stays in the Orquesta core. esbuild bundles this
// CommonJS module into Desktop's isolated Core worker for packaged builds.
// @ts-expect-error The canonical CommonJS module does not publish TypeScript declarations.
import organizationStateModule from '../../../../orquesta/scripts/organization-state.js';

type JsonRecord = Record<string, unknown>;

interface OrganizationBundle {
  rolesState: JsonRecord;
  agentsState: JsonRecord & { agents?: unknown[] };
  organizationState: JsonRecord;
  sessionsState: JsonRecord;
  tasksState: JsonRecord;
}

interface OrganizationStateModule {
  readOrganizationBundle(root: string): OrganizationBundle;
  migrateLegacyOrganization(input: {
    projectId: string;
    agentsState: JsonRecord;
    sessionsState: JsonRecord;
    tasksState: JsonRecord;
    now: string;
  }): OrganizationBundle;
  repairLegacyOrganizationMigration(input: {
    rolesState: JsonRecord;
    agentsState: JsonRecord;
    organizationState: JsonRecord;
    sessionsState: JsonRecord;
    tasksState: JsonRecord;
    now: string;
  }): { changed: boolean; bundle: OrganizationBundle };
  resolveLegacyOrganizationMigration(input: {
    rolesState: JsonRecord;
    agentsState: JsonRecord;
    organizationState: JsonRecord;
    sessionsState: JsonRecord;
    tasksState: JsonRecord;
    lines: JsonRecord[];
    teams: JsonRecord[];
    assignments: JsonRecord[];
    now: string;
  }): OrganizationBundle;
  commitOrganizationTransition(input: {
    root: string;
    expectedRevision: number;
    bundle: OrganizationBundle;
    now: string;
  }): { status: string; revision: number; manifestPath: string };
}

const organizationState = organizationStateModule as OrganizationStateModule;

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export interface LegacyOrganizationMigrationPreview {
  status: 'not_applicable' | 'current' | 'review_required' | 'complete';
  revision: number;
  unassignedProductionAgentIds: string[];
  diagnostics: unknown[];
}

interface LegacyOrganizationMigrationMapping {
  lines: JsonRecord[];
  teams: JsonRecord[];
  assignments: JsonRecord[];
}

function previewFromBundle(
  bundle: OrganizationBundle,
  fallbackStatus: LegacyOrganizationMigrationPreview['status'] = 'current',
  revision = Number(bundle.organizationState.revision ?? 0)
): LegacyOrganizationMigrationPreview {
  const migration = object(bundle.agentsState.organization_migration);
  const rawStatus = String(migration.status ?? '');
  const status = rawStatus === 'review_required' || rawStatus === 'complete'
    ? rawStatus
    : fallbackStatus;
  return {
    status,
    revision,
    unassignedProductionAgentIds: Array.isArray(migration.unassigned_production_agent_ids)
      ? migration.unassigned_production_agent_ids.map(String)
      : [],
    diagnostics: Array.isArray(migration.diagnostics) ? structuredClone(migration.diagnostics) : []
  };
}

function withOrganizationRevision(bundle: OrganizationBundle, revision: number): OrganizationBundle {
  return {
    ...bundle,
    rolesState: { ...bundle.rolesState, organization_revision: revision },
    agentsState: { ...bundle.agentsState, organization_revision: revision },
    organizationState: { ...bundle.organizationState, revision }
  };
}

function object(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

async function organizationFileState(rootPath: string): Promise<{
  agentsExists: boolean;
  rolesExist: boolean;
  organizationExists: boolean;
}> {
  const stateRoot = path.join(rootPath, '.orquesta', 'state');
  const [agentsExists, rolesExist, organizationExists] = await Promise.all([
    exists(path.join(stateRoot, 'agents.json')),
    exists(path.join(stateRoot, 'roles.json')),
    exists(path.join(stateRoot, 'organization.json'))
  ]);
  if (rolesExist !== organizationExists) {
    throw new Error('Incomplete organization state: roles.json and organization.json must either both exist or both be absent');
  }
  return { agentsExists, rolesExist, organizationExists };
}

function validateRoot(rootPath: string): void {
  if (!path.isAbsolute(rootPath)) throw new Error('Organization migration requires an absolute repository root');
}

export function assertExplicitOrganizationState(input: {
  agentsState: unknown;
  rolesState: unknown;
  organizationState: unknown;
}): void {
  const rolesExist = input.rolesState !== undefined;
  const organizationExists = input.organizationState !== undefined;
  if (rolesExist !== organizationExists) {
    throw new Error('Incomplete organization state: roles.json and organization.json must either both exist or both be absent');
  }
  if (input.agentsState === undefined) return;
  if (rolesExist) return;

  const agentsState = object(input.agentsState);
  if (!Array.isArray(agentsState.agents)) {
    throw new Error('Invalid legacy organization state: agents.json must contain an agents array');
  }
  if (agentsState.agents.length === 0) return;
  if (agentsState.schema_version === 2) {
    throw new Error('Incomplete organization state: schema v2 agents exist without roles.json and organization.json');
  }
  throw new Error('legacy_organization_requires_explicit_migration');
}

function legacyBundle(input: {
  projectId: string;
  rootPath: string;
  timestamp: string;
}): OrganizationBundle {
  const stateRoot = path.join(input.rootPath, '.orquesta', 'state');
  const current = organizationState.readOrganizationBundle(input.rootPath);
  const agentsState = current.agentsState;
  if (!Array.isArray(agentsState.agents)) {
    throw new Error(`Invalid legacy organization state: ${path.join(stateRoot, 'agents.json')} must contain an agents array`);
  }
  if (agentsState.schema_version === 2) {
    throw new Error('Incomplete organization state: schema v2 agents exist without roles.json and organization.json');
  }
  return organizationState.migrateLegacyOrganization({
    projectId: input.projectId,
    agentsState,
    sessionsState: current.sessionsState,
    tasksState: current.tasksState,
    now: input.timestamp
  });
}

export async function readLegacyOrganizationMigration(input: {
  projectId: string;
  rootPath: string;
  now?: () => string;
}): Promise<LegacyOrganizationMigrationPreview> {
  validateRoot(input.rootPath);
  const files = await organizationFileState(input.rootPath);
  if (!files.agentsExists) {
    return { status: 'not_applicable', revision: 0, unassignedProductionAgentIds: [], diagnostics: [] };
  }
  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  if (!files.rolesExist) {
    const bundle = legacyBundle({ projectId: input.projectId, rootPath: input.rootPath, timestamp });
    if (!(bundle.agentsState.agents as unknown[] | undefined)?.length) {
      return { status: 'not_applicable', revision: 0, unassignedProductionAgentIds: [], diagnostics: [] };
    }
    return previewFromBundle(bundle, 'review_required', 0);
  }
  const current = organizationState.readOrganizationBundle(input.rootPath);
  const repaired = organizationState.repairLegacyOrganizationMigration({
    rolesState: current.rolesState,
    agentsState: current.agentsState,
    organizationState: current.organizationState,
    sessionsState: current.sessionsState,
    tasksState: current.tasksState,
    now: timestamp
  });
  return previewFromBundle(repaired.bundle, 'current', Number(current.organizationState.revision ?? 0));
}

export async function applyLegacyOrganizationMigration(input: {
  projectId: string;
  rootPath: string;
  expectedRevision: number;
  now?: () => string;
} & LegacyOrganizationMigrationMapping): Promise<LegacyOrganizationMigrationPreview> {
  validateRoot(input.rootPath);
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new Error('Organization migration requires a nonnegative reviewed revision');
  }
  const files = await organizationFileState(input.rootPath);
  if (!files.agentsExists) throw new Error('Legacy organization migration is not applicable');
  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  let current: OrganizationBundle;
  let currentRevision: number;

  if (!files.rolesExist) {
    current = legacyBundle({ projectId: input.projectId, rootPath: input.rootPath, timestamp });
    if (!(current.agentsState.agents as unknown[] | undefined)?.length) {
      throw new Error('Legacy organization migration is not applicable');
    }
    currentRevision = 0;
  } else {
    current = organizationState.readOrganizationBundle(input.rootPath);
    currentRevision = Number(current.organizationState.revision ?? 0);
    if (input.expectedRevision !== currentRevision) {
      throw new Error(`Organization migration revision conflict: reviewed ${input.expectedRevision}, found ${currentRevision}`);
    }
    if (object(current.agentsState.organization_migration).status === 'complete') {
      return previewFromBundle(current);
    }
    const repaired = organizationState.repairLegacyOrganizationMigration({
      rolesState: current.rolesState,
      agentsState: current.agentsState,
      organizationState: current.organizationState,
      sessionsState: current.sessionsState,
      tasksState: current.tasksState,
      now: timestamp
    });
    current = repaired.bundle;
  }
  if (input.expectedRevision !== currentRevision) {
    throw new Error(`Organization migration revision conflict: reviewed ${input.expectedRevision}, found ${currentRevision}`);
  }

  const resolved = organizationState.resolveLegacyOrganizationMigration({
    ...withOrganizationRevision(current, currentRevision),
    sessionsState: current.sessionsState,
    tasksState: current.tasksState,
    lines: structuredClone(input.lines),
    teams: structuredClone(input.teams),
    assignments: structuredClone(input.assignments),
    now: timestamp
  });
  if (resolved.organizationState.revision !== currentRevision) {
    organizationState.commitOrganizationTransition({
      root: input.rootPath,
      expectedRevision: currentRevision,
      bundle: resolved,
      now: timestamp
    });
  }
  return previewFromBundle(resolved);
}

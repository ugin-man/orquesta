import { access, readFile } from 'node:fs/promises';
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

async function readJsonObject(filePath: string): Promise<JsonRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid JSON object: ${filePath}`);
  }
  return parsed as JsonRecord;
}

export type LegacyOrganizationMigrationResult = 'current' | 'migrated' | 'repaired' | 'not_applicable';

export async function ensureLegacyOrganizationState(input: {
  projectId: string;
  rootPath: string;
  now?: () => string;
}): Promise<LegacyOrganizationMigrationResult> {
  if (!path.isAbsolute(input.rootPath)) throw new Error('Organization migration requires an absolute repository root');
  const stateRoot = path.join(input.rootPath, '.orquesta', 'state');
  const agentsPath = path.join(stateRoot, 'agents.json');
  const rolesPath = path.join(stateRoot, 'roles.json');
  const organizationPath = path.join(stateRoot, 'organization.json');
  const [agentsExists, rolesExist, organizationExists] = await Promise.all([
    exists(agentsPath),
    exists(rolesPath),
    exists(organizationPath)
  ]);

  if (rolesExist && organizationExists) {
    const timestamp = (input.now ?? (() => new Date().toISOString()))();
    const current = organizationState.readOrganizationBundle(input.rootPath);
    const repaired = organizationState.repairLegacyOrganizationMigration({
      rolesState: current.rolesState,
      agentsState: current.agentsState,
      organizationState: current.organizationState,
      sessionsState: current.sessionsState,
      tasksState: current.tasksState,
      now: timestamp
    });
    if (!repaired.changed) return 'current';
    organizationState.commitOrganizationTransition({
      root: input.rootPath,
      expectedRevision: Number(current.organizationState.revision ?? 0),
      bundle: repaired.bundle,
      now: timestamp
    });
    return 'repaired';
  }
  if (rolesExist !== organizationExists) {
    throw new Error('Incomplete organization state: roles.json and organization.json must either both exist or both be absent');
  }
  if (!agentsExists) return 'not_applicable';

  const agentsState = await readJsonObject(agentsPath);
  if (!Array.isArray(agentsState.agents)) throw new Error('Invalid legacy organization state: agents.json must contain an agents array');
  if (agentsState.schema_version === 2) {
    throw new Error('Incomplete organization state: schema v2 agents exist without roles.json and organization.json');
  }
  if (agentsState.agents.length === 0) return 'not_applicable';

  const timestamp = (input.now ?? (() => new Date().toISOString()))();
  const current = organizationState.readOrganizationBundle(input.rootPath);
  const migrated = organizationState.migrateLegacyOrganization({
    projectId: input.projectId,
    agentsState,
    sessionsState: current.sessionsState,
    tasksState: current.tasksState,
    now: timestamp
  });
  organizationState.commitOrganizationTransition({
    root: input.rootPath,
    expectedRevision: 0,
    bundle: migrated,
    now: timestamp
  });
  return 'migrated';
}

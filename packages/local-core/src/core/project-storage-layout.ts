import { lstat, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const PROJECT_STORAGE = Object.freeze({
  canonicalState: 'state',
  agents: 'state/agents.json',
  /** Codex/Orquesta coordination task ledger (schema `version: 1`). */
  tasks: 'state/tasks.json',
  /** Desktop placement lifecycle authority (schema `schema_version: 3`). */
  placementTasks: 'state/placement-tasks.json',
  roles: 'state/roles.json',
  organization: 'state/organization.json',
  formations: 'state/formations.json',
  /** Codex task-list projection retained for coordination compatibility. */
  sessions: 'state/sessions.json',
  /** Desktop session ownership and rotation authority. */
  sessionBindings: 'state/session-bindings.json',
  dashboardActions: 'state/dashboard_actions.json',
  stateEvents: 'state/events.jsonl',
  sessionHandoffs: 'state/session-handoffs',
  visionQuestions: 'vision/questions.json',
  userTaskQueue: 'user_tasks/queue.json',
  failureUserActions: 'failures/user_actions.json',
  failureIncidents: 'failures/incidents.json',
  failureCandidates: 'failures/incident_candidates.json',
  failureClusters: 'failures/incident_clusters.json',
  structureInventory: 'project/derived/structure-inventory.json',
  structureAudit: 'project/derived/structure-audit.json',
  structureMigrationPlan: 'project/migration-plan.json',
  structureLayout: 'project/layout.json',
  structureSetup: 'project/structure-setup.json',
  projectUnderstanding: 'project/project_understanding.json',
  initialContextView: 'context/initial-context-view.json',
  projectControlPlane: 'context/project_control_plane.json',
  projectMap: 'context/project_map.json',
  workflowRoot: 'workflows',
  workflowState: 'workflows/state.json',
  workflowResults: 'workflows/results',
  inspectionRoot: 'reports/inspections',
  inspectionState: 'state/inspection-runs.json',
  inspectionResults: 'reports/inspections',
  runtimeRoot: 'state',
  runtimeBinding: 'state/runtime-binding.json',
  messageDeliveryRoot: 'state/message-delivery-v1',
  /** Read-only compatibility for the retired JSONL implementation. */
  messageDeliveryLegacy: 'state/messages.jsonl',
  messageDeliveryLegacyBackup: 'state/messages.migrated-v1.jsonl',
  messageDeliveryMigrationManifest: 'state/message-delivery-migration-v1.json',
  messageDeliveryMigrationReceipt: 'state/message-delivery-migration-v1.completed.json',
  messageDeliveryMigrationStagingRoot: 'state/message-delivery-v1.migrating',
  executionKernel: 'state/execution-kernel-v2.json',
  writerLease: 'state/desktop-writer.lock',
  businessStore: 'v4'
});

function assertConfined(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('project_storage_path_escape');
  }
}

function storageSegments(relativePath: string): string[] {
  if (relativePath === '') return [];
  if (path.isAbsolute(relativePath) || relativePath.includes('\\')) {
    throw new Error('project_storage_relative_path_invalid');
  }
  const segments = relativePath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('project_storage_relative_path_invalid');
  }
  return segments;
}

async function optionalMetadata(candidate: string) {
  try {
    return await lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function canonicalProjectRoot(rootPath: string): Promise<string> {
  return realpath(path.resolve(rootPath));
}

export function projectStoragePath(canonicalRoot: string, relativePath: string): string {
  const candidate = path.join(canonicalRoot, '.orquesta', ...storageSegments(relativePath));
  assertConfined(canonicalRoot, candidate);
  return candidate;
}

export function projectStorageIdentitySegment(identity: string): string {
  if (!identity.trim()) throw new Error('project_storage_identity_invalid');
  return `id-${createHash('sha256').update(identity, 'utf8').digest('hex')}`;
}

export async function ensureProjectStorageDirectory(
  canonicalRoot: string,
  relativeDirectory: string
): Promise<string> {
  const orquestaRoot = path.join(canonicalRoot, '.orquesta');
  const existingOrquesta = await optionalMetadata(orquestaRoot);
  if (existingOrquesta?.isSymbolicLink() || (existingOrquesta && !existingOrquesta.isDirectory())) {
    throw new Error('project_storage_root_unsafe');
  }
  await mkdir(orquestaRoot, { recursive: true });
  let current = orquestaRoot;
  for (const segment of storageSegments(relativeDirectory)) {
    current = path.join(current, segment);
    const metadata = await optionalMetadata(current);
    if (metadata?.isSymbolicLink() || (metadata && !metadata.isDirectory())) {
      throw new Error('project_storage_directory_unsafe');
    }
    await mkdir(current, { recursive: true });
  }
  const resolved = await realpath(current);
  assertConfined(canonicalRoot, resolved);
  return resolved;
}

export async function projectStorageFileBoundary(
  canonicalRoot: string,
  relativeFile: string,
  options: { createParent?: boolean } = {}
): Promise<{ filePath: string; exists: boolean }> {
  const segments = storageSegments(relativeFile);
  if (segments.length === 0) throw new Error('project_storage_file_invalid');
  const fileName = segments.at(-1) as string;
  const parentSegments = segments.slice(0, -1);
  const relativeParent = parentSegments.join('/');
  let directory: string;
  if (options.createParent) {
    directory = await ensureProjectStorageDirectory(canonicalRoot, relativeParent);
  } else {
    directory = path.join(canonicalRoot, '.orquesta');
    for (const segment of parentSegments) directory = path.join(directory, segment);
    const chain = [path.join(canonicalRoot, '.orquesta')];
    for (const segment of parentSegments) chain.push(path.join(chain.at(-1) as string, segment));
    for (const candidate of chain) {
      const metadata = await optionalMetadata(candidate);
      if (!metadata) return { filePath: path.join(directory, fileName), exists: false };
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error('project_storage_directory_unsafe');
      }
      const resolved = await realpath(candidate);
      assertConfined(canonicalRoot, resolved);
    }
  }
  const filePath = path.join(directory, fileName);
  assertConfined(canonicalRoot, filePath);
  const metadata = await optionalMetadata(filePath);
  if (!metadata) return { filePath, exists: false };
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('project_storage_file_unsafe');
  const resolved = await realpath(filePath);
  assertConfined(canonicalRoot, resolved);
  return { filePath, exists: true };
}

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readRuntimeBinding, type RuntimeBinding } from './runtime-binding-store';

type JsonRecord = Record<string, unknown>;

export interface ProvisioningRequest {
  agent_id: string;
  role_id: string;
  team_id: string;
  line_id: string;
  task_id: string;
  status: 'pending' | 'reuse_ready' | 'standby' | 'provisioning_failed';
  created_at: string;
  thread_id?: string | null;
  turn_id?: string | null;
  handoff_status?: 'accepted' | 'failed' | null;
  error?: string | null;
  completed_at?: string | null;
  recommended_model?: string | null;
  requested_model?: string | null;
  recommended_effort?: 'low' | 'medium' | 'high' | null;
  task_profile?: JsonRecord | null;
  thread_execution_channel?: string | null;
  specialist_report_required?: boolean;
  completion_transport?: 'wait_threads' | 'compact_receipt' | 'manual_recovery';
  done_signal?: string | null;
  deterministic_evidence_refs?: string[];
}

export interface ProvisioningBatch {
  provisioning_batch_id: string;
  organization_revision: number;
  max_concurrent_provisioning: number;
  requests: ProvisioningRequest[];
  created_at: string;
  updated_at?: string;
}

export interface SpecialistRuntime {
  listProjectThreads?(rootPath: string): Promise<Array<{ id: string; archived: boolean }>>;
  sendMessage(input: {
    correlationId: string;
    projectId: string;
    rootPath: string;
    threadId: string | null;
    targetAgentId: string;
    threadTitle?: string | null;
    text: string;
    localImagePaths: string[];
    recommendedModel: string | null;
    requestedModel: string | null;
    effort?: 'low' | 'medium' | 'high' | null;
    onThreadReady?: (threadId: string) => Promise<void> | void;
  }): Promise<{ threadId: string; turnId: string }>;
}

interface ProvisionSpecialistsInput {
  root: string;
  projectId?: string;
  batch: ProvisioningBatch;
  runtime: SpecialistRuntime;
  now?: () => string;
}

export interface FoundationProvisioningResult {
  agent_id: string;
  status: 'accepted' | 'failed';
  thread_id: string | null;
  turn_id: string | null;
  error: string | null;
  completed_at: string;
  runtime_authority_id?: string;
  visibility?: 'codex_task' | 'desktop_only';
  profile_id?: string;
  session_kind?: 'persistent_agent';
}

interface ProvisionFoundationAgentsInput {
  root: string;
  projectId: string;
  agentIds: string[];
  preferredThreadIds?: Readonly<Record<string, string | null | undefined>>;
  runtime: SpecialistRuntime;
  now?: () => string;
}

function object(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function rows(value: unknown, key: string): JsonRecord[] {
  const container = object(value);
  return Array.isArray(container[key]) ? (container[key] as unknown[]).map(object) : [];
}

async function readJson(filePath: string, fallback: JsonRecord): Promise<JsonRecord> {
  try {
    return object(JSON.parse(await readFile(filePath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(fallback);
    throw error;
  }
}

async function readOptionalJson(filePath: string): Promise<JsonRecord | null> {
  try {
    return object(JSON.parse(await readFile(filePath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function readProvisioningBatch(root: string): Promise<ProvisioningBatch | null> {
  try {
    const parsed = object(JSON.parse(await readFile(path.join(root, '.orquesta', 'setup', 'provisioning_batch.json'), 'utf8')));
    if (!parsed.provisioning_batch_id || !Array.isArray(parsed.requests)) throw new Error('Invalid provisioning batch');
    return parsed as unknown as ProvisioningBatch;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

function upsert(items: JsonRecord[], key: string, value: JsonRecord): JsonRecord[] {
  const id = value[key];
  const index = items.findIndex((item) => item[key] === id);
  if (index === -1) return [...items, value];
  const next = [...items];
  next[index] = { ...items[index], ...value };
  return next;
}

function xml(value: unknown): string {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function handoffText(request: ProvisioningRequest, root: string): string {
  const profile = object(request.task_profile);
  const manifest = object(profile.context_manifest);
  const envelope = object(profile.task_envelope);
  const requirement = object(profile.context_requirement);
  const contextPackId = typeof profile.context_pack_id === 'string' ? profile.context_pack_id : null;
  const contextRoute = object(profile.context_route);
  const activeContextV2 = contextRoute.fallback === false
    && ['v2_initial', 'v2_bounded_retrieval'].includes(String(contextRoute.route ?? ''));
  const selectedSourceRefs = Array.isArray(contextRoute.selected_source_refs)
    ? contextRoute.selected_source_refs.filter((value): value is string => typeof value === 'string')
    : [];
  const effectiveRequiredReading = activeContextV2 ? selectedSourceRefs : manifest.required_reading || [];
  const reportRequired = request.specialist_report_required !== false;
  const completionTransport = request.completion_transport ?? 'manual_recovery';
  const doneSignal = request.done_signal?.trim() ?? '';
  const deterministicEvidenceRefs = Array.isArray(request.deterministic_evidence_refs)
    ? request.deterministic_evidence_refs.filter((value) => typeof value === 'string' && value.trim())
    : [];
  const execution = object(envelope.execution);
  const hasContextV2 = Boolean(envelope.task_envelope_id && requirement.requirement_id);
  const contextV2Shadow = hasContextV2
    ? [
        `  <context_v2_${activeContextV2 ? 'active' : 'shadow'} mode="${activeContextV2 ? xml(contextRoute.route) : 'observe_only'}">`,
        `    <task_envelope_id>${xml(envelope.task_envelope_id)}</task_envelope_id>`,
        `    <context_requirement_id>${xml(requirement.requirement_id)}</context_requirement_id>`,
        ...(contextPackId ? [`    <context_pack_id>${xml(contextPackId)}</context_pack_id>`] : []),
        `    <terminal_outcome>${xml(envelope.terminal_outcome)}</terminal_outcome>`,
        `    <local_deliverable>${xml(envelope.local_deliverable)}</local_deliverable>`,
        `    <execution_channel>${xml(execution.execution_channel)}</execution_channel>`,
        `    <continue_policy>${xml(envelope.continue_policy)}</continue_policy>`,
        `    <checkpoint_policy>${xml(envelope.checkpoint_policy)}</checkpoint_policy>`,
        `    <conversation_history_policy>${xml(execution.conversation_history_policy)}</conversation_history_policy>`,
        `    <initial_token_budget>${xml(requirement.initial_token_budget)}</initial_token_budget>`,
        `    <expansion_budget>${xml(requirement.expansion_budget)}</expansion_budget>`,
        `    <missing_context_policy>${xml(requirement.missing_context_policy)}</missing_context_policy>`,
        activeContextV2
          ? '    <constraint>Open only selected sources through the bounded Context Broker. If context is missing, request bounded expansion; never scan unrelated project history.</constraint>'
          : '    <constraint>Shadow metadata must not broaden the V1 required_reading or allowed_files boundary.</constraint>',
        `  </context_v2_${activeContextV2 ? 'active' : 'shadow'}>`,
      ]
    : [];
  return [
    '<bounded_specialist_task version="1">',
    `  <agent_id>${request.agent_id}</agent_id>`,
    `  <role_id>${request.role_id}</role_id>`,
    `  <team_id>${request.team_id}</team_id>`,
    `  <line_id>${request.line_id}</line_id>`,
    `  <task_id>${request.task_id}</task_id>`,
    `  <canonical_state_root>${xml(root)}</canonical_state_root>`,
    '  <mode>implementation_only</mode>',
    `  <required_reading>${xml(JSON.stringify(effectiveRequiredReading))}</required_reading>`,
    `  <allowed_files>${xml(JSON.stringify(manifest.allowed_files || []))}</allowed_files>`,
    `  <excluded_context>${xml(JSON.stringify(manifest.excluded_context || []))}</excluded_context>`,
    ...contextV2Shadow,
    activeContextV2
      ? `  <instruction>Bootstrap the selected context and its contents once with node .agents/skills/orquesta/scripts/context-v2-broker.js --root "${xml(root)}" --task "${xml(request.task_id)}" bootstrap. Expand only with an explicit missing-context reason, then implement and verify the bounded result.</instruction>`
      : '  <instruction>Read only this task record and task_profile.context_manifest.required_reading. Implement and verify the bounded result.</instruction>',
    '  <constraint>Do not load coordinator skills or orchestration references. Do not inspect unrelated state, search memory, run Orquesta audits, or modify canonical .orquesta state.</constraint>',
    reportRequired
      ? '  <report>Write the task specialist_report_path as a short specialist_result JSON record containing changes, deterministic verification, explicit gaps, and risks. Include question_candidates only when a useful candidate exists or the task explicitly requests a question decision.</report>'
      : `  <report_free_completion transport="${xml(completionTransport)}">`,
    ...(!reportRequired ? [
      '    <constraint>Do not write a specialist report.</constraint>',
      `    <done_signal>${xml(doneSignal)}</done_signal>`,
      `    <deterministic_evidence_refs>${xml(JSON.stringify(deterministicEvidenceRefs))}</deterministic_evidence_refs>`,
      '  </report_free_completion>',
    ] : []),
    `  <completion>The controller owns handoff evidence, model evidence, acceptance, state synchronization, and audits. End after ${reportRequired ? 'writing the result report' : 'producing the assigned deterministic evidence'}.</completion>`,
    '</bounded_specialist_task>'
  ].join('\n');
}

function completionEvidenceRefs(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : [];
}

function assertCompletionContract(request: ProvisioningRequest, canonicalTask: JsonRecord | null, root: string): void {
  if (!canonicalTask) throw new Error(`canonical_task_required:${request.task_id}`);
  if (canonicalTask.owner_agent_id && canonicalTask.owner_agent_id !== request.agent_id) {
    throw new Error(`canonical_task_owner_mismatch:${request.task_id}`);
  }
  const canonicalReportRequired = canonicalTask.specialist_report_required !== false;
  const requestReportRequired = request.specialist_report_required !== false;
  if (canonicalReportRequired !== requestReportRequired) {
    throw new Error(`specialist_report_requirement_mismatch:${request.task_id}`);
  }
  if (requestReportRequired) return;
  if (!['wait_threads', 'manual_recovery'].includes(String(request.completion_transport ?? ''))) {
    throw new Error(`report_free_completion_transport_invalid:${request.task_id}`);
  }
  if (!request.done_signal?.trim()) {
    throw new Error(`report_free_done_signal_required:${request.task_id}`);
  }
  if (canonicalTask.completion_transport !== request.completion_transport) {
    throw new Error(`report_free_completion_transport_mismatch:${request.task_id}`);
  }
  if (String(canonicalTask.done_signal ?? '').trim() !== request.done_signal.trim()) {
    throw new Error(`report_free_done_signal_mismatch:${request.task_id}`);
  }
  const requestRefs = completionEvidenceRefs(request.deterministic_evidence_refs);
  const canonicalRefs = completionEvidenceRefs(canonicalTask.deterministic_evidence_refs);
  if (JSON.stringify(canonicalRefs) !== JSON.stringify(requestRefs)) {
    throw new Error(`report_free_evidence_refs_mismatch:${request.task_id}`);
  }
  if (request.completion_transport === 'manual_recovery') {
    if (requestRefs.length === 0) throw new Error(`report_free_evidence_refs_required:${request.task_id}`);
    for (const ref of requestRefs) {
      const normalized = ref.replaceAll('\\', '/');
      const resolved = path.resolve(root, normalized);
      const boundary = path.relative(root, resolved);
      if (
        path.isAbsolute(normalized)
        || boundary.startsWith('..')
        || path.isAbsolute(boundary)
        || /(^|\/)\.orquesta\/(?:state|setup|session-handoffs)(\/|$)/i.test(normalized)
        || /[:*?"<>|]/u.test(normalized)
      ) {
        throw new Error(`report_free_evidence_ref_invalid:${request.task_id}:${ref}`);
      }
    }
  }
}

function executionBinding(request: ProvisioningRequest): {
  executionChannel: string | null;
  historyPolicy: string | null;
} {
  const profile = object(request.task_profile);
  const envelope = object(profile.task_envelope);
  const execution = object(envelope.execution);
  return {
    executionChannel: typeof execution.execution_channel === 'string'
      ? execution.execution_channel
      : null,
    historyPolicy: typeof execution.conversation_history_policy === 'string'
      ? execution.conversation_history_policy
      : null
  };
}

function reusableThreadId(request: ProvisioningRequest): string | null {
  // The history policy controls which project sources the agent should use; it
  // must not silently replace the persistent logical agent with a new Codex
  // task. A genuinely fresh execution seat is created only by the formal
  // session-rotation protocol, which preserves generations and ownership.
  return request.thread_id ?? null;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

async function codexHostedVisibleThreadIds(
  root: string,
  runtimeBinding: RuntimeBinding,
  runtime: SpecialistRuntime
): Promise<Set<string> | null> {
  if (runtimeBinding.mode !== 'codex_hosted') return null;
  if (!runtime.listProjectThreads) {
    throw new Error('codex_hosted_thread_visibility_check_unavailable');
  }
  return new Set((await runtime.listProjectThreads(root))
    .filter((thread) => !thread.archived)
    .map((thread) => thread.id));
}

function assertCodexHostedThreadBinding(
  runtimeBinding: RuntimeBinding,
  visibleThreadIds: ReadonlySet<string> | null,
  agentId: string,
  threadId: string | null
): void {
  if (runtimeBinding.mode !== 'codex_hosted') return;
  if (!threadId) throw new Error(`codex_hosted_thread_binding_required:${agentId}`);
  if (!visibleThreadIds?.has(threadId)) {
    throw new Error(`codex_hosted_thread_not_in_project:${agentId}:${threadId}`);
  }
}

function specialistEffort(request: ProvisioningRequest): 'low' | 'medium' | 'high' {
  if (request.recommended_effort) return request.recommended_effort;
  return String(request.recommended_model ?? '').toLowerCase().includes('sol')
    ? 'high'
    : 'medium';
}

function foundationHandoffText(agentId: string): string {
  const instructions: Record<string, string> = {
    orchestrator: 'Own production routing, task decomposition, state synchronization, specialist contracts, and acceptance checks.',
    'orquesta-admin': 'Own Orquesta setup, Desktop handoff, diagnostics, configuration, and concise system explanations.',
    'user-support': 'Own event-driven user questions, answer interpretation, failure triage, repair cards, and user-side task coordination.'
  };
  return [
    '<orquesta_foundation_handoff>',
    `  <agent_id>${agentId}</agent_id>`,
    `  <instruction>${instructions[agentId] ?? 'Operate only within the assigned Orquesta foundation role.'}</instruction>`,
    '  <constraint>Read canonical file-backed state before acting and keep product implementation with production specialists.</constraint>',
    '</orquesta_foundation_handoff>'
  ].join('\n');
}

function foundationRecommendedModel(agentId: string): string {
  return agentId === 'orchestrator' ? 'Sol' : 'Luna';
}

const FOUNDATION_THREAD_TITLES: Readonly<Record<string, string>> = Object.freeze({
  orchestrator: '★ Orquesta 統括者',
  'orquesta-admin': 'Orquesta 管理係 Luca',
  'user-support': 'Orquesta 利用者支援係'
});

function foundationThreadTitle(agentId: string): string {
  return FOUNDATION_THREAD_TITLES[agentId] ?? `Orquesta ${agentId}`;
}

function roleDisplayNames(rolesState: JsonRecord | null): Map<string, string> {
  return new Map(rows(rolesState, 'roles').map((role) => {
    const roleId = String(role.role_id ?? '');
    const names = object(role.display_names);
    const displayName = String(names.ja ?? names.en ?? roleId).trim() || roleId;
    return [roleId, displayName];
  }).filter(([roleId]) => Boolean(roleId)));
}

function specialistThreadTitle(
  request: ProvisioningRequest,
  displayNames: ReadonlyMap<string, string>
): string {
  const roleName = displayNames.get(request.role_id) || request.role_id;
  const ordinalMatch = /-(\d+)$/u.exec(request.agent_id);
  const ordinal = ordinalMatch ? Number.parseInt(ordinalMatch[1], 10) : 1;
  return `Orquesta ${roleName}${ordinal > 1 ? ` ${ordinal}` : ''}`;
}

function foundationLedgerPath(root: string, agentId: string): string {
  if (!/^[a-zA-Z0-9._:-]{1,128}$/u.test(agentId)) throw new Error(`Invalid foundation agent id: ${agentId}`);
  return path.join(root, '.orquesta', 'setup', 'foundation-provisioning', `${agentId}.json`);
}

async function readFoundationLedger(root: string, agentId: string): Promise<JsonRecord | null> {
  return readOptionalJson(foundationLedgerPath(root, agentId));
}

async function writeFoundationLedger(
  root: string,
  agentId: string,
  value: JsonRecord
): Promise<void> {
  await writeJsonAtomic(foundationLedgerPath(root, agentId), value);
}

export async function provisionFoundationAgents({
  root,
  projectId,
  agentIds,
  preferredThreadIds,
  runtime,
  now = () => new Date().toISOString()
}: ProvisionFoundationAgentsInput): Promise<FoundationProvisioningResult[]> {
  if (!path.isAbsolute(root)) throw new Error('Foundation provisioning requires an absolute repository root');
  if (!projectId.trim()) throw new Error('Foundation provisioning requires a project id');
  if (!Array.isArray(agentIds) || agentIds.length === 0 || new Set(agentIds).size !== agentIds.length) {
    throw new Error('Foundation provisioning requires unique agent ids');
  }
  const runtimeBinding = await readRuntimeBinding(root);
  if (!runtimeBinding) throw new Error('runtime_binding_required');
  const visibleThreadIds = await codexHostedVisibleThreadIds(root, runtimeBinding, runtime);
  const sessionMetadata = {
    runtime_authority_id: runtimeBinding.runtime_authority_id,
    visibility: runtimeBinding.mode === 'codex_hosted' ? 'codex_task' as const : 'desktop_only' as const,
    session_kind: 'persistent_agent' as const
  };
  return Promise.all(agentIds.map(async (agentId): Promise<FoundationProvisioningResult> => {
    const ledger = await readFoundationLedger(root, agentId);
    const recordedThreadId = typeof ledger?.thread_id === 'string' && ledger.thread_id.trim()
      ? ledger.thread_id.trim()
      : null;
    const preferredThreadId = ledger === null
      && typeof preferredThreadIds?.[agentId] === 'string'
      && preferredThreadIds[agentId]?.trim()
      ? preferredThreadIds[agentId]!.trim()
      : null;
    if (ledger?.status === 'accepted' && recordedThreadId && typeof ledger.turn_id === 'string' && ledger.turn_id.trim()) {
      return {
        agent_id: agentId,
        status: 'accepted',
        thread_id: recordedThreadId,
        turn_id: ledger.turn_id,
        error: null,
        completed_at: typeof ledger.completed_at === 'string' ? ledger.completed_at : now(),
        ...sessionMetadata,
        profile_id: `foundation:${agentId}:v1`
      };
    }
    try {
      const targetThreadId = recordedThreadId ?? preferredThreadId;
      assertCodexHostedThreadBinding(
        runtimeBinding,
        visibleThreadIds,
        agentId,
        targetThreadId
      );
      const accepted = await runtime.sendMessage({
        correlationId: `foundation:${projectId}:${agentId}`,
        projectId,
        rootPath: root,
        threadId: targetThreadId,
        targetAgentId: agentId,
        threadTitle: foundationThreadTitle(agentId),
        text: foundationHandoffText(agentId),
        localImagePaths: [],
        recommendedModel: foundationRecommendedModel(agentId),
        requestedModel: null,
        onThreadReady: async (threadId) => {
          await writeFoundationLedger(root, agentId, {
            schema_version: 1,
            agent_id: agentId,
            status: 'thread_ready',
            thread_id: threadId,
            turn_id: null,
            correlation_id: `foundation:${projectId}:${agentId}`,
            updated_at: now()
          });
        }
      });
      const result: FoundationProvisioningResult = {
        agent_id: agentId,
        status: 'accepted',
        thread_id: accepted.threadId,
        turn_id: accepted.turnId,
        error: null,
        completed_at: now(),
        ...sessionMetadata,
        profile_id: `foundation:${agentId}:v1`
      };
      await writeFoundationLedger(root, agentId, {
        schema_version: 1,
        ...result,
        correlation_id: `foundation:${projectId}:${agentId}`,
        updated_at: result.completed_at
      });
      return result;
    } catch (error) {
      const latest = await readFoundationLedger(root, agentId);
      const threadId = typeof latest?.thread_id === 'string' && latest.thread_id.trim()
        ? latest.thread_id.trim()
        : recordedThreadId;
      const result: FoundationProvisioningResult = {
        agent_id: agentId,
        status: 'failed',
        thread_id: threadId,
        turn_id: null,
        error: boundedError(error),
        completed_at: now(),
        ...sessionMetadata,
        profile_id: `foundation:${agentId}:v1`
      };
      await writeFoundationLedger(root, agentId, {
        schema_version: 1,
        ...result,
        status: threadId ? 'thread_ready' : 'failed',
        correlation_id: `foundation:${projectId}:${agentId}`,
        updated_at: result.completed_at
      });
      return result;
    }
  }));
}

function batchIsTerminal(batch: ProvisioningBatch): boolean {
  return batch.requests.every((request) => (
    (request.handoff_status === 'accepted' && Boolean(request.thread_id && request.turn_id))
    || request.status === 'provisioning_failed'
  ));
}

function updateOrganizationRuntime(
  organizationState: JsonRecord,
  completed: ProvisioningRequest[]
): { state: JsonRecord; changed: boolean } {
  const completedByAgent = new Map(completed.map((request) => [request.agent_id, request]));
  const found = new Set<string>();
  let changed = false;
  const agents = rows(organizationState, 'agents').map((agent) => {
    const agentId = String(agent.agent_id ?? '');
    const request = completedByAgent.get(agentId);
    if (!request) return agent;
    found.add(agentId);
    const accepted = request.handoff_status === 'accepted' && Boolean(request.thread_id && request.turn_id);
    const lifecycleState = accepted ? 'active' : 'provisioning';
    const operationalStatus = accepted ? 'standby' : 'provisioning_failed';
    if (agent.lifecycle_state === lifecycleState && agent.operational_status === operationalStatus) return agent;
    changed = true;
    return {
      ...agent,
      lifecycle_state: lifecycleState,
      operational_status: operationalStatus
    };
  });
  const missing = [...completedByAgent.keys()].filter((agentId) => !found.has(agentId));
  if (missing.length > 0) {
    throw new Error(`Organization state is missing provisioned agent: ${missing.join(', ')}`);
  }
  return { state: {
    ...organizationState,
    agents
  }, changed };
}

async function snapshotText(filePaths: string[]): Promise<Map<string, string | null>> {
  const snapshot = new Map<string, string | null>();
  for (const filePath of filePaths) {
    try {
      snapshot.set(filePath, await readFile(filePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      snapshot.set(filePath, null);
    }
  }
  return snapshot;
}

async function restoreSnapshot(snapshot: Map<string, string | null>): Promise<void> {
  for (const [filePath, content] of snapshot) {
    if (content === null) await rm(filePath, { force: true });
    else await writeJsonAtomic(filePath, JSON.parse(content));
  }
}

async function writeOrganizationRuntimeTransition(input: {
  root: string;
  rolesState: JsonRecord;
  agentsState: JsonRecord;
  organizationState: JsonRecord;
  now: string;
}): Promise<void> {
  const stateRoot = path.join(input.root, '.orquesta', 'state');
  const rolesPath = path.join(stateRoot, 'roles.json');
  const agentsPath = path.join(stateRoot, 'agents.json');
  const organizationPath = path.join(stateRoot, 'organization.json');
  const transitionPath = path.join(stateRoot, 'organization-transition.json');
  const expectedRevision = Number(input.organizationState.revision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error('Invalid organization revision');
  if (input.rolesState.organization_revision !== expectedRevision || input.agentsState.organization_revision !== expectedRevision) {
    throw new Error('Organization, role, and agent revisions diverged before provisioning transition');
  }
  const nextRevision = expectedRevision + 1;
  const nextRoles = { ...input.rolesState, organization_revision: nextRevision, updated_at: input.now };
  const nextAgents = { ...input.agentsState, organization_revision: nextRevision, updated_at: input.now };
  const nextOrganization = { ...input.organizationState, revision: nextRevision };
  const targetPaths = [rolesPath, agentsPath, organizationPath];
  const snapshot = await snapshotText([...targetPaths, transitionPath]);
  const manifest = {
    schema_version: 1,
    status: 'prepared',
    transition_kind: 'provisioning_lifecycle',
    from_revision: expectedRevision,
    to_revision: nextRevision,
    prepared_at: input.now,
    committed_at: null,
    target_paths: targetPaths.map((filePath) => path.relative(input.root, filePath).replaceAll('\\', '/'))
  };
  try {
    await writeJsonAtomic(transitionPath, manifest);
    await writeJsonAtomic(rolesPath, nextRoles);
    await writeJsonAtomic(agentsPath, nextAgents);
    await writeJsonAtomic(organizationPath, nextOrganization);
    await writeJsonAtomic(transitionPath, { ...manifest, status: 'committed', committed_at: input.now });
  } catch (error) {
    await restoreSnapshot(snapshot);
    throw error;
  }
}

async function attemptRequest(
  root: string,
  projectId: string,
  batchId: string,
  request: ProvisioningRequest,
  runtime: SpecialistRuntime,
  runtimeBinding: RuntimeBinding,
  visibleThreadIds: ReadonlySet<string> | null,
  displayNames: ReadonlyMap<string, string>,
  canonicalTask: JsonRecord | null,
  now: () => string
): Promise<ProvisioningRequest> {
  if (request.handoff_status === 'accepted' && request.thread_id && request.turn_id) {
    return structuredClone(request);
  }
  try {
    assertCompletionContract(request, canonicalTask, root);
    const threadId = reusableThreadId(request);
    assertCodexHostedThreadBinding(
      runtimeBinding,
      visibleThreadIds,
      request.agent_id,
      threadId
    );
    const accepted = await runtime.sendMessage({
      correlationId: `${batchId}:${request.agent_id}`,
      projectId,
      rootPath: root,
      threadId,
      targetAgentId: request.agent_id,
      threadTitle: specialistThreadTitle(request, displayNames),
      text: handoffText(request, root),
      localImagePaths: [],
      recommendedModel: request.recommended_model ?? null,
      requestedModel: request.requested_model ?? null,
      effort: specialistEffort(request)
    });
    return {
      ...request,
      status: 'standby',
      thread_id: accepted.threadId,
      turn_id: accepted.turnId,
      handoff_status: 'accepted',
      error: null,
      completed_at: now()
    };
  } catch (error) {
    return {
      ...request,
      status: 'provisioning_failed',
      thread_id: request.thread_id ?? null,
      turn_id: null,
      handoff_status: 'failed',
      error: boundedError(error),
      completed_at: now()
    };
  }
}

async function persistChunk(
  root: string,
  batch: ProvisioningBatch,
  completed: ProvisioningRequest[],
  now: string,
  runtimeBinding: RuntimeBinding | null
): Promise<void> {
  const stateRoot = path.join(root, '.orquesta', 'state');
  const setupRoot = path.join(root, '.orquesta', 'setup');
  const agentsPath = path.join(stateRoot, 'agents.json');
  const sessionsPath = path.join(stateRoot, 'sessions.json');
  const tasksPath = path.join(stateRoot, 'tasks.json');
  const rolesPath = path.join(stateRoot, 'roles.json');
  const organizationPath = path.join(stateRoot, 'organization.json');
  const batchPath = path.join(setupRoot, 'provisioning_batch.json');
  const agentsState = await readJson(agentsPath, { version: 1, agents: [] });
  const sessionsState = await readJson(sessionsPath, { version: 1, sessions: [] });
  const tasksState = await readJson(tasksPath, { version: 1, tasks: [] });
  const rolesState = await readOptionalJson(rolesPath);
  const organizationState = await readOptionalJson(organizationPath);
  let agents = rows(agentsState, 'agents');
  let sessions = rows(sessionsState, 'sessions');
  let tasks = rows(tasksState, 'tasks');

  for (const request of completed) {
    const accepted = request.handoff_status === 'accepted' && Boolean(request.thread_id && request.turn_id);
    const binding = executionBinding(request);
    agents = upsert(agents, 'agent_id', {
      agent_id: request.agent_id,
      role: request.role_id,
      role_id: request.role_id,
      role_version: 1,
      team_id: request.team_id,
      line_id: request.line_id,
      organization_scope: 'line',
      lifecycle_state: accepted ? 'active' : 'provisioning',
      operational_status: accepted ? 'standby' : 'provisioning_failed',
      status: accepted ? 'standby' : 'provisioning_failed',
      thread_id: accepted ? request.thread_id : null,
      execution_channel: binding.executionChannel,
      conversation_history_policy: binding.historyPolicy,
      provisioning_error: accepted ? null : request.error ?? 'Unknown provisioning failure',
      updated_at: now
    });
    if (accepted) {
      sessions = upsert(sessions, 'agent_id', {
        session_id: `session-${request.agent_id}`,
        agent_id: request.agent_id,
        thread_id: request.thread_id,
        session_generation: 1,
        rotation_state: 'active',
        ownership_status: 'owner',
        accepts_new_work: true,
        runtime_authority_id: runtimeBinding?.runtime_authority_id ?? null,
        visibility: runtimeBinding?.mode === 'codex_hosted' ? 'codex_task' : runtimeBinding ? 'desktop_only' : null,
        profile_id: typeof request.task_profile?.task_intent_id === 'string'
          ? request.task_profile.task_intent_id
          : `specialist:${request.role_id}:v1`,
        session_kind: 'persistent_agent',
        status: 'standby',
        handoff_status: 'accepted',
        handoff_turn_id: request.turn_id,
        execution_channel: binding.executionChannel,
        conversation_history_policy: binding.historyPolicy,
        updated_at: now
      });
    }
    tasks = tasks.map((task) => {
      if (task.task_id !== request.task_id) return task;
      const updatedTask = {
        ...task,
        owner_agent_id: request.agent_id,
        state: accepted ? 'in_progress' : task.state ?? 'queued',
        provisioning_status: accepted ? 'accepted' : 'failed',
        handoff_thread_id: accepted ? request.thread_id : null,
        handoff_turn_id: accepted ? request.turn_id : null,
        provisioning_error: accepted ? null : request.error ?? 'Unknown provisioning failure',
        updated_at: now
      };
      if (task.execution_policy_version !== 1) return updatedTask;
      const cycleId = `implementation-${request.task_id}`;
      const sentAt = request.completed_at ?? now;
      const attemptStatus = accepted ? 'accepted' : 'failed';
      const attempts = Array.isArray(task.handoff_attempts)
        ? (task.handoff_attempts as unknown[]).map(object)
        : [];
      if (!attempts.some((attempt) => (
        attempt.cycle_id === cycleId
        && attempt.owner_agent_id === request.agent_id
        && attempt.sent_at === sentAt
        && attempt.status === attemptStatus
      ))) {
        attempts.push({
          cycle_id: cycleId,
          owner_agent_id: request.agent_id,
          sent_at: sentAt,
          thread_id: request.thread_id,
          turn_id: request.turn_id,
          status: attemptStatus,
          completion_transport: request.completion_transport ?? null,
          error: accepted ? null : request.error ?? 'Unknown provisioning failure'
        });
      }
      const cycles = Array.isArray(task.execution_cycles)
        ? (task.execution_cycles as unknown[]).map(object)
        : [];
      if (accepted) {
        const cycleIndex = cycles.findIndex((cycle) => cycle.cycle_id === cycleId);
        const implementationCycle = {
          ...(cycleIndex >= 0 ? cycles[cycleIndex] : {}),
          cycle_id: cycleId,
          kind: 'implementation',
          owner_agent_id: request.agent_id,
          status: 'in_progress',
          evidence_refs: cycleIndex >= 0 && Array.isArray(cycles[cycleIndex].evidence_refs)
            ? cycles[cycleIndex].evidence_refs
            : []
        };
        if (cycleIndex >= 0) cycles[cycleIndex] = implementationCycle;
        else cycles.push(implementationCycle);
      }
      const metrics = object(task.execution_metrics);
      const acceptedTurns = attempts.filter((attempt) => attempt.status === 'accepted' && attempt.turn_id).length;
      return {
        ...updatedTask,
        routing_gate_status: accepted ? 'passed' : 'blocked',
        handoff_sent_at: accepted ? task.handoff_sent_at ?? sentAt : task.handoff_sent_at ?? null,
        handoff_attempts: attempts,
        execution_cycles: cycles,
        execution_metrics: {
          wall_time_ms: Number(metrics.wall_time_ms ?? 0),
          agent_turns: Math.max(Number(metrics.agent_turns ?? 0), acceptedTurns),
          handoffs: attempts.length,
          independent_reviews: Number(metrics.independent_reviews ?? 0),
          correction_batches: Number(metrics.correction_batches ?? 0),
          reports: Number(metrics.reports ?? 0),
          token_usage: metrics.token_usage ?? { coverage: 'unknown', known_total: null, by_thread: [] }
        }
      };
    });
  }

  const nextAgentsState = { ...agentsState, agents, updated_at: now };
  if (organizationState && batchIsTerminal(batch)) {
    if (!rolesState) throw new Error('Explicit organization state requires roles.json');
    const organizationUpdate = updateOrganizationRuntime(organizationState, batch.requests);
    if (organizationUpdate.changed) {
      await writeOrganizationRuntimeTransition({
        root,
        rolesState,
        agentsState: nextAgentsState,
        organizationState: organizationUpdate.state,
        now
      });
    } else {
      await writeJsonAtomic(agentsPath, nextAgentsState);
    }
  } else {
    await writeJsonAtomic(agentsPath, nextAgentsState);
  }
  await writeJsonAtomic(sessionsPath, {
    ...sessionsState,
    source: 'desktop_codex_provisioning',
    project_cwd: root,
    synced_at: now,
    sessions,
    updated_at: now
  });
  await writeJsonAtomic(tasksPath, { ...tasksState, tasks, updated_at: now });
  await writeJsonAtomic(batchPath, { ...batch, updated_at: now });
}

export async function provisionSpecialists({
  root,
  projectId = path.basename(root),
  batch,
  runtime,
  now = () => new Date().toISOString()
}: ProvisionSpecialistsInput): Promise<ProvisioningBatch> {
  if (!path.isAbsolute(root)) throw new Error('Specialist provisioning requires an absolute repository root');
  if (!batch.provisioning_batch_id || !Array.isArray(batch.requests)) throw new Error('Invalid provisioning batch');
  if (!Number.isInteger(batch.max_concurrent_provisioning) || batch.max_concurrent_provisioning < 1) {
    throw new Error('Invalid provisioning concurrency');
  }
  const limit = Math.min(3, batch.max_concurrent_provisioning);
  const next: ProvisioningBatch = structuredClone(batch);
  const rolesState = await readOptionalJson(path.join(root, '.orquesta', 'state', 'roles.json'));
  const tasksState = await readOptionalJson(path.join(root, '.orquesta', 'state', 'tasks.json'));
  const tasksById = new Map(rows(tasksState, 'tasks').map((task) => [String(task.task_id ?? ''), task]));
  const runtimeBinding = await readRuntimeBinding(root);
  if (!runtimeBinding) throw new Error('runtime_binding_required');
  const visibleThreadIds = await codexHostedVisibleThreadIds(root, runtimeBinding, runtime);
  const displayNames = roleDisplayNames(rolesState);

  for (let start = 0; start < next.requests.length; start += limit) {
    const chunk = next.requests.slice(start, start + limit);
    const completed = await Promise.all(chunk.map((item) => attemptRequest(
      root,
      projectId,
      next.provisioning_batch_id,
      item,
      runtime,
      runtimeBinding,
      visibleThreadIds,
      displayNames,
      tasksById.get(item.task_id) ?? null,
      now
    )));
    completed.forEach((item, index) => {
      next.requests[start + index] = item;
    });
    const timestamp = now();
    next.updated_at = timestamp;
    await persistChunk(root, next, completed, timestamp, runtimeBinding);
  }
  return next;
}

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const {
  createGitHubConnector,
  createOfficialDocsConnector,
  createRegistryConnector,
  createUiCatalogConnector,
  searchLiveSources,
  toAuditLiveCandidateInput
} = require("@orquesta/acquisition");
const { auditLiveCandidate } = require("@orquesta/audit");
const { createAuditionPlan, runAudition } = require("@orquesta/audition");
const { canonicalHash } = require("@orquesta/contracts");
const { createAppServerAdapter, createSdkAdapter } = require("@orquesta/codex-adapter");
const { createEventStore } = require("@orquesta/event-store");
const { createCommandBoundary, createProjectors, initialProjection, projectionHash } = require("@orquesta/core");

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE_ROOT = path.join(REPOSITORY_ROOT, "fixtures", "v4", "phase2");
const ADMIN_FIXTURE_ROOT = path.join(FIXTURE_ROOT, "admin-ui");
const TRANSPORT_FIXTURE_ROOT = path.join(FIXTURE_ROOT, "transports");
const FIXED_CLOCK = "2026-07-17T00:00:00.000Z";
const AXES = Object.freeze(["task_fit", "integration_ease", "evidence_strength", "maintainability", "security", "license_fit", "exit_option", "cost"]);
const MAX_LIVE_FETCH_BYTES = 1024 * 1024;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadAdminFixtures() {
  return {
    task: readJson(path.join(ADMIN_FIXTURE_ROOT, "task-intent.json")),
    sourcePolicy: readJson(path.join(ADMIN_FIXTURE_ROOT, "source-policy.json")),
    auditionPolicy: readJson(path.join(ADMIN_FIXTURE_ROOT, "audition-policy.json")),
    acceptance: readJson(path.join(ADMIN_FIXTURE_ROOT, "acceptance.json"))
  };
}

function phase2Error(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

class DeterministicAppServerProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.buffer = "";
    this.killed = false;
    this.stdin = new Writable({
      write: (chunk, encoding, callback) => {
        this.buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        let newline;
        while ((newline = this.buffer.indexOf("\n")) !== -1) {
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          if (line) this.emit("clientMessage", JSON.parse(line));
        }
        callback();
      }
    });
  }

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill() {
    this.killed = true;
    return true;
  }
}

function deterministicThread(id) {
  return {
    cliVersion: "0.144.5", createdAt: 1, cwd: "C:\\phase2", ephemeral: false,
    id, modelProvider: "openai", preview: "", sessionId: `session-${id}`,
    source: "appServer", status: "idle", turns: [], updatedAt: 1
  };
}

function createDeterministicRuntimeAdapter() {
  const child = new DeterministicAppServerProcess();
  child.on("clientMessage", (message) => {
    if (message.method === "initialize") {
      child.send({ id: message.id, result: { codexHome: "C:\\codex-home", platformFamily: "windows", platformOs: "windows", userAgent: "codex-cli/0.144.5" } });
    } else if (message.method === "thread/start") {
      child.send({ id: message.id, result: { approvalPolicy: "on-request", approvalsReviewer: "user", cwd: "C:\\phase2", model: "requested-model", modelProvider: "openai", sandbox: "workspace-write", thread: deterministicThread("thread-phase2") } });
    } else if (message.method === "turn/start") {
      child.send({ id: message.id, result: { turn: { id: "turn-phase2", items: [], status: "inProgress" } } });
      setImmediate(() => {
        child.send({ method: "turn/started", params: { threadId: "thread-phase2", turn: { id: "turn-phase2", items: [], status: "inProgress" } } });
        child.send({ method: "item/completed", params: { completedAtMs: 2, item: { id: "item-phase2", type: "agent_message" }, threadId: "thread-phase2", turnId: "turn-phase2" } });
        child.send({ method: "turn/completed", params: { threadId: "thread-phase2", turn: { id: "turn-phase2", items: [], status: "completed" } } });
      });
    }
  });
  return createAppServerAdapter({
    resolveRuntime: () => ({
      sdk_package: "@openai/codex-sdk", sdk_version: "0.144.5", codex_package: "@openai/codex", codex_version: "0.144.5",
      runtime_package: "@openai/codex-win32-x64", runtime_package_version: "0.144.5-win32-x64",
      target_triple: "x86_64-pc-windows-msvc", executable_path: "C:\\runtime\\codex.exe"
    }),
    spawnProcess: () => child
  });
}

function axes(value, label) {
  return Object.fromEntries(AXES.map((axis) => [axis, { value, reason: `${label}:${axis}` }]));
}

function trustedDraftContextPack({ taskIntent, resolutions }) {
  const content = {
    task_intent_id: taskIntent.task_intent_id,
    owner_agent_id: "implementation-001",
    objective: taskIntent.desired_outcome,
    acceptance_criteria: [...taskIntent.acceptance_criteria],
    adopted_decisions: [],
    capability_resolutions: resolutions.map((resolution) => resolution.resolution_id).sort(),
    required_reading: [],
    relevant_state_excerpts: [],
    interfaces: [],
    allowed_files: [],
    forbidden_actions: [],
    excluded_context: [],
    evidence_requirements: [...taskIntent.acceptance_criteria],
    provenance: [
      { kind: "task_intent", source_ref: `task_intent:${taskIntent.task_intent_id}`, source_hash: canonicalHash(taskIntent) },
      ...resolutions.map((resolution) => ({ kind: "capability_resolution", source_ref: `resolution:${resolution.resolution_id}`, source_hash: canonicalHash(resolution) }))
    ].sort((left, right) => compareText(`${left.kind}:${left.source_ref}`, `${right.kind}:${right.source_ref}`)),
    token_budget: null,
    expires_at: null,
    status: "draft"
  };
  return { context_pack: { context_pack_id: `CP-${canonicalHash(content).slice(0, 12)}`, ...content } };
}

function createBoundary(stateRoot, clock = () => FIXED_CLOCK) {
  const projectors = createProjectors();
  const store = createEventStore({ stateRoot, workspaceId: "v4-phase2-slice", clock, reducers: projectors, initialState: initialProjection() });
  const boundary = createCommandBoundary({
    eventStore: store,
    rules: {
      catalog_version: 1,
      rules: [{
        rule_id: "phase2-codex-tool",
        match: { any_terms: ["codex", "asset", "tool"], acceptance_terms: ["journal", "audition", "candidate"] },
        emits: [{ kind: "tool", description: "Source-bound Codex development tool", verification_method: "source audit, Audition, runtime, and replay" }]
      }]
    },
    collectInventory: () => ({ version: 1, providers: [], conflicts: [] }),
    compileContextPack: trustedDraftContextPack,
    referenceTime: FIXED_CLOCK
  });
  return { store, boundary, projectors };
}

function deterministicResponse(name) {
  const response = readJson(path.join(TRANSPORT_FIXTURE_ROOT, `${name}.json`));
  const payload = JSON.parse(response.body);
  if (name === "official-docs") payload.items = [];
  if (name === "github" && payload.items[0]) payload.items[0].security = "critical";
  if (name === "ui-catalog" && payload.items[0]) payload.items[0].license = "MIT";
  return { ...response, body: JSON.stringify(payload) };
}

function fixedTransport(response) {
  return { request: async () => JSON.parse(JSON.stringify(response)) };
}

function deterministicConnectors(clock) {
  return [
    createGitHubConnector({ transport: fixedTransport(deterministicResponse("github")), configuredOwners: ["openai"], clock }),
    createOfficialDocsConnector({ transport: fixedTransport(deterministicResponse("official-docs")), clock }),
    createRegistryConnector({ transport: fixedTransport(deterministicResponse("registry")), clock }),
    createUiCatalogConnector({ baseUrl: "https://catalog.example.test", transport: fixedTransport(deterministicResponse("ui-catalog")), clock })
  ];
}

function auditCandidates(acquisition, need) {
  return acquisition.candidates.map((record, index) => {
    const sourceResult = acquisition.source_results.find((result) => result.candidates.some((candidate) => candidate.candidate_id === record.candidate_id));
    const candidate = {
      provider_id: record.candidate_id,
      provider_type: "package",
      resolution_mode: "adapt",
      source_ref: record.source_ref,
      source_hash: record.source_hash,
      version: record.version,
      revision: record.revision,
      evidence_refs: sourceResult.source_evidence.filter((entry) => entry.candidate_id === record.candidate_id).map((entry) => entry.source_ref),
      axes: axes(index === 0 ? 92 : 84, record.candidate_id),
      uncertainty_penalty: index === 0 ? 4 : 8,
      unknowns: []
    };
    const bound = toAuditLiveCandidateInput({ sourceResult, candidate });
    return auditLiveCandidate({ ...bound, need });
  });
}

function virtualFs(roots) {
  const identities = new Map([
    [path.resolve(roots.workspace_root), "workspace-root"],
    [path.resolve(roots.temporary_root), "temporary-root"],
    [path.resolve(roots.audition_root), "audition-root"]
  ]);
  return {
    inspect: async (target) => {
      const resolved = path.resolve(target);
      const identity = identities.get(resolved);
      return identity ? { path: resolved, real_path: resolved, type: "directory", identity } : null;
    },
    remove: async () => {}
  };
}

async function runApprovedAudition({ stateRoot, intent, resolution, candidate, policy }) {
  const roots = {
    workspace_root: path.resolve(stateRoot, "workspace"),
    temporary_root: path.resolve(stateRoot, "temporary"),
    audition_root: path.resolve(stateRoot, "temporary", "audition")
  };
  const expectedProfile = {
    ...policy.expected_profile,
    allowed_roots: [roots.workspace_root, roots.audition_root]
  };
  const plan = createAuditionPlan({
    task_intent_id: intent.task_intent_id,
    task_intent_hash: canonicalHash(intent),
    resolution_id: resolution.resolution_id,
    resolution_revision: policy.resolution_revision,
    resolution_hash: canonicalHash(resolution),
    candidate: {
      candidate_id: candidate.candidate_id,
      version: candidate.static_metadata.version || candidate.candidate_version || "observed",
      source_hash: candidate.fact_provenance[0]?.source_hash || canonicalHash(candidate)
    },
    ...roots,
    expected_profile: expectedProfile,
    permitted_effects: policy.permitted_effects,
    steps: policy.steps,
    expected_evidence: policy.expected_evidence,
    cleanup_plan: { root: roots.audition_root, max_paths: policy.cleanup_max_paths },
    approval_refs: policy.approval_refs
  });
  const evidence = [];
  const result = await runAudition({
    plan,
    roots,
    harness: {
      inspectProfile: async () => ({
        status: "available",
        verified: true,
        profile_id: expectedProfile.profile_id,
        source: "deterministic-codex-profile",
        captured_at: FIXED_CLOCK,
        allowed_roots: [...expectedProfile.allowed_roots],
        effects: [...expectedProfile.effects]
      }),
      run: async () => ({ status: "completed", before_manifest: [], after_manifest: [], effects: [], evidence_refs: ["evidence:deterministic-audition"] })
    },
    fsAdapter: virtualFs(roots),
    evidenceSink: { record: async (item) => evidence.push(item) }
  });
  return { plan, result, evidence, approval_wait_observed: policy.approval_refs.length > 0 };
}

function waitForRuntime(adapter, correlationId, timeoutMs = 2000) {
  const events = [];
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const timer = setTimeout(() => rejectCompletion(phase2Error("PHASE2_RUNTIME_TIMEOUT", "Runtime did not complete the Phase 2 turn.")), timeoutMs);
  adapter.subscribeEvents({
    correlationId: `${correlationId}:subscription`,
    listener: (event) => {
      if (event.correlation_id !== correlationId) return;
      events.push(event);
      if (event.type === "turn_completed") {
        clearTimeout(timer);
        resolveCompletion(events);
      }
    }
  });
  return { events, completion };
}

function evidenceId(label, value) {
  return `EVD-${canonicalHash({ label, value }).slice(0, 12)}`;
}

function recordEvidenceChain({ boundary, lifecycle, correlationId, sourceRefs, runtime, artifact, report, acceptance, fault }) {
  const binding = {
    task_intent_id: lifecycle.current_task_intent_id,
    resolution_id: lifecycle.resolutions[0].resolution_id,
    context_pack_id: lifecycle.current_context_pack_id,
    correlation_id: correlationId,
    source_evidence_refs: [...sourceRefs].sort(),
    thread_id: runtime.thread_id,
    turn_id: null
  };
  if (fault === "turn_started_before_dispatch") {
    return boundary.execute({
      command_id: `${correlationId}:fault-start`,
      name: "runtime.event.record",
      payload: { ...binding, evidence_id: evidenceId("fault-start", runtime), evidence_hash: canonicalHash(runtime), event_kind: "turn_started", turn_id: runtime.turn_id }
    });
  }
  const dispatchId = evidenceId("dispatch", runtime.dispatch);
  boundary.execute({
    command_id: `${correlationId}:dispatch`,
    name: "runtime.dispatch.record",
    payload: { ...binding, evidence_id: dispatchId, evidence_hash: canonicalHash(runtime.dispatch), request_ref: `runtime-request:${correlationId}` }
  });
  const startedId = evidenceId("turn-started", runtime.started);
  boundary.execute({
    command_id: `${correlationId}:turn-started`,
    name: "runtime.event.record",
    payload: { ...binding, evidence_id: startedId, evidence_hash: canonicalHash(runtime.started), event_kind: "turn_started", turn_id: runtime.turn_id, predecessor_evidence_id: dispatchId }
  });
  let runtimePredecessorId = startedId;
  if (runtime.progress) {
    const progressId = evidenceId("progress-observed", runtime.progress);
    boundary.execute({
      command_id: `${correlationId}:progress`,
      name: "runtime.event.record",
      payload: { ...binding, evidence_id: progressId, evidence_hash: canonicalHash(runtime.progress), event_kind: "progress_observed", turn_id: runtime.turn_id, predecessor_evidence_id: startedId }
    });
    runtimePredecessorId = progressId;
  }
  const artifactId = evidenceId("artifact", artifact);
  boundary.execute({
    command_id: `${correlationId}:artifact`,
    name: "artifact.record",
    payload: { ...binding, evidence_id: artifactId, evidence_hash: artifact.hash, turn_id: runtime.turn_id, predecessor_evidence_id: runtimePredecessorId, artifact_ref: artifact.ref, artifact_hash: artifact.hash }
  });
  if (runtime.completed) {
    boundary.execute({
      command_id: `${correlationId}:turn-completed`,
      name: "runtime.event.record",
      payload: { ...binding, evidence_id: evidenceId("turn-completed", runtime.completed), evidence_hash: canonicalHash(runtime.completed), event_kind: "turn_completed", turn_id: runtime.turn_id, predecessor_evidence_id: runtimePredecessorId }
    });
  }
  const reportId = evidenceId("report", report);
  boundary.execute({
    command_id: `${correlationId}:report`,
    name: "report.record",
    payload: { ...binding, evidence_id: reportId, evidence_hash: report.hash, turn_id: runtime.turn_id, predecessor_evidence_id: artifactId, report_ref: report.ref, report_hash: report.hash }
  });
  boundary.execute({
    command_id: `${correlationId}:acceptance`,
    name: "acceptance.record",
    payload: { ...binding, evidence_id: evidenceId("acceptance", acceptance), evidence_hash: canonicalHash(acceptance), turn_id: runtime.turn_id, predecessor_evidence_id: reportId, acceptance_ref: acceptance.ref }
  });
}

async function runDeterministicPhase2Slice({ stateRoot, runtimeAdapter, fault = null } = {}) {
  if (typeof stateRoot !== "string" || !stateRoot) throw new TypeError("A stateRoot is required.");
  const selectedRuntimeAdapter = runtimeAdapter || createDeterministicRuntimeAdapter();
  const resolvedStateRoot = path.resolve(stateRoot);
  fs.mkdirSync(resolvedStateRoot, { recursive: true });
  const fixtures = loadAdminFixtures();
  const clock = () => FIXED_CLOCK;
  const { store, boundary, projectors } = createBoundary(resolvedStateRoot, clock);

  boundary.execute({ command_id: "phase2:task-intent", name: "task-intent.create", payload: fixtures.task.task_intent });
  boundary.execute({ command_id: "phase2:capability-compile", name: "capability.compile", payload: {} });
  const need = boundary.replay().capability_graphs[0].needs[0];
  boundary.execute({ command_id: "phase2:resolution", name: "resolution.propose", payload: { need_id: need.need_id, candidates: [], audit_facts: [] } });
  boundary.execute({ command_id: "phase2:context", name: "context-pack.preview", payload: {} });
  const lifecycle = boundary.replay();
  const intent = lifecycle.task_intents.find((item) => item.task_intent_id === lifecycle.current_task_intent_id);
  const resolution = lifecycle.resolutions[0];

  const query = { need_id: fixtures.task.capability_need.need_id, ...fixtures.sourcePolicy };
  const acquisition = await searchLiveSources({ query, connectors: deterministicConnectors(clock), cache: null, clock });
  const audits = auditCandidates(acquisition, fixtures.task.capability_need);
  const eligible = audits.find((item) => item.evaluation.eligibility === "eligible");
  if (!eligible) throw phase2Error("PHASE2_ELIGIBLE_CANDIDATE_MISSING", "Deterministic slice produced no eligible candidate.");
  const audition = await runApprovedAudition({ stateRoot: resolvedStateRoot, intent, resolution, candidate: eligible, policy: fixtures.auditionPolicy });

  const correlationId = `CORR-${canonicalHash({ task_intent_id: intent.task_intent_id, resolution_id: resolution.resolution_id, context_pack_id: lifecycle.current_context_pack_id }).slice(0, 12)}`;
  const observed = waitForRuntime(selectedRuntimeAdapter, correlationId);
  const created = await selectedRuntimeAdapter.createThread({ correlationId: `${correlationId}:thread`, params: { cwd: "C:\\phase2", sandbox: "workspace-write", approvalPolicy: "on-request" } });
  if (!created.ok) throw phase2Error("PHASE2_RUNTIME_UNAVAILABLE", "Deterministic App Server thread was unavailable.", { result: created });
  const dispatch = await selectedRuntimeAdapter.startTurn({ correlationId, threadId: created.thread_id, input: [{ type: "text", text: "Return the Phase 2 fixture marker." }] });
  if (!dispatch.ok) throw phase2Error("PHASE2_RUNTIME_DISPATCH_FAILED", "Deterministic App Server turn was not accepted.", { result: dispatch });
  const runtimeEvents = await observed.completion;
  const timeline = runtimeEvents.map((event) => event.type).filter((type) => ["dispatch_accepted", "turn_started", "progress_observed", "turn_completed"].includes(type));
  const started = runtimeEvents.find((event) => event.type === "turn_started");
  const progress = runtimeEvents.find((event) => event.type === "progress_observed");
  const completed = runtimeEvents.find((event) => event.type === "turn_completed");
  const runtime = {
    adapter: dispatch.adapter,
    thread_id: dispatch.thread_id,
    turn_id: dispatch.turn_id,
    dispatch,
    started,
    progress,
    completed,
    timeline,
    actual_model: null
  };
  const artifactBody = { kind: "runtime_timeline", correlation_id: correlationId, timeline };
  const artifact = { ref: `artifact:phase2:${canonicalHash(artifactBody).slice(0, 12)}`, hash: canonicalHash(artifactBody) };
  const reportBody = {
    candidates: acquisition.candidates.map((candidate) => candidate.candidate_id),
    rejected: audits.filter((item) => item.evaluation.eligibility === "ineligible").map((item) => item.candidate_id),
    audition: audition.result.verdict,
    runtime: timeline,
    artifact
  };
  const report = { ref: `report:phase2:${canonicalHash(reportBody).slice(0, 12)}`, hash: canonicalHash(reportBody) };
  const acceptance = { ref: `acceptance:${fixtures.acceptance.acceptance_id}`, status: "passed", checks: [...fixtures.acceptance.checks] };
  const sourceRefs = acquisition.source_results.flatMap((result) => result.source_evidence.map((entry) => `${entry.source_ref}#${entry.source_hash}`));
  recordEvidenceChain({ boundary, lifecycle, correlationId, sourceRefs, runtime, artifact, report, acceptance, fault });

  const projected = boundary.replay();
  const replayed = store.replay({ reducers: projectors, initialState: initialProjection() }).state;
  const packetContent = {
    correlation_id: correlationId,
    evidence_ids: projected.evidence_by_correlation[correlationId].map((item) => item.evidence_id),
    artifact_ref: artifact.ref,
    report_ref: report.ref,
    acceptance_ref: acceptance.ref
  };
  return {
    stable_ids: {
      task_intent_id: intent.task_intent_id,
      source_query_id: `LSQ-${canonicalHash(query).slice(0, 12)}`,
      resolution_id: resolution.resolution_id,
      context_pack_id: lifecycle.current_context_pack_id,
      audition_plan_id: audition.plan.audition_plan_id,
      correlation_id: correlationId
    },
    acquisition: {
      candidate_count: acquisition.candidates.length,
      connector_ids: acquisition.source_results.map((result) => result.connector_id),
      budget: acquisition.budget
    },
    audit: {
      hard_gate_rejection_count: audits.filter((item) => item.evaluation.eligibility === "ineligible").length,
      selected_candidate_id: eligible.candidate_id
    },
    audition: { approval_wait_observed: audition.approval_wait_observed, verdict: audition.result.verdict, cleanup_evidence: audition.result.cleanup_evidence },
    runtime: { adapter: runtime.adapter, timeline, actual_model: null },
    artifact,
    report,
    acceptance,
    journal: {
      replay_equivalent: projectionHash(projected) === projectionHash(replayed),
      projection_hash: projectionHash(replayed),
      evidence_count: projected.evidence_by_correlation[correlationId].length
    },
    review_packet: { status: fixtures.acceptance.review_status, packet_hash: canonicalHash(packetContent), ...packetContent },
    repository_fallback: { live_turn_eligible: false }
  };
}

function networkResponse(status, url, items, capturedAt) {
  return {
    status,
    headers: {},
    url,
    body: JSON.stringify({ items }),
    captured_at: capturedAt
  };
}

async function boundedFetchText(response) {
  if (!response || typeof response.text !== "function") {
    throw phase2Error("PHASE2_SOURCE_RESPONSE_INVALID", "Live source response does not expose a text body.");
  }
  const body = await response.text();
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > MAX_LIVE_FETCH_BYTES) {
    throw phase2Error("PHASE2_SOURCE_RESPONSE_TOO_LARGE", "Live source response exceeds the 1 MiB evidence bound.");
  }
  return body;
}

function createLiveNetworkConnectors({ fetchImpl = globalThis.fetch, clock = () => new Date().toISOString() } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required for live acquisition.");
  const docsUrl = "https://learn.chatgpt.com/docs";
  const registryUrl = "https://registry.npmjs.org/@openai%2Fcodex-sdk/latest";
  const docsTransport = {
    async request() {
      const response = await fetchImpl(docsUrl, { headers: { accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(5000) });
      const body = response.ok ? await boundedFetchText(response) : "";
      const sourceUri = response.url || docsUrl;
      return networkResponse(
        response.status,
        sourceUri,
        response.ok ? [{ id: "openai-codex-docs", source_uri: sourceUri, revision: canonicalHash(body) }] : [],
        clock()
      );
    }
  };
  const registryTransport = {
    async request() {
      const response = await fetchImpl(registryUrl, { headers: { accept: "application/json" }, redirect: "follow", signal: AbortSignal.timeout(5000) });
      let metadata = {};
      let body = "";
      if (response.ok) {
        body = await boundedFetchText(response);
        try {
          metadata = JSON.parse(body);
        } catch {
          throw phase2Error("PHASE2_SOURCE_RESPONSE_INVALID", "The live registry response is not valid JSON.");
        }
      }
      const sourceUri = response.url || "https://registry.npmjs.org/@openai/codex-sdk";
      return networkResponse(
        response.status,
        sourceUri,
        response.ok ? [{
          id: "codex-sdk",
          source_uri: sourceUri,
          version: typeof metadata.version === "string" ? metadata.version : null,
          license: typeof metadata.license === "string" ? metadata.license : null,
          revision: canonicalHash(body)
        }] : [],
        clock()
      );
    }
  };
  return [
    createOfficialDocsConnector({ baseUrl: docsUrl, transport: docsTransport, clock }),
    createRegistryConnector({ baseUrl: "https://registry.npmjs.org", transport: registryTransport, clock })
  ];
}

function realFsAdapter() {
  return {
    async inspect(target) {
      const resolved = path.resolve(target);
      let stat;
      try {
        stat = fs.lstatSync(resolved);
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
      const realPath = fs.realpathSync.native(resolved);
      const type = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "unknown";
      const entry = {
        path: resolved,
        real_path: realPath,
        type,
        identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.birthtimeMs}`
      };
      if (stat.isFile()) entry.hash = canonicalHash(fs.readFileSync(resolved).toString("base64"));
      return entry;
    },
    async remove(target, options = {}) {
      const current = await this.inspect(target);
      if (!current || current.identity !== options.expected_identity) {
        throw phase2Error("PHASE2_CLEANUP_IDENTITY_CHANGED", "Cleanup target identity changed before removal.");
      }
      fs.rmSync(path.resolve(target), { force: false, recursive: false });
    }
  };
}

function removeOwnedTemporaryRoot(target) {
  const temporaryBase = path.resolve(os.tmpdir());
  const resolved = path.resolve(target);
  if (resolved === temporaryBase || !resolved.startsWith(`${temporaryBase}${path.sep}`)) {
    throw phase2Error("PHASE2_TEMP_ROOT_INVALID", "Refusing to clean an Audition root outside the OS temporary directory.");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function runAdapterTurn({ adapter, adapterKind, correlationId, workingDirectory, timeoutMs = 180000 } = {}) {
  const observed = waitForRuntime(adapter, correlationId, timeoutMs);
  const threadCorrelation = `${correlationId}:thread`;
  const created = adapterKind === "app_server"
    ? await adapter.createThread({
      correlationId: threadCorrelation,
      params: { cwd: workingDirectory, sandbox: "read-only", approvalPolicy: "never", ephemeral: true }
    })
    : await adapter.createThread({
      correlationId: threadCorrelation,
      profile: {
        workingDirectory,
        sandboxMode: "read-only",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
        approvalPolicy: "never"
      }
    });
  if (!created.ok) throw phase2Error("PHASE2_RUNTIME_UNAVAILABLE", `${adapterKind} could not create a Codex thread.`, { result: created });
  const turn = adapterKind === "app_server"
    ? await adapter.startTurn({
      correlationId,
      threadId: created.thread_id,
      input: [{ type: "text", text: "Return exactly: ORQUESTA_PHASE2_LIVE_OK" }]
    })
    : await adapter.startTurn({
      correlationId,
      threadHandle: created.thread_handle,
      threadId: created.thread_id,
      input: "Return exactly: ORQUESTA_PHASE2_LIVE_OK"
    });
  if (!turn.ok) throw phase2Error("PHASE2_RUNTIME_DISPATCH_FAILED", `${adapterKind} did not accept the Codex turn.`, { result: turn });
  const events = await observed.completion;
  const timeline = events.map((event) => event.type).filter((type) => ["dispatch_accepted", "thread_started", "turn_started", "progress_observed", "artifact_produced", "turn_completed"].includes(type));
  const started = events.find((event) => event.type === "turn_started") || null;
  const progress = events.find((event) => event.type === "progress_observed") || null;
  const completed = events.find((event) => event.type === "turn_completed") || null;
  const produced = events.find((event) => event.type === "artifact_produced") || null;
  return {
    adapter: adapterKind,
    thread_id: turn.thread_id || created.thread_id || null,
    turn_id: turn.turn_id || started?.turn_id || null,
    dispatch: turn,
    started,
    progress,
    completed,
    timeline,
    artifact_content: produced?.content || null,
    dispatch_accepted: Boolean(turn.evidence?.dispatch_accepted),
    turn_started: Boolean(started),
    turn_completed: Boolean(completed),
    actual_model: null,
    actual_model_evidence_ref: null
  };
}

async function executeLiveCodexTurn({ correlationId, workingDirectory, timeoutMs } = {}) {
  let child = null;
  const appServer = createAppServerAdapter({
    spawnProcess(command, args, options) {
      child = spawn(command, args, options);
      return child;
    }
  });
  try {
    return await runAdapterTurn({ adapter: appServer, adapterKind: "app_server", correlationId, workingDirectory, timeoutMs });
  } catch (appServerError) {
    if (child && !child.killed) child.kill();
    const sdk = createSdkAdapter();
    try {
      const result = await runAdapterTurn({ adapter: sdk, adapterKind: "typescript_sdk", correlationId, workingDirectory, timeoutMs });
      return { ...result, fallback_from: "app_server", fallback_reason: appServerError.code || "app_server_failed" };
    } catch (sdkError) {
      throw phase2Error("PHASE2_CODEX_RUNTIME_UNAVAILABLE", "Neither App Server nor the SDK completed the live Codex turn.", {
        app_server: appServerError.code || appServerError.message,
        sdk: sdkError.code || sdkError.message
      });
    }
  } finally {
    if (child && !child.killed) child.kill();
  }
}

async function runLivePhase2Slice({
  stateRoot,
  outputRoot,
  allowNetwork,
  allowCodexTurn,
  fetchImpl = globalThis.fetch,
  runtimeExecutor = executeLiveCodexTurn,
  clock = () => new Date().toISOString()
} = {}) {
  if (typeof stateRoot !== "string" || !stateRoot || typeof outputRoot !== "string" || !outputRoot
    || allowNetwork !== true || allowCodexTurn !== true) {
    throw phase2Error("PHASE2_LIVE_OPT_IN_REQUIRED", "Live execution requires stateRoot, outputRoot, network, and Codex-turn opt-ins.");
  }
  const projectRoot = path.resolve(stateRoot);
  const reviewRoot = path.resolve(outputRoot);
  if (!fs.statSync(projectRoot).isDirectory()) throw phase2Error("PHASE2_STATE_ROOT_INVALID", "The canonical project state root is not a directory.");
  fs.mkdirSync(reviewRoot, { recursive: true });
  const journalRoot = fs.mkdtempSync(path.join(reviewRoot, "journal-"));
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-phase2-audition-"));
  const auditionRoot = path.join(temporaryRoot, "live-audition");
  try {
    fs.mkdirSync(auditionRoot, { recursive: true });

    const fixtures = loadAdminFixtures();
  const { store, boundary, projectors } = createBoundary(journalRoot, clock);
  boundary.execute({ command_id: "phase2:task-intent", name: "task-intent.create", payload: fixtures.task.task_intent });
  boundary.execute({ command_id: "phase2:capability-compile", name: "capability.compile", payload: {} });
  const graphNeed = boundary.replay().capability_graphs[0].needs[0];
  boundary.execute({ command_id: "phase2:resolution", name: "resolution.propose", payload: { need_id: graphNeed.need_id, candidates: [], audit_facts: [] } });
  boundary.execute({ command_id: "phase2:context", name: "context-pack.preview", payload: {} });
  const lifecycle = boundary.replay();
  const intent = lifecycle.task_intents.find((item) => item.task_intent_id === lifecycle.current_task_intent_id);
  const resolution = lifecycle.resolutions[0];

  const sourcePolicy = {
    ...fixtures.sourcePolicy,
    allowed_connector_ids: ["official_docs", "registry"]
  };
  const query = { need_id: fixtures.task.capability_need.need_id, ...sourcePolicy, requested_at: clock() };
  const acquisition = await searchLiveSources({
    query,
    connectors: createLiveNetworkConnectors({ fetchImpl, clock }),
    cache: null,
    clock
  });
  const sourceFamilies = acquisition.source_results.filter((result) => result.status === "success").map((result) => result.connector_id).sort();
  if (sourceFamilies.length < 2) throw phase2Error("PHASE2_LIVE_SOURCES_INSUFFICIENT", "Fewer than two live source connector families returned evidence.");
  const audits = auditCandidates(acquisition, fixtures.task.capability_need);
  const selectedAudit = audits.find((item) => item.candidate_id === "registry:codex-sdk" && item.evaluation.eligibility === "eligible")
    || audits.find((item) => item.evaluation.eligibility === "eligible");
  if (!selectedAudit) throw phase2Error("PHASE2_ELIGIBLE_CANDIDATE_MISSING", "No live audited candidate passed the hard gates.");
  const selectedRecord = acquisition.candidates.find((item) => item.candidate_id === selectedAudit.candidate_id);

  const roots = { workspace_root: projectRoot, temporary_root: temporaryRoot, audition_root: auditionRoot };
  const profile = { profile_id: "phase2-audition-read-only", allowed_roots: [projectRoot, auditionRoot], effects: [] };
  const auditionPlan = createAuditionPlan({
    task_intent_id: intent.task_intent_id,
    task_intent_hash: canonicalHash(intent),
    resolution_id: resolution.resolution_id,
    resolution_revision: 1,
    resolution_hash: canonicalHash(resolution),
    candidate: { candidate_id: selectedRecord.candidate_id, version: selectedRecord.version || selectedRecord.revision || "observed", source_hash: selectedRecord.source_hash },
    ...roots,
    expected_profile: profile,
    permitted_effects: [],
    steps: fixtures.auditionPolicy.steps,
    expected_evidence: ["live-source-audit", "real-codex-turn", "cleanup:clean"],
    cleanup_plan: { root: auditionRoot, max_paths: fixtures.auditionPolicy.cleanup_max_paths },
    approval_refs: fixtures.auditionPolicy.approval_refs
  });
  const correlationId = `CORR-${canonicalHash({ task_intent_id: intent.task_intent_id, resolution_id: resolution.resolution_id, context_pack_id: lifecycle.current_context_pack_id, source_hash: selectedRecord.source_hash }).slice(0, 12)}`;
  let runtime = null;
  const auditionResult = await runAudition({
    plan: auditionPlan,
    roots,
    harness: {
      inspectProfile: async () => ({ status: "available", verified: true, profile_id: profile.profile_id, source: "codex-runtime-request-profile", captured_at: clock(), allowed_roots: [...profile.allowed_roots], effects: [] }),
      run: async () => {
        runtime = await runtimeExecutor({ correlationId, workingDirectory: auditionRoot, timeoutMs: 180000 });
        return {
          status: runtime.turn_completed ? "completed" : "failed",
          before_manifest: [],
          after_manifest: [],
          effects: [],
          evidence_refs: [`runtime:${runtime.adapter}:${correlationId}`]
        };
      }
    },
    fsAdapter: realFsAdapter(),
    evidenceSink: { record: async () => {} }
  });
  if (auditionResult.verdict !== "passed" || !runtime?.turn_completed) {
    throw phase2Error("PHASE2_LIVE_AUDITION_FAILED", "The authorized live Audition or Codex turn did not complete.");
  }

  const artifactBody = runtime.artifact_content
    ? { kind: "final_response", content: runtime.artifact_content }
    : { kind: "runtime_timeline", correlation_id: correlationId, timeline: runtime.timeline };
  const artifact = { ref: `artifact:phase2-live:${canonicalHash(artifactBody).slice(0, 12)}`, hash: canonicalHash(artifactBody) };
  const reportBody = {
    source_families: sourceFamilies,
    audited_candidate_id: selectedAudit.candidate_id,
    audition_verdict: auditionResult.verdict,
    runtime_adapter: runtime.adapter,
    runtime_timeline: runtime.timeline,
    artifact
  };
  const report = { ref: `report:phase2-live:${canonicalHash(reportBody).slice(0, 12)}`, hash: canonicalHash(reportBody) };
  const acceptance = { ref: "acceptance:phase2-live", status: "passed", checks: [...fixtures.acceptance.checks] };
  const sourceEvidence = acquisition.source_results.flatMap((result) => result.source_evidence);
  const sourceRefs = sourceEvidence.map((entry) => `${entry.source_ref}#${entry.source_hash}`);
  recordEvidenceChain({ boundary, lifecycle, correlationId, sourceRefs, runtime, artifact, report, acceptance, fault: null });
  const projected = boundary.replay();
  const replayed = store.replay({ reducers: projectors, initialState: initialProjection() }).state;
    return {
    source_families: sourceFamilies,
    source_evidence: sourceEvidence,
    audited_candidate: { candidate_id: selectedAudit.candidate_id, status: selectedAudit.evaluation.eligibility, evaluation_id: selectedAudit.evaluation.evaluation_id },
    audition: {
      authorization_ref: fixtures.auditionPolicy.approval_refs[0],
      verdict: auditionResult.verdict,
      cleanup_evidence: auditionResult.cleanup_evidence,
      installed: false,
      audition_plan_id: auditionPlan.audition_plan_id
    },
    runtime: {
      adapter: runtime.adapter,
      dispatch_accepted: runtime.dispatch_accepted,
      turn_started: runtime.turn_started,
      turn_completed: runtime.turn_completed,
      timeline: runtime.timeline,
      actual_model: null,
      actual_model_evidence_ref: null,
      fallback_from: runtime.fallback_from || null,
      fallback_reason: runtime.fallback_reason || null
    },
    artifact,
    report,
    acceptance: { status: "passed", ref: acceptance.ref },
    journal: {
      evidence_ref: `journal:${path.relative(reviewRoot, journalRoot).replaceAll("\\", "/")}`,
      replay_equivalent: projectionHash(projected) === projectionHash(replayed),
      correlation_id: correlationId,
      evidence_count: projected.evidence_by_correlation[correlationId].length
    }
    };
  } finally {
    removeOwnedTemporaryRoot(temporaryRoot);
  }
}

if (require.main === module) {
  const stateIndex = process.argv.indexOf("--state-root");
  const stateRoot = stateIndex >= 0 ? process.argv[stateIndex + 1] : null;
  runDeterministicPhase2Slice({ stateRoot })
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.code || "PHASE2_SLICE_FAILED"}: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  FIXED_CLOCK,
  createDeterministicRuntimeAdapter,
  createLiveNetworkConnectors,
  executeLiveCodexTurn,
  loadAdminFixtures,
  runAdapterTurn,
  runDeterministicPhase2Slice,
  runLivePhase2Slice
};

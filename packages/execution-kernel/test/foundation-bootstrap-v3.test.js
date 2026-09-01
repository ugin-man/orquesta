"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  FOUNDATION_AGENT_IDS,
  classifyFoundationBootstrapV3,
  createFoundationOrganizationV3Bundle,
  createOrganizationV3Store,
  projectRootBindingSha256,
  runFoundationBootstrapV3,
} = require("../src");

const PROJECT_ID = "project-foundation-test";
const BOOTSTRAP_ID = "foundation-bootstrap-test";

function projectRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-foundation-bootstrap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync(root);
}

function sequenceClock(start = Date.parse("2026-08-24T00:00:00.000Z")) {
  let tick = 0;
  return () => new Date(start + (tick++ * 1000));
}

function statePath(root, name) {
  return path.join(root, ".orquesta", "state", name);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function digestTree(root) {
  if (!fs.existsSync(root)) return [];
  const output = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const filePath = path.join(directory, name);
      const relative = path.relative(root, filePath).replaceAll("\\", "/");
      const details = fs.lstatSync(filePath);
      if (details.isDirectory()) {
        output.push({ path: `${relative}/`, kind: "directory" });
        visit(filePath);
      } else {
        output.push({
          path: relative,
          kind: details.isSymbolicLink() ? "symlink" : "file",
          sha256: details.isSymbolicLink() ? null : crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
        });
      }
    }
  }
  visit(root);
  return output;
}

function createSessionPort(root, {
  projectId = PROJECT_ID,
  accepted = new Map(),
  provisionOverride = null,
  findOverride = null,
} = {}) {
  const calls = { initialize: 0, require: 0, find: [], provision: [] };
  let initialized = false;
  const port = {
    project_id: projectId,
    project_root_binding_sha256: projectRootBindingSha256(root),
    runtime_authority_id: "runtime-authority-test",
    calls,
    accepted,
    async ensureAuthority(input) {
      assert.equal(input.projectId, projectId);
      assert.ok(["create_fresh", "migrate_only", "require_existing"].includes(input.policy));
      if (input.policy === "require_existing") calls.require += 1;
      else calls.initialize += 1;
      const changed = input.policy !== "require_existing" && !initialized;
      initialized = true;
      return { changed };
    },
    async findAcceptedFoundationBinding(input) {
      calls.find.push(structuredClone(input));
      if (findOverride) return findOverride(input, accepted);
      return structuredClone(accepted.get(input.requestId) ?? null);
    },
    async provisionFoundationAgent(input) {
      calls.provision.push(structuredClone(input));
      const saga = readJson(statePath(root, "project-bootstrap.json"));
      assert.equal(saga.session_bindings[input.agent.agent_id].status, "requested", "request must be durable before provisioning");
      if (provisionOverride) return provisionOverride(input, accepted);
      // Production persists each provisioning message through MessageLedger V2
      // before the provider acknowledgement returns. Its current canonical
      // directory must coexist with Foundation's final classification.
      fs.mkdirSync(statePath(root, "message-delivery-v1"), { recursive: true });
      const binding = {
        status: "accepted",
        agent_id: input.agent.agent_id,
        thread_id: `thread-${input.agent.agent_id}`,
        session_id: `session-${input.agent.agent_id}`,
        handoff_turn_id: `turn-${input.agent.agent_id}`,
        accepted_at: "2026-08-24T00:00:00.000Z",
        runtime_authority_id: "runtime-authority-test",
      };
      accepted.set(input.requestId, binding);
      return structuredClone(binding);
    },
  };
  return port;
}

async function bootstrap(root, overrides = {}) {
  const leaseRoot = statePath(root, "desktop-writer.lock");
  let createdLease = false;
  if (!fs.existsSync(leaseRoot)) {
    fs.mkdirSync(leaseRoot, { recursive: true });
    writeJson(path.join(leaseRoot, "owner.json"), {
      schema_version: 1,
      pid: process.pid,
      nonce: "writer-lease-test",
      project_id: PROJECT_ID,
      canonical_root: root,
      acquired_at: "2026-08-24T00:00:00.000Z",
    });
    createdLease = true;
  }
  const clock = overrides.clock ?? sequenceClock();
  const sessionPort = overrides.sessionPort ?? createSessionPort(root);
  const observed = classifyFoundationBootstrapV3({
    projectRoot: root,
    projectId: PROJECT_ID,
    organizationStore: overrides.organizationStore ?? null,
  });
  const acceptedExists = Object.values(observed.saga?.session_bindings ?? {})
    .some((entry) => entry?.status === "accepted");
  const sessionAuthorityPolicy = overrides.sessionAuthorityPolicy
    ?? (observed.status === "ready" || acceptedExists ? "require_existing" : "create_fresh");
  try {
    const result = await runFoundationBootstrapV3({
      projectRoot: root,
      projectId: PROJECT_ID,
      bootstrapId: BOOTSTRAP_ID,
      userDisplayName: "Test User",
      clock,
      sessionPort,
      sessionAuthorityPolicy,
      ...overrides,
    });
    return { result, sessionPort, clock };
  } finally {
    if (createdLease) {
      fs.rmSync(leaseRoot, { recursive: true, force: true });
      const stateRoot = path.dirname(leaseRoot);
      const orquestaRoot = path.dirname(stateRoot);
      if (fs.existsSync(stateRoot) && fs.readdirSync(stateRoot).length === 0) fs.rmdirSync(stateRoot);
      if (fs.existsSync(orquestaRoot) && fs.readdirSync(orquestaRoot).length === 0) fs.rmdirSync(orquestaRoot);
    }
  }
}

test("classifies a truly empty canonical root as fresh without writing", (t) => {
  const root = projectRoot(t);
  const before = digestTree(root);
  const result = classifyFoundationBootstrapV3({ projectRoot: root, projectId: PROJECT_ID });
  assert.equal(result.status, "fresh");
  assert.equal(result.no_write, true);
  assert.deepEqual(digestTree(root), before);
});

test("a direct mutating bootstrap call fails closed when the Desktop writer lease is missing", async (t) => {
  const root = projectRoot(t);
  const before = digestTree(root);
  const result = await runFoundationBootstrapV3({
    projectRoot: root,
    projectId: PROJECT_ID,
    bootstrapId: BOOTSTRAP_ID,
    userDisplayName: "Test User",
    clock: sequenceClock(),
    sessionPort: createSessionPort(root),
    sessionAuthorityPolicy: "create_fresh",
  });
  assert.equal(result.status, "unsupported");
  assert.equal(result.reason, "FOUNDATION_BOOTSTRAP_STATE_INVALID");
  assert.equal(result.no_write, true);
  assert.deepEqual(digestTree(root), before);
});

test("preflights a stale writer marker but a bootstrap run requires current-process ownership", async (t) => {
  const root = projectRoot(t);
  const leaseRoot = statePath(root, "desktop-writer.lock");
  fs.mkdirSync(leaseRoot, { recursive: true });
  writeJson(path.join(leaseRoot, "owner.json"), {
    schema_version: 1,
    pid: process.pid,
    nonce: "writer-lease-test",
    project_id: PROJECT_ID,
    canonical_root: root,
    acquired_at: "2026-08-24T00:00:00.000Z",
  });
  const before = digestTree(root);
  const result = classifyFoundationBootstrapV3({ projectRoot: root, projectId: PROJECT_ID });
  assert.equal(result.status, "fresh");
  assert.deepEqual(digestTree(root), before);

  const ownerPath = path.join(leaseRoot, "owner.json");
  const owner = readJson(ownerPath);
  writeJson(ownerPath, { ...owner, pid: process.pid + 1 });
  const foreignBefore = digestTree(root);
  const foreign = classifyFoundationBootstrapV3({ projectRoot: root, projectId: PROJECT_ID });
  assert.equal(foreign.status, "fresh");
  assert.deepEqual(digestTree(root), foreignBefore);

  const attempted = await bootstrap(root);
  assert.equal(attempted.result.status, "unsupported");
  assert.equal(attempted.result.reason, "FOUNDATION_BOOTSTRAP_STATE_INVALID");
  assert.deepEqual(digestTree(root), foreignBefore);
});

test("fresh bootstrap binds all sessions before activation and a ready rerun is no-write", async (t) => {
  const root = projectRoot(t);
  const contextPath = path.join(root, ".orquesta", "context", "user-owned.txt");
  fs.mkdirSync(path.dirname(contextPath), { recursive: true });
  fs.writeFileSync(contextPath, "preserve me\n", "utf8");
  const contextHash = crypto.createHash("sha256").update(fs.readFileSync(contextPath)).digest("hex");
  const baseStore = createOrganizationV3Store({ rootPath: root, clock: () => "2026-08-24T00:00:00.000Z" });
  let activationChecks = 0;
  const observedStore = Object.freeze({
    project_root_binding_sha256: baseStore.project_root_binding_sha256,
    inspect: () => baseStore.inspect(),
    recover: () => baseStore.recover(),
    initialize: (input) => baseStore.initialize(input),
    commit(command) {
      if (command.kind === "set_persistent_agent_lifecycle") {
        const saga = readJson(statePath(root, "project-bootstrap.json"));
        assert.equal(saga.phase, "foundation_sessions_bound");
        assert.deepEqual(Object.values(saga.session_bindings).map((entry) => entry.status), ["accepted", "accepted", "accepted"]);
        activationChecks += 1;
      }
      return baseStore.commit(command);
    },
  });
  const sessionPort = createSessionPort(root);
  const first = await bootstrap(root, { organizationStore: observedStore, sessionPort, clock: sequenceClock() });
  assert.equal(first.result.status, "ready");
  assert.equal(first.result.no_write, false);
  assert.equal(activationChecks, 3);
  assert.equal(sessionPort.calls.provision.length, 3);
  assert.equal(sessionPort.calls.initialize, 1);
  assert.equal(classifyFoundationBootstrapV3({ projectRoot: root, projectId: PROJECT_ID, organizationStore: observedStore }).status, "ready");
  const organization = observedStore.inspect();
  assert.deepEqual(organization.bundle.agentRegistry.agents.map((agent) => agent.lifecycle_state), ["active", "active", "active"]);
  const saga = readJson(statePath(root, "project-bootstrap.json"));
  assert.equal(saga.phase, "complete");
  assert.equal(saga.revision > 0, true);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(contextPath)).digest("hex"), contextHash);

  const before = digestTree(path.join(root, ".orquesta"));
  const second = await bootstrap(root, { organizationStore: observedStore, sessionPort, clock: sequenceClock(Date.parse("2026-08-25T00:00:00.000Z")) });
  assert.equal(second.result.status, "ready");
  assert.equal(second.result.no_write, true);
  assert.equal(sessionPort.calls.provision.length, 3);
  assert.equal(sessionPort.calls.initialize, 1);
  assert.equal(sessionPort.calls.require, 1, "ready verification must never recreate missing Session authority");
  assert.deepEqual(digestTree(path.join(root, ".orquesta")), before);
});

test("resumes the durable gap after Organization initialization without duplicating sessions", async (t) => {
  const root = projectRoot(t);
  const sessionPort = createSessionPort(root);
  await assert.rejects(
    bootstrap(root, { sessionPort, clock: sequenceClock(), failpoint: "after_organization_initialized" }),
    { code: "FOUNDATION_BOOTSTRAP_FAILPOINT" }
  );
  const observed = classifyFoundationBootstrapV3({ projectRoot: root, projectId: PROJECT_ID });
  assert.equal(observed.status, "incomplete");
  assert.equal(fs.existsSync(statePath(root, "project-bootstrap.json")), false);
  const resumed = await bootstrap(root, { sessionPort, clock: sequenceClock(Date.parse("2026-08-24T02:00:00.000Z")) });
  assert.equal(resumed.result.status, "ready");
  assert.equal(sessionPort.calls.provision.length, 3);
});

test("removes only a verified store-owned stale state candidate after entering the bootstrap lock", async (t) => {
  const root = projectRoot(t);
  const staging = path.join(root, ".orquesta", "runtime", "foundation-bootstrap-v3");
  fs.mkdirSync(staging, { recursive: true });
  const stale = path.join(staging, ".bootstrap-state-777-00000000-0000-4000-8000-000000000000.json");
  const unrelated = path.join(staging, "user-owned.txt");
  fs.writeFileSync(stale, "{}\n", "utf8");
  fs.writeFileSync(unrelated, "preserve\n", "utf8");
  const port = createSessionPort(root);
  const result = await bootstrap(root, { sessionPort: port, clock: sequenceClock() });
  assert.equal(result.result.status, "ready");
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.readFileSync(unrelated, "utf8"), "preserve\n");
});

test("resumes an accepted session from the exact request without reprovisioning it", async (t) => {
  const root = projectRoot(t);
  const sessionPort = createSessionPort(root);
  await assert.rejects(
    bootstrap(root, { sessionPort, clock: sequenceClock(), failpoint: "after_session_accepted:orchestrator" }),
    { code: "FOUNDATION_BOOTSTRAP_FAILPOINT" }
  );
  assert.equal(sessionPort.calls.provision.filter((call) => call.agent.agent_id === "orchestrator").length, 1);
  assert.equal(classifyFoundationBootstrapV3({ projectRoot: root, projectId: PROJECT_ID }).status, "incomplete");
  const resumed = await bootstrap(root, { sessionPort, clock: sequenceClock(Date.parse("2026-08-24T03:00:00.000Z")) });
  assert.equal(resumed.result.status, "ready");
  assert.equal(sessionPort.calls.provision.filter((call) => call.agent.agent_id === "orchestrator").length, 1);
  assert.equal(sessionPort.calls.provision.length, 3);
});

test("never recreates Session authority after a Foundation request has started", async (t) => {
  const root = projectRoot(t);
  const sessionPort = createSessionPort(root);
  await assert.rejects(
    bootstrap(root, { sessionPort, clock: sequenceClock(), failpoint: "after_session_requested:orchestrator" }),
    { code: "FOUNDATION_BOOTSTRAP_FAILPOINT" }
  );
  const saga = readJson(statePath(root, "project-bootstrap.json"));
  assert.equal(saga.phase, "foundation_sessions_provisioning");
  assert.equal(saga.session_bindings.orchestrator.status, "requested");
  assert.equal(sessionPort.calls.provision.length, 0);
  const initializationCalls = sessionPort.calls.initialize;
  const staging = path.join(root, ".orquesta", "runtime", "foundation-bootstrap-v3");
  const stale = path.join(staging, `.bootstrap-state-${process.pid}-00000000-0000-4000-8000-000000000000.json`);
  fs.writeFileSync(stale, "{}\n", "utf8");

  const resumedWithoutAuthority = await bootstrap(root, {
    sessionPort,
    sessionAuthorityPolicy: "create_fresh",
    clock: sequenceClock(Date.parse("2026-08-24T02:30:00.000Z")),
  });
  assert.deepEqual(resumedWithoutAuthority.result, {
    status: "repair_required",
    classification: "incomplete",
    reason: "session_binding_authority_missing_after_foundation_progress",
    no_write: false,
  });
  assert.equal(fs.existsSync(stale), false, "the stale owned candidate is a real cleanup write");
  assert.equal(sessionPort.calls.initialize, initializationCalls, "repair must not recreate the missing authority");
  assert.equal(sessionPort.calls.provision.length, 0, "repair must not dispatch the requested session again");
});

test("resumes an exact activation command committed before its saga receipt", async (t) => {
  const root = projectRoot(t);
  const sessionPort = createSessionPort(root);
  await assert.rejects(
    bootstrap(root, { sessionPort, clock: sequenceClock(), failpoint: "after_agent_commit:orchestrator" }),
    { code: "FOUNDATION_BOOTSTRAP_FAILPOINT" }
  );
  let saga = readJson(statePath(root, "project-bootstrap.json"));
  assert.equal(saga.activations.orchestrator.status, "requested");
  const revisionAfterCrash = createOrganizationV3Store({ rootPath: root }).inspect().bundle.organization.revision;
  const resumed = await bootstrap(root, { sessionPort, clock: sequenceClock(Date.parse("2026-08-24T04:00:00.000Z")) });
  assert.equal(resumed.result.status, "ready");
  const finalRevision = createOrganizationV3Store({ rootPath: root }).inspect().bundle.organization.revision;
  assert.equal(finalRevision, revisionAfterCrash + 2, "the committed orchestrator activation must not be applied twice");
  saga = readJson(statePath(root, "project-bootstrap.json"));
  assert.equal(saga.activations.orchestrator.status, "active");
});

test("classifies a prepared Organization transition and explicitly recovers before resuming", async (t) => {
  const root = projectRoot(t);
  const sessionPort = createSessionPort(root);
  const failedStore = createOrganizationV3Store({
    rootPath: root,
    clock: () => "2026-08-24T00:00:00.000Z",
    failpoint: "after_prepare",
  });
  await assert.rejects(
    bootstrap(root, { organizationStore: failedStore, sessionPort, clock: sequenceClock() }),
    { code: "ORGANIZATION_STORE_FAILPOINT" }
  );
  assert.equal(classifyFoundationBootstrapV3({ projectRoot: root, projectId: PROJECT_ID }).status, "prepared");
  const recoveredStore = createOrganizationV3Store({ rootPath: root, clock: () => "2026-08-24T05:00:00.000Z" });
  const resumed = await bootstrap(root, {
    organizationStore: recoveredStore,
    sessionPort,
    clock: sequenceClock(Date.parse("2026-08-24T05:00:00.000Z")),
  });
  assert.equal(resumed.result.status, "ready");
  assert.equal(classifyFoundationBootstrapV3({ projectRoot: root, projectId: PROJECT_ID }).status, "ready");
});

test("fails closed without directory or byte changes for v2, mixed, and partial authority", async (t) => {
  const cases = [
    {
      name: "v2",
      arrange(root) {
        writeJson(statePath(root, "organization.json"), { schema_version: 2, revision: 9 });
        writeJson(statePath(root, "roles.json"), { schema_version: 1, roles: [] });
      },
      expected: "legacy_v2",
      expectedReason: "organization_v2_migration_required",
    },
    {
      name: "mixed",
      arrange(root) {
        const bundle = createFoundationOrganizationV3Bundle({
          createdAt: "2026-08-24T00:00:00.000Z",
          bootstrapId: BOOTSTRAP_ID,
        });
        const store = createOrganizationV3Store({ rootPath: root, clock: () => "2026-08-24T00:00:00.000Z" });
        store.initialize({ bundle, commandId: "mixed-v3-foundation" });
        writeJson(statePath(root, "organization.json"), { schema_version: 2, revision: 9 });
      },
      expected: "mixed_v2",
    },
    {
      name: "partial",
      arrange(root) {
        writeJson(statePath(root, "agents.json"), { schema_version: 3, organization_revision: 1, agents: [] });
      },
      expected: "partial",
    },
  ];
  for (const fixture of cases) {
    const root = projectRoot(t);
    fixture.arrange(root);
    const before = digestTree(root);
    const port = createSessionPort(root);
    const classified = classifyFoundationBootstrapV3({ projectRoot: root, projectId: PROJECT_ID });
    assert.equal(classified.status, fixture.expected, fixture.name);
    if (fixture.expectedReason) assert.equal(classified.reason, fixture.expectedReason, fixture.name);
    const result = await bootstrap(root, { sessionPort: port, clock: sequenceClock() });
    assert.equal(result.result.status, "migration_required", fixture.name);
    assert.equal(result.result.classification, fixture.expected, fixture.name);
    assert.equal(port.calls.initialize, 0, fixture.name);
    assert.equal(port.calls.provision.length, 0, fixture.name);
    assert.deepEqual(digestTree(root), before, `${fixture.name} must remain byte-for-byte and entry-for-entry unchanged`);
  }
});

test("other store state and setup history do not become Foundation migration markers", async (t) => {
  const root = projectRoot(t);
  writeJson(statePath(root, "tasks.json"), { version: 1, tasks: [] });
  writeJson(statePath(root, "tasks.json.bak"), { version: 1, tasks: [] });
  writeJson(statePath(root, "sessions.json"), { version: 1, sessions: [] });
  writeJson(statePath(root, "inspection-runs.json"), { schema_version: 1, runs: [] });
  const setup = path.join(root, ".orquesta", "setup");
  fs.mkdirSync(setup, { recursive: true });
  fs.writeFileSync(path.join(setup, "history.json"), "{\"status\":\"retired\"}\n", "utf8");
  const preserved = [
    statePath(root, "tasks.json"),
    statePath(root, "tasks.json.bak"),
    statePath(root, "sessions.json"),
    statePath(root, "inspection-runs.json"),
    path.join(setup, "history.json"),
  ].map((filePath) => [filePath, fs.readFileSync(filePath)]);
  const port = createSessionPort(root);
  assert.equal(classifyFoundationBootstrapV3({ projectRoot: root, projectId: PROJECT_ID }).status, "fresh");
  const result = await bootstrap(root, { sessionPort: port, clock: sequenceClock() });
  assert.equal(result.result.status, "ready");
  assert.equal(port.calls.initialize, 1);
  for (const [filePath, bytes] of preserved) assert.deepEqual(fs.readFileSync(filePath), bytes);
});

test("known legacy Foundation setup authority is migration-required and remains byte-for-byte unchanged", async (t) => {
  for (const marker of ["setup_state.json", "provisioning_batch.json", "foundation-provisioning"]) {
    const root = projectRoot(t);
    const setup = path.join(root, ".orquesta", "setup");
    fs.mkdirSync(setup, { recursive: true });
    if (marker === "foundation-provisioning") {
      fs.mkdirSync(path.join(setup, marker), { recursive: true });
      fs.writeFileSync(path.join(setup, marker, "orchestrator.json"), "{}\n", "utf8");
    } else {
      fs.writeFileSync(path.join(setup, marker), "{}\n", "utf8");
    }
    const before = digestTree(root);
    const port = createSessionPort(root);
    const classified = classifyFoundationBootstrapV3({ projectRoot: root, projectId: PROJECT_ID });
    assert.equal(classified.status, "legacy_v2", marker);
    assert.equal(classified.reason, "organization_v2_migration_required", marker);
    const result = await bootstrap(root, { sessionPort: port, clock: sequenceClock() });
    assert.equal(result.result.status, "migration_required", marker);
    assert.equal(result.result.classification, "legacy_v2", marker);
    assert.equal(port.calls.initialize, 0, marker);
    assert.equal(port.calls.provision.length, 0, marker);
    assert.deepEqual(digestTree(root), before, `${marker} must remain byte-for-byte unchanged`);
  }
});

test("future or schema-less Organization authority is unsupported rather than treated as v2", async (t) => {
  for (const fixture of [
    { name: "future", value: { schema_version: 4, organization_revision: 1, agents: [] } },
    { name: "schema-less", value: { organization_revision: 1, agents: [] } },
  ]) {
    const root = projectRoot(t);
    writeJson(statePath(root, "agents.json"), fixture.value);
    const before = digestTree(root);
    const port = createSessionPort(root);
    const classified = classifyFoundationBootstrapV3({ projectRoot: root, projectId: PROJECT_ID });
    assert.equal(classified.status, "unsupported", fixture.name);
    assert.equal(classified.reason, "organization_authority_schema_unsupported", fixture.name);
    const result = await bootstrap(root, { sessionPort: port, clock: sequenceClock() });
    assert.equal(result.result.status, "unsupported", fixture.name);
    assert.equal(port.calls.initialize, 0, fixture.name);
    assert.equal(port.calls.provision.length, 0, fixture.name);
    assert.deepEqual(digestTree(root), before, `${fixture.name} must remain byte-for-byte unchanged`);
  }
});

test("does not record or activate a session acknowledgement that the session authority cannot read back", async (t) => {
  const root = projectRoot(t);
  let provisioned = false;
  const port = createSessionPort(root, {
    provisionOverride(input) {
      provisioned = true;
      return {
        status: "accepted",
        agent_id: input.agent.agent_id,
        thread_id: `thread-${input.agent.agent_id}`,
        session_id: `session-${input.agent.agent_id}`,
        handoff_turn_id: `turn-${input.agent.agent_id}`,
        accepted_at: "2026-08-24T01:00:00.000Z",
        runtime_authority_id: "runtime-authority-test",
      };
    },
    findOverride() { return null; },
  });
  await assert.rejects(
    bootstrap(root, { sessionPort: port, clock: sequenceClock() }),
    { code: "FOUNDATION_BOOTSTRAP_SESSION_PERSISTENCE_MISMATCH" }
  );
  assert.equal(provisioned, true);
  const saga = readJson(statePath(root, "project-bootstrap.json"));
  assert.equal(saga.session_bindings.orchestrator.status, "requested");
  const organization = createOrganizationV3Store({ rootPath: root }).inspect();
  assert.deepEqual(organization.bundle.agentRegistry.agents.map((agent) => agent.lifecycle_state), ["provisioning", "provisioning", "provisioning"]);
});

test("ready verification is bound to the exact thread and handoff turn evidence", async (t) => {
  const root = projectRoot(t);
  const port = createSessionPort(root);
  const first = await bootstrap(root, { sessionPort: port, clock: sequenceClock() });
  assert.equal(first.result.status, "ready");
  const request = port.calls.provision.find((call) => call.agent.agent_id === "orchestrator").requestId;
  port.accepted.set(request, {
    ...port.accepted.get(request),
    handoff_turn_id: "turn-unrelated-on-same-thread",
  });
  const before = digestTree(path.join(root, ".orquesta"));
  const observed = await bootstrap(root, {
    sessionPort: port,
    clock: sequenceClock(Date.parse("2026-08-25T00:00:00.000Z")),
  });
  assert.equal(observed.result.status, "repair_required");
  assert.equal(observed.result.reason, "accepted_binding_mismatch:orchestrator");
  assert.deepEqual(digestTree(path.join(root, ".orquesta")), before);
});

test("opaque handoff turn ids may repeat across distinct Foundation threads", async (t) => {
  const root = projectRoot(t);
  const port = createSessionPort(root, {
    provisionOverride(input, accepted) {
      const binding = {
        status: "accepted",
        agent_id: input.agent.agent_id,
        thread_id: `thread-${input.agent.agent_id}`,
        session_id: `session-${input.agent.agent_id}`,
        handoff_turn_id: "turn-provider-local-id",
        accepted_at: "2026-08-24T00:00:00.000Z",
        runtime_authority_id: "runtime-authority-test",
      };
      accepted.set(input.requestId, binding);
      return structuredClone(binding);
    },
  });
  const result = await bootstrap(root, { sessionPort: port, clock: sequenceClock() });
  assert.equal(result.result.status, "ready");
  assert.deepEqual(
    Object.values(result.result.session_bindings).map((binding) => binding.handoff_turn_id),
    ["turn-provider-local-id", "turn-provider-local-id", "turn-provider-local-id"]
  );
});

test("rejects session and organization ports bound to another native root before writing", async (t) => {
  const root = projectRoot(t);
  const port = createSessionPort(root);
  port.project_root_binding_sha256 = "0".repeat(64);
  const before = digestTree(root);
  await assert.rejects(
    bootstrap(root, { sessionPort: port, clock: sequenceClock() }),
    { code: "FOUNDATION_BOOTSTRAP_SESSION_PORT_INVALID" }
  );
  assert.deepEqual(digestTree(root), before);
});

test("foundation bootstrap package source has no old setup or Orquesta script dependency", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "foundation-bootstrap-v3.js"), "utf8");
  assert.doesNotMatch(source, /require\(["'][^"']*(?:orquesta[\\/]scripts|setup-engine|specialist-provisioner)/u);
});

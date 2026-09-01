"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { setPersistentAgentLifecycleCommand } = require("../src/organization-controller-v3");
const { createFoundationOrganizationV3Bundle } = require("../src/organization-v3");
const { createOrganizationV3Store, inspectOrganizationV3 } = require("../src/organization-store-v3");

const NOW = "2026-08-24T05:00:00.000Z";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-organization-store-"));
  return {
    root,
    dispose() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function foundation() {
  return createFoundationOrganizationV3Bundle({ createdAt: NOW, bootstrapId: "bootstrap-test" });
}

function treeDigest(root) {
  const files = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const filePath = path.join(directory, name);
      const details = fs.lstatSync(filePath);
      if (details.isDirectory()) visit(filePath);
      else files.push(`${path.relative(root, filePath).replaceAll("\\", "/")}:${crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex")}`);
    }
  }
  visit(root);
  return files;
}

test("OrganizationV3Store initializes the five-file authority once", () => {
  const project = fixture();
  try {
    const store = createOrganizationV3Store({ rootPath: project.root, clock: () => NOW });
    assert.equal(store.inspect().status, "missing");
    const initialized = store.initialize({ bundle: foundation(), commandId: "bootstrap-test" });
    assert.equal(initialized.status, "initialized");
    assert.equal(store.inspect().status, "ready");
    assert.deepEqual(
      ["agents.json", "formations.json", "organization-controller-transition.json", "organization-controller.json", "organization.json"]
        .map((name) => fs.existsSync(path.join(project.root, ".orquesta", "state", name))),
      [true, true, true, true, true]
    );
    assert.equal(store.initialize({ bundle: foundation(), commandId: "bootstrap-test" }).status, "already_initialized");
  } finally {
    project.dispose();
  }
});

test("OrganizationV3Store fails closed for a partial authority", () => {
  const project = fixture();
  try {
    const state = path.join(project.root, ".orquesta", "state");
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, "agents.json"), "{}\n", "utf8");
    assert.equal(inspectOrganizationV3(project.root).status, "migration_required");
    assert.throws(
      () => createOrganizationV3Store({ rootPath: project.root }).initialize({ bundle: foundation() }),
      { code: "ORGANIZATION_STORE_MIGRATION_REQUIRED" }
    );
  } finally {
    project.dispose();
  }
});

test("OrganizationV3Store rolls a prepared partial transaction forward", () => {
  const project = fixture();
  try {
    const interrupted = createOrganizationV3Store({
      rootPath: project.root,
      clock: () => NOW,
      failpoint: "after_first_target",
    });
    assert.throws(
      () => interrupted.initialize({ bundle: foundation(), commandId: "bootstrap-crash" }),
      { code: "ORGANIZATION_STORE_FAILPOINT" }
    );
    assert.equal(interrupted.inspect().status, "recovery_required");
    const recovered = createOrganizationV3Store({ rootPath: project.root, clock: () => NOW }).recover();
    assert.equal(recovered.status, "commit_finalized");
    assert.equal(inspectOrganizationV3(project.root).status, "ready");
    assert.equal(readTransition(project.root).status, "committed");
  } finally {
    project.dispose();
  }
});

test("OrganizationV3Store never overwrites an external change during prepared recovery", () => {
  const project = fixture();
  try {
    const interrupted = createOrganizationV3Store({
      rootPath: project.root,
      clock: () => NOW,
      failpoint: "after_first_target",
    });
    assert.throws(
      () => interrupted.initialize({ bundle: foundation(), commandId: "bootstrap-recovery-cas" }),
      { code: "ORGANIZATION_STORE_FAILPOINT" }
    );
    const organizationPath = path.join(project.root, ".orquesta", "state", "organization.json");
    const externalBytes = `${JSON.stringify({ external_writer_marker: true }, null, 2)}\n`;
    fs.writeFileSync(organizationPath, externalBytes, "utf8");
    assert.throws(
      () => createOrganizationV3Store({ rootPath: project.root, clock: () => NOW }).recover(),
      { code: "ORGANIZATION_STORE_RECOVERY_CONFLICT" }
    );
    assert.equal(fs.readFileSync(organizationPath, "utf8"), externalBytes);
  } finally {
    project.dispose();
  }
});

test("OrganizationV3Store serializes controller commands with CAS and idempotence", () => {
  const project = fixture();
  try {
    const store = createOrganizationV3Store({ rootPath: project.root, clock: () => NOW });
    store.initialize({ bundle: foundation(), commandId: "bootstrap-command" });
    const ready = store.inspect();
    const command = setPersistentAgentLifecycleCommand({
      expectedRevision: ready.bundle.organization.revision,
      expectedHeadHash: ready.head_hash,
      agentId: "orchestrator",
      lifecycleState: "active",
      changedAt: NOW,
      acceptedSessionBinding: {
        status: "accepted",
        agent_id: "orchestrator",
        thread_id: "thread-orchestrator",
        session_id: "session-orchestrator-g1",
        accepted_at: NOW,
      },
    });
    assert.equal(store.commit(command).status, "committed");
    assert.equal(store.commit(command).status, "already_applied");
    assert.equal(store.inspect().bundle.agentRegistry.agents[0].lifecycle_state, "active");
  } finally {
    project.dispose();
  }
});

test("OrganizationV3Store validates a repeated command before accepting idempotence", () => {
  const project = fixture();
  try {
    const store = createOrganizationV3Store({ rootPath: project.root, clock: () => NOW });
    store.initialize({ bundle: foundation(), commandId: "bootstrap-command" });
    assert.throws(
      () => store.commit({ command_id: "bootstrap-command", rogue_payload: true }),
      { code: "ORGANIZATION_COMMAND_INVALID" }
    );
  } finally {
    project.dispose();
  }
});

test("OrganizationV3Store abandons a verified partial prepare and retries cleanly", () => {
  const project = fixture();
  try {
    const interrupted = createOrganizationV3Store({ rootPath: project.root, clock: () => NOW, failpoint: "after_first_stage" });
    assert.throws(
      () => interrupted.initialize({ bundle: foundation(), commandId: "bootstrap-stage-crash" }),
      { code: "ORGANIZATION_STORE_FAILPOINT" }
    );
    assert.equal(interrupted.inspect().status, "recovery_required");
    const recovery = createOrganizationV3Store({ rootPath: project.root, clock: () => NOW }).recover();
    assert.equal(recovery.status, "preparation_abandoned");
    assert.equal(inspectOrganizationV3(project.root).status, "missing");
    assert.equal(
      createOrganizationV3Store({ rootPath: project.root, clock: () => NOW })
        .initialize({ bundle: foundation(), commandId: "bootstrap-stage-crash" }).status,
      "initialized"
    );
  } finally {
    project.dispose();
  }
});

test("OrganizationV3Store ignores other store authorities and only classifies its own legacy authority", () => {
  for (const name of ["tasks.json", "sessions.json", "roles.json", "inspection-runs.json"]) {
    const project = fixture();
    try {
      const state = path.join(project.root, ".orquesta", "state");
      fs.mkdirSync(state, { recursive: true });
      fs.writeFileSync(path.join(state, name), "{}\n", "utf8");
      assert.equal(inspectOrganizationV3(project.root).status, "missing", name);
    } finally {
      project.dispose();
    }
  }

  const setupHistory = fixture();
  try {
    const setup = path.join(setupHistory.root, ".orquesta", "setup");
    fs.mkdirSync(setup, { recursive: true });
    fs.writeFileSync(path.join(setup, "history.json"), "{}\n", "utf8");
    assert.equal(inspectOrganizationV3(setupHistory.root).status, "missing");
  } finally {
    setupHistory.dispose();
  }

  for (const marker of ["setup_state.json", "provisioning_batch.json", "foundation-provisioning"]) {
    const project = fixture();
    try {
      const setup = path.join(project.root, ".orquesta", "setup");
      fs.mkdirSync(setup, { recursive: true });
      if (marker === "foundation-provisioning") {
        fs.mkdirSync(path.join(setup, marker), { recursive: true });
      } else {
        fs.writeFileSync(path.join(setup, marker), "{}\n", "utf8");
      }
      const inspected = inspectOrganizationV3(project.root);
      assert.equal(inspected.status, "migration_required", marker);
      assert.equal(inspected.reason, "foundation_v2_migration_required", marker);
    } finally {
      project.dispose();
    }
  }

  const legacy = fixture();
  try {
    const state = path.join(legacy.root, ".orquesta", "state");
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, "organization.json"), "{\"schema_version\":2}\n", "utf8");
    assert.equal(inspectOrganizationV3(legacy.root).status, "migration_required");
  } finally {
    legacy.dispose();
  }
});

test("OrganizationV3Store blocks a known legacy Foundation marker mixed with ready V3 authority", () => {
  const project = fixture();
  try {
    const store = createOrganizationV3Store({ rootPath: project.root, clock: () => NOW });
    store.initialize({ bundle: foundation(), commandId: "bootstrap-before-legacy-marker" });
    const state = path.join(project.root, ".orquesta", "state");
    const authorityBefore = Object.fromEntries(
      ["agents.json", "organization.json", "formations.json", "organization-controller.json"]
        .map((name) => [name, fs.readFileSync(path.join(state, name))])
    );
    const setup = path.join(project.root, ".orquesta", "setup");
    fs.mkdirSync(setup, { recursive: true });
    fs.writeFileSync(path.join(setup, "provisioning_batch.json"), "{}\n", "utf8");

    const inspected = store.inspect();
    assert.equal(inspected.status, "migration_required");
    assert.equal(inspected.reason, "foundation_v2_and_organization_v3_mixed");
    assert.throws(
      () => store.commit({ kind: "set_persistent_agent_lifecycle", command_id: "must-not-commit", agent_id: "orchestrator", lifecycle_state: "active", operational_status: "standby", changed_at: NOW }),
      { code: "ORGANIZATION_STORE_NOT_READY" }
    );
    for (const [name, bytes] of Object.entries(authorityBefore)) {
      assert.deepEqual(fs.readFileSync(path.join(state, name)), bytes, name);
    }
  } finally {
    project.dispose();
  }
});

test("OrganizationV3Store never recovers a prepared V3 transition across a legacy Foundation marker", () => {
  const project = fixture();
  try {
    const interrupted = createOrganizationV3Store({ rootPath: project.root, clock: () => NOW, failpoint: "after_prepare" });
    assert.throws(
      () => interrupted.initialize({ bundle: foundation(), commandId: "bootstrap-prepared-before-legacy-marker" }),
      { code: "ORGANIZATION_STORE_FAILPOINT" }
    );
    const setup = path.join(project.root, ".orquesta", "setup");
    fs.mkdirSync(setup, { recursive: true });
    fs.writeFileSync(path.join(setup, "provisioning_batch.json"), "{}\n", "utf8");
    const before = treeDigest(project.root);

    const store = createOrganizationV3Store({ rootPath: project.root, clock: () => NOW });
    const inspected = store.inspect();
    assert.equal(inspected.status, "migration_required");
    assert.equal(inspected.reason, "foundation_v2_and_organization_v3_mixed");
    assert.throws(() => store.recover(), { code: "ORGANIZATION_STORE_MIGRATION_REQUIRED" });
    assert.deepEqual(treeDigest(project.root), before, "failed recovery must leave the prepared transition byte-stable");
  } finally {
    project.dispose();
  }
});

test("OrganizationV3Store rejects path-shaped command ids before staging", () => {
  const project = fixture();
  try {
    const store = createOrganizationV3Store({ rootPath: project.root, clock: () => NOW });
    assert.throws(
      () => store.initialize({ bundle: foundation(), commandId: "../escape" }),
      { code: "ORGANIZATION_STORE_COMMAND_INVALID" }
    );
    assert.equal(fs.existsSync(path.join(project.root, ".orquesta", "escape-agents.json")), false);
  } finally {
    project.dispose();
  }
});

test("OrganizationV3Store fails closed when fixed writer authority is altered", () => {
  const project = fixture();
  try {
    const store = createOrganizationV3Store({ rootPath: project.root, clock: () => NOW });
    store.initialize({ bundle: foundation(), commandId: "bootstrap-writer" });
    const controllerPath = path.join(project.root, ".orquesta", "state", "organization-controller.json");
    const controller = JSON.parse(fs.readFileSync(controllerPath, "utf8"));
    controller.writer_epoch = "caller-selected";
    fs.writeFileSync(controllerPath, `${JSON.stringify(controller, null, 2)}\n`, "utf8");
    assert.throws(() => inspectOrganizationV3(project.root), { code: "ORGANIZATION_STORE_CONTROLLER_INVALID" });
  } finally {
    project.dispose();
  }
});

test("OrganizationV3Store rejects a tampered prepared transition", () => {
  const project = fixture();
  try {
    const interrupted = createOrganizationV3Store({ rootPath: project.root, clock: () => NOW, failpoint: "after_first_target" });
    assert.throws(() => interrupted.initialize({ bundle: foundation(), commandId: "bootstrap-tamper" }));
    const transitionPath = path.join(project.root, ".orquesta", "state", "organization-controller-transition.json");
    const transition = JSON.parse(fs.readFileSync(transitionPath, "utf8"));
    transition.targets[1] = structuredClone(transition.targets[0]);
    fs.writeFileSync(transitionPath, `${JSON.stringify(transition, null, 2)}\n`, "utf8");
    assert.throws(
      () => createOrganizationV3Store({ rootPath: project.root, clock: () => NOW }).recover(),
      { code: "ORGANIZATION_STORE_TRANSITION_INVALID" }
    );
  } finally {
    project.dispose();
  }
});

test("OrganizationV3Store uses the shared reusable hard-link process lock", () => {
  const project = fixture();
  try {
    const staging = path.join(project.root, ".orquesta", "runtime", "organization-store-v3");
    const store = createOrganizationV3Store({ rootPath: project.root, clock: () => NOW });
    const result = store.initialize({ bundle: foundation(), commandId: "bootstrap-process-lock" });
    assert.equal(result.status, "initialized");
    assert.equal(fs.existsSync(path.join(staging, "organization-store-lock-v1.lock")), false);
    assert.equal(fs.existsSync(path.join(staging, "organization-store.lock")), false);
    assert.equal(fs.readdirSync(staging).some((name) => name.includes("candidate-") || name.includes("recovery-")), false);
    assert.equal(store.inspect().status, "ready");
  } finally {
    project.dispose();
  }
});

test("OrganizationV3Store accepts an exact native runtime binding before fresh bootstrap", () => {
  const project = fixture();
  try {
    const state = path.join(project.root, ".orquesta", "state");
    fs.mkdirSync(state, { recursive: true });
    const bindingPath = path.join(state, "runtime-binding.json");
    const bindingBytes = `${JSON.stringify({
      schema_version: 1,
      project_id: "project-test",
      project_root_fingerprint: "0".repeat(64),
      mode: "standalone",
      runtime_authority_id: "runtime-test",
      transport: "app_server",
      calling_thread_id: null,
      established_at: NOW,
      verified_at: NOW,
      migration: null,
    }, null, 2)}\n`;
    fs.writeFileSync(bindingPath, bindingBytes, "utf8");
    const validatedRuntimeBindingSha256 = crypto.createHash("sha256").update(bindingBytes).digest("hex");
    const unvalidated = inspectOrganizationV3(project.root);
    assert.equal(unvalidated.status, "unsupported");
    assert.equal(unvalidated.reason, "runtime_binding_requires_validated_receipt");
    assert.equal(
      inspectOrganizationV3(project.root, { validatedRuntimeBindingSha256 }).status,
      "missing"
    );
    assert.equal(
      createOrganizationV3Store({ rootPath: project.root, validatedRuntimeBindingSha256, clock: () => NOW })
        .initialize({ bundle: foundation(), commandId: "bootstrap-runtime-bound" }).status,
      "initialized"
    );
  } finally {
    project.dispose();
  }
});

test("OrganizationV3Store rejects a tampered committed transition", () => {
  const project = fixture();
  try {
    const store = createOrganizationV3Store({ rootPath: project.root, clock: () => NOW });
    store.initialize({ bundle: foundation(), commandId: "bootstrap-committed-tamper" });
    const transitionPath = path.join(project.root, ".orquesta", "state", "organization-controller-transition.json");
    const transition = JSON.parse(fs.readFileSync(transitionPath, "utf8"));
    transition.rogue_authority = true;
    fs.writeFileSync(transitionPath, `${JSON.stringify(transition, null, 2)}\n`, "utf8");
    assert.equal(inspectOrganizationV3(project.root).status, "unsupported");
  } finally {
    project.dispose();
  }
});

test("OrganizationV3Store rejects canonical authority file symlinks when supported", (context) => {
  const project = fixture();
  const external = fixture();
  try {
    const store = createOrganizationV3Store({ rootPath: project.root, clock: () => NOW });
    store.initialize({ bundle: foundation(), commandId: "bootstrap-symlink" });
    const agentsPath = path.join(project.root, ".orquesta", "state", "agents.json");
    const externalPath = path.join(external.root, "agents.json");
    fs.copyFileSync(agentsPath, externalPath);
    fs.unlinkSync(agentsPath);
    try {
      fs.symlinkSync(externalPath, agentsPath, "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error.code)) {
        context.skip("Windows symlink creation is not enabled");
        return;
      }
      throw error;
    }
    assert.throws(() => inspectOrganizationV3(project.root), { code: "ORGANIZATION_STORE_PATH_UNSAFE" });
  } finally {
    project.dispose();
    external.dispose();
  }
});

test("OrganizationV3Store rejects a transition symlink before recovery mutates canonical state", (context) => {
  const project = fixture();
  const external = fixture();
  try {
    const interrupted = createOrganizationV3Store({ rootPath: project.root, clock: () => NOW, failpoint: "after_targets" });
    assert.throws(
      () => interrupted.initialize({ bundle: foundation(), commandId: "bootstrap-transition-symlink" }),
      { code: "ORGANIZATION_STORE_FAILPOINT" }
    );
    const controllerPath = path.join(project.root, ".orquesta", "state", "organization-controller.json");
    assert.equal(fs.existsSync(controllerPath), false);
    const transitionPath = path.join(project.root, ".orquesta", "state", "organization-controller-transition.json");
    const externalPath = path.join(external.root, "transition.json");
    fs.copyFileSync(transitionPath, externalPath);
    fs.unlinkSync(transitionPath);
    try {
      fs.symlinkSync(externalPath, transitionPath, "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error.code)) {
        context.skip("Windows symlink creation is not enabled");
        return;
      }
      throw error;
    }
    assert.throws(
      () => createOrganizationV3Store({ rootPath: project.root, clock: () => NOW }).recover(),
      { code: "ORGANIZATION_STORE_PATH_UNSAFE" }
    );
    assert.equal(fs.existsSync(controllerPath), false);
  } finally {
    project.dispose();
    external.dispose();
  }
});

function readTransition(root) {
  return JSON.parse(fs.readFileSync(
    path.join(root, ".orquesta", "state", "organization-controller-transition.json"),
    "utf8"
  ));
}

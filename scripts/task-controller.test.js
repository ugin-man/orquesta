"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  TaskControllerError,
  acceptDirectTaskAtomic,
  inspectTask,
  parseArguments,
  recordTaskProgressAtomic,
  reconcileDerivedProjections,
  taskSnapshotSha256,
} = require("../orquesta/scripts/task-controller");

const CREATED_AT = "2026-08-28T00:00:00.000Z";
const REVIEWED_AT = "2026-08-28T00:30:00.000Z";
const ACCEPTED_AT = "2026-08-28T01:00:00.000Z";
const TASK_ID = "T-DIRECT-001";
const DEPENDENT_ID = "T-NEXT-002";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function baseTask(overrides = {}) {
  return {
    task_id: TASK_ID,
    state: "in_progress",
    owner_agent_id: "implementation_owner",
    review_agent_id: "independent_auditor",
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    dependencies: [],
    blocked_by: [],
    specialist_report_required: false,
    completion_transport: "direct",
    acceptance_checks: [
      "日本語の成果物がUTF-8のまま保存される",
      "独立監査の証拠が固定hashで参照される",
    ],
    done_signal: "全基準を満たし、重大または重要な未解決所見がない",
    execution_cycles: [{ cycle: 1, status: "in_progress", started_at: CREATED_AT }],
    ...overrides,
  };
}

function dependentTask() {
  return {
    task_id: DEPENDENT_ID,
    state: "working",
    owner_agent_id: "next_owner",
    review_agent_id: "next_auditor",
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    dependencies: [TASK_ID],
    blocked_by: [TASK_ID, "OTHER-BLOCKER"],
  };
}

function createFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-task-controller-"));
  const task = baseTask({ canonical_state_root: root, ...options.taskOverrides });
  const tasksPath = path.join(root, ".orquesta", "state", "tasks.json");
  const currentPath = path.join(root, ".orquesta", "CURRENT_ORCHESTRA.md");
  const eventsPath = path.join(root, ".orquesta", "state", "events.jsonl");
  writeJson(tasksPath, {
    version: 1,
    updated_at: CREATED_AT,
    tasks: [task, dependentTask()],
  });
  fs.mkdirSync(path.dirname(currentPath), { recursive: true });
  fs.writeFileSync(currentPath, [
    "# Current orchestra",
    `Updated at: ${CREATED_AT}`,
    `- ${TASK_ID}: in_progress`,
    `- ${DEPENDENT_ID}: blocked`,
    "",
  ].join("\n"), "utf8");

  const implementationRelative = "workbench/evidence/実装-proof.json";
  const reviewRelative = "workbench/evidence/review-proof.json";
  const implementationBytes = Buffer.from('{"status":"完了","count":2}\n', "utf8");
  const reviewBytes = Buffer.from('{"status":"accepted","reviewer":"independent_auditor"}\n', "utf8");
  const implementationPath = path.join(root, ...implementationRelative.split("/"));
  const reviewPath = path.join(root, ...reviewRelative.split("/"));
  fs.mkdirSync(path.dirname(implementationPath), { recursive: true });
  fs.writeFileSync(implementationPath, implementationBytes);
  fs.writeFileSync(reviewPath, reviewBytes);

  const packet = {
    schema_version: 1,
    task_id: task.task_id,
    expected_task_sha256: taskSnapshotSha256(task),
    decision: "accepted",
    accepted_at: ACCEPTED_AT,
    accepted_by: "coordination_controller",
    result_summary: "日本語の直接受理が完了しました",
    evidence: [
      { id: "implementation", path: implementationRelative, sha256: sha256(implementationBytes) },
      { id: "review", path: reviewRelative, sha256: sha256(reviewBytes) },
    ],
    criterion_results: task.acceptance_checks.map((criterion, criterionIndex) => ({
      criterion_index: criterionIndex,
      criterion_sha256: sha256(Buffer.from(criterion, "utf8")),
      status: "passed",
      evidence_ids: [criterionIndex === 0 ? "implementation" : "review"],
    })),
    review: {
      reviewer_id: task.review_agent_id,
      status: "accepted",
      reviewed_at: REVIEWED_AT,
      findings: { critical: 0, important: 0, minor: 1 },
      summary: "独立監査を完了し、受理を妨げる所見はありません",
      evidence_ids: ["review"],
    },
    accepted_cycle_numbers: task.execution_cycles.map((cycle) => cycle.cycle),
    completion_evidence: [
      { kind: "implementation", evidence_id: "implementation", status: "passed" },
      { kind: "independent_review", evidence_id: "review", status: "passed" },
    ],
    done_signal: {
      done_signal_sha256: sha256(Buffer.from(task.done_signal, "utf8")),
      satisfied: true,
      evidence_ids: ["implementation", "review"],
    },
  };

  function writePacket(value = packet, name = "acceptance.json") {
    const relative = `workbench/inbox/${TASK_ID}/${name}`;
    const absolute = path.join(root, ...relative.split("/"));
    writeJson(absolute, value);
    const bytes = fs.readFileSync(absolute);
    return { packetPath: relative, packetSha256: sha256(bytes), absolute };
  }

  function accept(packetFile = writePacket()) {
    return acceptDirectTaskAtomic({ rootPath: root, ...packetFile });
  }

  function writeProgressPacket(options = {}) {
    const currentTask = options.task || readJson(tasksPath).tasks.find((candidate) => candidate.task_id === TASK_ID);
    const evidenceRelative = options.evidenceRelative || `workbench/inbox/${TASK_ID}/progress-evidence.json`;
    const evidenceAbsolute = path.join(root, ...evidenceRelative.split("/"));
    const evidenceBytes = options.evidenceBytes || Buffer.from('{"schema_version":1,"result":"focused proof"}\n', "utf8");
    fs.mkdirSync(path.dirname(evidenceAbsolute), { recursive: true });
    fs.writeFileSync(evidenceAbsolute, evidenceBytes);
    const cycle = {
      cycle: 1,
      cycle_id: "implementation-1",
      kind: "implementation",
      status: "completed",
      started_at: CREATED_AT,
      completed_at: "2026-08-28T00:44:00.000Z",
      evidence_ids: ["progress-proof"],
      ...(options.packet?.cycle || {}),
    };
    const progressPacket = {
      schema_version: 1,
      operation: "progress",
      task_id: TASK_ID,
      expected_task_sha256: options.expectedTaskSha256 || taskSnapshotSha256(currentTask),
      recorded_at: "2026-08-28T00:45:00.000Z",
      recorded_by: currentTask.owner_agent_id,
      target_state: "in_progress",
      summary: "The focused progress proof is complete.",
      cycle,
      evidence: [{ id: "progress-proof", path: evidenceRelative, sha256: sha256(evidenceBytes) }],
      ...options.packet,
      cycle,
    };
    const relative = `workbench/inbox/${TASK_ID}/${options.name || "progress.json"}`;
    const absolute = path.join(root, ...relative.split("/"));
    writeJson(absolute, progressPacket);
    return { packetPath: relative, packetSha256: sha256(fs.readFileSync(absolute)), absolute };
  }

  function progress(packetFile = writeProgressPacket()) {
    return recordTaskProgressAtomic({ rootPath: root, ...packetFile });
  }

  return {
    root,
    task,
    packet,
    tasksPath,
    currentPath,
    eventsPath,
    implementationPath,
    reviewPath,
    writePacket,
    writeProgressPacket,
    accept,
    progress,
  };
}

function expectControllerError(action, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof TaskControllerError);
    assert.equal(error.code, code);
    return true;
  });
}

function canonicalSnapshot(fixture) {
  return {
    tasks: fs.readFileSync(fixture.tasksPath),
    current: fs.readFileSync(fixture.currentPath),
    events: fs.existsSync(fixture.eventsPath) ? fs.readFileSync(fixture.eventsPath) : null,
  };
}

function assertCanonicalSnapshot(fixture, expected) {
  const actual = canonicalSnapshot(fixture);
  assert.deepEqual(actual.tasks, expected.tasks);
  assert.deepEqual(actual.current, expected.current);
  assert.deepEqual(actual.events, expected.events);
}

test("direct/report-free packet is accepted atomically and preserves UTF-8", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const result = fixture.accept();
  assert.equal(result.status, "accepted");
  assert.equal(result.projection.status, "current");
  assert.deepEqual(result.unblocked_task_ids, [DEPENDENT_ID]);

  const ledger = readJson(fixture.tasksPath);
  const accepted = ledger.tasks.find((task) => task.task_id === TASK_ID);
  const dependent = ledger.tasks.find((task) => task.task_id === DEPENDENT_ID);
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.result_summary, "日本語の直接受理が完了しました");
  assert.equal(accepted.execution_cycles[0].status, "accepted");
  assert.equal(accepted.execution_cycles[0].completed_at, ACCEPTED_AT);
  assert.equal(accepted.acceptance_packet.reviewer_id, "independent_auditor");
  assert.deepEqual(accepted.acceptance_packet.findings, { critical: 0, important: 0, minor: 1 });
  assert.equal(accepted.acceptance_packet.sha256, result.task.acceptance_packet.sha256);
  assert.deepEqual(dependent.blocked_by, ["OTHER-BLOCKER"]);

  const current = fs.readFileSync(fixture.currentPath, "utf8");
  assert.match(current, new RegExp(`- ${TASK_ID}: accepted \\(日本語の直接受理が完了しました\\)`));
  assert.match(fs.readFileSync(`${fixture.currentPath}.bak`, "utf8"), new RegExp(`- ${TASK_ID}: in_progress`));
  assert.equal(fs.existsSync(fixture.currentPath), true);
  const events = fs.readFileSync(fixture.eventsPath, "utf8").trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_id, `task-acceptance:${TASK_ID}:${accepted.acceptance_packet.sha256}`);

  const inspected = inspectTask({ rootPath: fixture.root, taskId: TASK_ID });
  assert.equal(inspected.state, "accepted");
  assert.equal(inspected.task_sha256, taskSnapshotSha256(accepted));
});

test("same content-addressed packet repairs a partial derived projection idempotently", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const packetFile = fixture.writePacket();
  fs.rmSync(fixture.currentPath);

  const first = fixture.accept(packetFile);
  assert.equal(first.status, "accepted");
  assert.equal(first.projection.status, "pending_replay");
  assert.equal(first.projection.errors[0].name, "current");
  assert.equal(readJson(fixture.tasksPath).tasks[0].state, "accepted");
  assert.equal(fs.readFileSync(fixture.eventsPath, "utf8").trim().split(/\r?\n/u).length, 1);

  fs.writeFileSync(fixture.currentPath, [
    "# Current orchestra",
    `Updated at: ${CREATED_AT}`,
    `- ${TASK_ID}: in_progress`,
    `- ${DEPENDENT_ID}: blocked`,
    "",
  ].join("\n"), "utf8");
  const replay = fixture.accept(packetFile);
  assert.equal(replay.status, "already_accepted");
  assert.equal(replay.projection.status, "current");
  assert.match(fs.readFileSync(fixture.currentPath, "utf8"), /T-DIRECT-001: accepted/u);
  assert.equal(fs.readFileSync(fixture.eventsPath, "utf8").trim().split(/\r?\n/u).length, 1);
});

test("same packet also repairs an event projection failure without duplicating CURRENT", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const packetFile = fixture.writePacket();
  fs.writeFileSync(fixture.eventsPath, "not-json\n", "utf8");

  const first = fixture.accept(packetFile);
  assert.equal(first.status, "accepted");
  assert.equal(first.projection.status, "pending_replay");
  assert.equal(first.projection.errors[0].name, "event");
  assert.match(fs.readFileSync(fixture.currentPath, "utf8"), /T-DIRECT-001: accepted/u);

  fs.writeFileSync(fixture.eventsPath, "", "utf8");
  const replay = fixture.accept(packetFile);
  assert.equal(replay.status, "already_accepted");
  assert.equal(replay.projection.status, "current");
  assert.equal(fs.readFileSync(fixture.eventsPath, "utf8").trim().split(/\r?\n/u).length, 1);
  assert.equal((fs.readFileSync(fixture.currentPath, "utf8").match(/T-DIRECT-001: accepted/gu) || []).length, 1);
});

test("event-id collision stays pending until the wrong projection is removed", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const packetFile = fixture.writePacket();
  fs.writeFileSync(fixture.eventsPath, `${JSON.stringify({
    event_id: `task-acceptance:${TASK_ID}:${packetFile.packetSha256}`,
    timestamp: "2000-01-01T00:00:00.000Z",
    type: "task_rejected",
    actor: "wrong",
    task_id: "OTHER",
    reviewer_id: "wrong",
    packet_ref: `wrong#sha256=${"0".repeat(64)}`,
    summary: "wrong",
  })}\n`, "utf8");

  const accepted = fixture.accept(packetFile);
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.projection.status, "pending_replay");
  assert.equal(accepted.projection.errors[0].code, "JSON_STATE_EVENT_ID_COLLISION");
  assert.equal(readJson(fixture.tasksPath).tasks[0].state, "accepted");

  fs.writeFileSync(fixture.eventsPath, "", "utf8");
  const replay = fixture.accept(packetFile);
  assert.equal(replay.status, "already_accepted");
  assert.equal(replay.projection.status, "current");
  const [event] = fs.readFileSync(fixture.eventsPath, "utf8").trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(event.type, "task_accepted");
  assert.equal(event.task_id, TASK_ID);
});

test("projection replay reads CURRENT under its lock and uses the canonical ledger timestamp", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const packetFile = fixture.writePacket();
  fixture.accept(packetFile);

  const later = "2026-08-28T02:00:00.000Z";
  const ledger = readJson(fixture.tasksPath);
  ledger.updated_at = later;
  writeJson(fixture.tasksPath, ledger);
  fs.writeFileSync(fixture.currentPath, [
    "# Current orchestra",
    `Updated at: ${CREATED_AT}`,
    `- ${TASK_ID}: stale projection`,
    `- ${DEPENDENT_ID}: blocked`,
    "",
  ].join("\n"), "utf8");

  const replay = fixture.accept(packetFile);
  assert.equal(replay.status, "already_accepted");
  const current = fs.readFileSync(fixture.currentPath, "utf8");
  assert.match(current, new RegExp(`Updated at: ${later}`));
  assert.match(current, /T-DIRECT-001: accepted/u);
});

test("task snapshot CAS rejects canonical drift", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const packetFile = fixture.writePacket();
  const ledger = readJson(fixture.tasksPath);
  ledger.tasks[0].updated_at = "2026-08-28T00:45:00.000Z";
  writeJson(fixture.tasksPath, ledger);

  expectControllerError(() => fixture.accept(packetFile), "TASK_CONTROL_STATE_CHANGED");
  assert.equal(readJson(fixture.tasksPath).tasks[0].state, "in_progress");
});

test("acceptance checks dependencies from the ledger held under its write lock", (t) => {
  const fixture = createFixture({ taskOverrides: { dependencies: [DEPENDENT_ID] } });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const initial = readJson(fixture.tasksPath);
  initial.tasks[1].state = "accepted";
  writeJson(fixture.tasksPath, initial);
  const packet = fixture.writePacket();
  let afterDependencyDrift;
  expectControllerError(() => acceptDirectTaskAtomic({
    rootPath: fixture.root,
    ...packet,
    options: { jsonStateOptions: { validateLocked() {
      assert.equal(fs.existsSync(`${fixture.tasksPath}.lock`), true);
      const state = readJson(fixture.tasksPath);
      state.tasks[1].state = "working";
      writeJson(fixture.tasksPath, state);
      afterDependencyDrift = canonicalSnapshot(fixture);
    } } },
  }), "TASK_CONTROL_DEPENDENCY_OPEN");
  assertCanonicalSnapshot(fixture, afterDependencyDrift);
  assert.equal(readJson(fixture.tasksPath).tasks[0].state, "in_progress");
});

test("acceptance and progress reject the same malformed canonical lifecycle", async (t) => {
  const cases = [
    ["blocked_by is not an array", { blocked_by: "OPEN-BLOCKER" }],
    ["dependencies is not an array", { dependencies: "OPEN-DEPENDENCY" }],
    ["invalid creation timestamp", { created_at: "not-a-timestamp" }],
    ["nonpositive cycle", { execution_cycles: [{ cycle: 0, status: "in_progress", started_at: CREATED_AT }] }],
    ["cycle gap", { execution_cycles: [{ cycle: 2, status: "in_progress", started_at: CREATED_AT }] }, "TASK_CONTROL_CYCLE_SEQUENCE_INVALID"],
    ["unsupported cycle status", { execution_cycles: [{ cycle: 1, status: "nonsense", started_at: CREATED_AT }] }],
    ["invalid cycle start", { execution_cycles: [{ cycle: 1, status: "in_progress", started_at: "invalid" }] }],
    ["invalid cycle completion", { execution_cycles: [{ cycle: 1, status: "completed", started_at: CREATED_AT, completed_at: "invalid" }] }],
  ];
  for (const [name, taskOverrides, code = "TASK_CONTROL_STATE_UNSUPPORTED"] of cases) {
    await t.test(name, (subtest) => {
      const fixture = createFixture({ taskOverrides });
      subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
      const before = canonicalSnapshot(fixture);
      expectControllerError(() => fixture.accept(), code);
      expectControllerError(() => fixture.progress(), code);
      assertCanonicalSnapshot(fixture, before);
    });
  }
});

test("canonical validation preserves valid existing ISO timestamp representations", async (t) => {
  for (const timestamp of ["2026-08-28T00:00:00Z", "2026-08-28T09:00:00+09:00", "2026-08-28T00:00:00.0000000Z"]) {
    await t.test(timestamp, (subtest) => {
      const taskOverrides = {
        created_at: timestamp,
        execution_cycles: [{ cycle: 1, status: "in_progress", started_at: timestamp }],
      };
      for (const operation of ["accept", "progress"]) {
        const fixture = createFixture({ taskOverrides });
        subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
        const result = fixture[operation]();
        assert.equal(result.status, operation === "accept" ? "accepted" : "recorded");
        assert.equal(result.task.created_at, timestamp);
        assert.equal(result.projection.status, "current");
      }
    });
  }
});

test("acceptance and progress cannot commit a candidate older than the canonical timeline", async (t) => {
  const later = "2026-08-28T02:00:00.000Z";
  for (const startedAt of [CREATED_AT, later]) {
    await t.test(startedAt, (subtest) => {
      const fixture = createFixture({ taskOverrides: {
        updated_at: later,
        execution_cycles: [{ cycle: 1, status: "in_progress", started_at: startedAt }],
      } });
      subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
      const before = canonicalSnapshot(fixture);
      expectControllerError(() => fixture.accept(), "TASK_CONTROL_STATE_CHANGED");
      const packet = fixture.writeProgressPacket({ packet: {
        cycle: { started_at: startedAt, status: "in_progress", completed_at: null },
        recorded_at: startedAt === later ? later : "2026-08-28T00:45:00.000Z",
      } });
      expectControllerError(() => fixture.progress(packet), "TASK_CONTROL_STATE_CHANGED");
      assertCanonicalSnapshot(fixture, before);
      assert.equal(fs.existsSync(path.join(fixture.root, ".orquesta", "state", "task-progress-packets")), false);
    });
  }
});

test("task writer parent binding propagates a thenable validation rejection", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const packet = fixture.writeProgressPacket();
  const before = canonicalSnapshot(fixture);
  const originalCwd = process.cwd();
  assert.throws(() => recordTaskProgressAtomic({ rootPath: fixture.root, ...packet, options: {
    jsonStateOptions: { validateLocked() {
      assert.equal(process.cwd(), path.dirname(fixture.tasksPath));
      return Promise.resolve();
    } },
  } }), { code: "JSON_STATE_ASYNC_UNSUPPORTED" });
  assert.equal(process.cwd(), originalCwd);
  assertCanonicalSnapshot(fixture, before);
});

test("commits preserve newer ledger and dependent revision timestamps", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const later = "2026-08-28T02:00:00.000Z";
  const state = readJson(fixture.tasksPath);
  state.updated_at = later;
  state.tasks[1].updated_at = later;
  writeJson(fixture.tasksPath, state);
  const progress = fixture.progress();
  assert.equal(progress.status, "recorded");
  assert.equal(readJson(fixture.tasksPath).updated_at, later);
  const packet = { ...fixture.packet, expected_task_sha256: taskSnapshotSha256(progress.task) };
  const accepted = fixture.accept(fixture.writePacket(packet));
  assert.equal(accepted.status, "accepted");
  const final = readJson(fixture.tasksPath);
  assert.equal(final.updated_at, later);
  assert.equal(final.tasks[1].updated_at, later);
  assert.deepEqual(final.tasks[1].blocked_by, ["OTHER-BLOCKER"]);
});

test("packet and evidence content addresses are mandatory", async (t) => {
  await t.test("packet hash mismatch", (subtest) => {
    const fixture = createFixture();
    subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const packetFile = fixture.writePacket();
    expectControllerError(() => fixture.accept({ ...packetFile, packetSha256: "0".repeat(64) }), "TASK_CONTROL_PACKET_HASH_MISMATCH");
  });

  await t.test("evidence hash mismatch", (subtest) => {
    const fixture = createFixture();
    subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    fixture.packet.evidence[0].sha256 = "0".repeat(64);
    expectControllerError(() => fixture.accept(fixture.writePacket()), "TASK_CONTROL_EVIDENCE_HASH_MISMATCH");
  });

  await t.test("path escape", (subtest) => {
    const fixture = createFixture();
    subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    fixture.packet.evidence[0].path = "../outside.json";
    expectControllerError(() => fixture.accept(fixture.writePacket()), "TASK_CONTROL_PATH_UNSAFE");
  });

  await t.test("packet must be strict UTF-8", (subtest) => {
    const fixture = createFixture();
    subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const packetFile = fixture.writePacket();
    fs.writeFileSync(packetFile.absolute, Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
    packetFile.packetSha256 = sha256(fs.readFileSync(packetFile.absolute));
    expectControllerError(() => fixture.accept(packetFile), "TASK_CONTROL_PACKET_INVALID");
  });
});

test("independent reviewer binding and open findings fail closed", async (t) => {
  await t.test("wrong reviewer", (subtest) => {
    const fixture = createFixture();
    subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    fixture.packet.review.reviewer_id = "different_auditor";
    expectControllerError(() => fixture.accept(fixture.writePacket()), "TASK_CONTROL_REVIEWER_MISMATCH");
  });

  await t.test("owner is reviewer", (subtest) => {
    const fixture = createFixture({ taskOverrides: { review_agent_id: "implementation_owner" } });
    subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    expectControllerError(() => fixture.accept(fixture.writePacket()), "TASK_CONTROL_REVIEW_NOT_INDEPENDENT");
  });

  await t.test("important finding remains", (subtest) => {
    const fixture = createFixture();
    subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    fixture.packet.review.findings.important = 1;
    expectControllerError(() => fixture.accept(fixture.writePacket()), "TASK_CONTROL_ACCEPTANCE_REJECTED");
  });

  await t.test("canonical owner identity is missing", (subtest) => {
    const fixture = createFixture({ taskOverrides: { owner_agent_id: null } });
    subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    expectControllerError(() => fixture.accept(fixture.writePacket()), "TASK_CONTROL_STATE_UNSUPPORTED");
  });
});

test("controller rejects non-direct or report-required completion routes", async (t) => {
  await t.test("report is required", (subtest) => {
    const fixture = createFixture({ taskOverrides: { specialist_report_required: true } });
    subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    expectControllerError(() => fixture.accept(fixture.writePacket()), "TASK_CONTROL_ROUTE_UNSUPPORTED");
  });

  await t.test("completion transport is not direct", (subtest) => {
    const fixture = createFixture({ taskOverrides: { completion_transport: "report" } });
    subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    expectControllerError(() => fixture.accept(fixture.writePacket()), "TASK_CONTROL_ROUTE_UNSUPPORTED");
  });
});

test("invalid state transition and blocked task cannot be accepted", async (t) => {
  await t.test("wrong source state", (subtest) => {
    const fixture = createFixture({ taskOverrides: { state: "pending" } });
    subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    expectControllerError(() => fixture.accept(fixture.writePacket()), "TASK_CONTROL_TRANSITION_INVALID");
  });

  await t.test("blocked task", (subtest) => {
    const fixture = createFixture({ taskOverrides: { blocked_by: ["OPEN-DEPENDENCY"] } });
    subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    expectControllerError(() => fixture.accept(fixture.writePacket()), "TASK_CONTROL_TRANSITION_INVALID");
  });
});

test("accepted task rejects a different packet instead of rewriting history", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fixture.accept();
  fixture.packet.result_summary = "同じtaskに対する別の判断";

  expectControllerError(() => fixture.accept(fixture.writePacket(fixture.packet, "different.json")), "TASK_CONTROL_ALREADY_ACCEPTED");
  assert.equal(readJson(fixture.tasksPath).tasks[0].result_summary, "日本語の直接受理が完了しました");
});

test("progress commits through task hash CAS and replays projections idempotently", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const packetFile = fixture.writeProgressPacket();
  const first = fixture.progress(packetFile);

  assert.equal(first.status, "recorded");
  assert.equal(first.task.task_id, TASK_ID);
  assert.equal(first.task.state, "in_progress");
  assert.equal(first.task.execution_cycles[0].status, "completed");
  assert.equal(first.task.execution_cycles[0].progress_packets[0].sha256, packetFile.packetSha256);
  assert.equal(
    first.task.execution_cycles[0].progress_packets[0].path,
    `.orquesta/state/task-progress-packets/${packetFile.packetSha256}.json`,
  );
  assert.match(first.task.execution_cycles[0].evidence_refs[0], /\.json#sha256=[a-f0-9]{64}$/u);
  assert.equal(first.projection.status, "current");
  assert.match(fs.readFileSync(fixture.currentPath, "utf8"), /T-DIRECT-001: in_progress \(The focused progress proof/u);
  assert.equal(fs.readFileSync(fixture.eventsPath, "utf8").trim().split(/\r?\n/u).length, 1);

  const replay = fixture.progress(packetFile);
  assert.equal(replay.status, "already_recorded");
  assert.equal(replay.projection.status, "current");
  assert.equal(fs.readFileSync(fixture.eventsPath, "utf8").trim().split(/\r?\n/u).length, 1);
});

test("a delayed progress projection reads the latest task after another commit", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const firstPacket = fixture.writeProgressPacket({
    name: "first.json",
    packet: { summary: "FIRST", cycle: { status: "in_progress", completed_at: null } },
  });
  const first = recordTaskProgressAtomic({
    rootPath: fixture.root,
    ...firstPacket,
    options: { projectCurrentOrchestra(root, task, validated) {
      const second = fixture.progress(fixture.writeProgressPacket({
        name: "second.json",
        packet: {
          recorded_at: "2026-08-28T00:55:00.000Z",
          summary: "SECOND",
          cycle: { completed_at: "2026-08-28T00:54:00.000Z" },
        },
      }));
      assert.equal(second.projection.status, "current");
      return reconcileDerivedProjections(root, task, validated).results.current;
    } },
  });
  assert.equal(first.projection.status, "current");
  assert.equal(readJson(fixture.tasksPath).tasks[0].result_summary, "SECOND");
  assert.match(fs.readFileSync(fixture.currentPath, "utf8"), /T-DIRECT-001: in_progress \(SECOND\)/u);
});

test("the committed archive replays without its original packet and an uncommitted archive is refused", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const packet = fixture.writeProgressPacket();
  const archivePath = `.orquesta/state/task-progress-packets/${packet.packetSha256}.json`;
  const archiveAbsolute = path.join(fixture.root, ...archivePath.split("/"));
  fs.mkdirSync(path.dirname(archiveAbsolute), { recursive: true });
  fs.copyFileSync(packet.absolute, archiveAbsolute);
  const archiveInput = { rootPath: fixture.root, packetPath: archivePath, packetSha256: packet.packetSha256 };
  const before = canonicalSnapshot(fixture);
  expectControllerError(() => recordTaskProgressAtomic(archiveInput), "TASK_CONTROL_EVIDENCE_NOT_DURABLE");
  assertCanonicalSnapshot(fixture, before);

  const first = recordTaskProgressAtomic({
    rootPath: fixture.root,
    ...packet,
    options: {
      projectCurrentOrchestra() { throw new Error("CURRENT unavailable"); },
      projectProgressEvents() { throw new Error("events unavailable"); },
    },
  });
  assert.equal(first.projection.status, "pending_replay");
  fs.unlinkSync(packet.absolute);
  const committedTasks = fs.readFileSync(fixture.tasksPath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const replay = recordTaskProgressAtomic(archiveInput);
    assert.equal(replay.status, "already_recorded");
    assert.equal(replay.projection.status, "current");
    assert.deepEqual(fs.readFileSync(fixture.tasksPath), committedTasks);
  }
  assert.equal(fs.readFileSync(fixture.eventsPath, "utf8").trim().split(/\r?\n/u).length, 1);
});

test("progress projects history once after commit and never before a rejected CAS", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  let eventAttempts = 0;
  const first = recordTaskProgressAtomic({
    rootPath: fixture.root,
    ...fixture.writeProgressPacket({ packet: { cycle: { status: "in_progress", completed_at: null } } }),
    options: { projectProgressEvents() {
      eventAttempts += 1;
      throw new Error("event projection interrupted");
    } },
  });
  assert.equal(eventAttempts, 1);
  assert.equal(first.projection.status, "pending_replay");
  const stale = fixture.writeProgressPacket({ name: "stale.json", expectedTaskSha256: "0".repeat(64) });
  const before = canonicalSnapshot(fixture);
  expectControllerError(() => fixture.progress(stale), "TASK_CONTROL_STATE_CHANGED");
  assertCanonicalSnapshot(fixture, before);
});

test("a later same-cycle update replays every committed packet after the source is removed", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const firstPacket = fixture.writeProgressPacket({
    name: "progress-started.json",
    evidenceRelative: `workbench/inbox/${TASK_ID}/progress-started-evidence.json`,
    packet: {
      summary: "The focused work started.",
      cycle: { status: "in_progress", completed_at: null },
    },
  });
  fs.writeFileSync(fixture.eventsPath, "not-json\n", "utf8");
  const first = fixture.progress(firstPacket);
  assert.equal(first.projection.status, "pending_replay");
  assert.equal(first.projection.errors[0].name, "event");
  const immutablePath = path.join(
    fixture.root,
    ".orquesta",
    "state",
    "task-progress-packets",
    `${firstPacket.packetSha256}.json`,
  );
  assert.equal(sha256(fs.readFileSync(immutablePath)), firstPacket.packetSha256);

  fs.rmSync(firstPacket.absolute);
  fs.writeFileSync(fixture.eventsPath, "", "utf8");
  const secondPacket = fixture.writeProgressPacket({
    name: "progress-completed.json",
    evidenceRelative: `workbench/inbox/${TASK_ID}/progress-completed-evidence.json`,
    packet: {
      recorded_at: "2026-08-28T00:55:00.000Z",
      summary: "The focused work completed.",
      cycle: { status: "completed", completed_at: "2026-08-28T00:54:00.000Z" },
    },
  });
  const second = fixture.progress(secondPacket);
  assert.equal(second.status, "recorded");
  assert.equal(second.task.execution_cycles[0].progress_packets.length, 2);
  const events = fs.readFileSync(fixture.eventsPath, "utf8").trim().split(/\r?\n/u).map(JSON.parse);
  assert.deepEqual(events.map((event) => event.cycle_status), ["in_progress", "completed"]);
  assert.deepEqual(
    events.map((event) => event.packet_ref),
    [firstPacket, secondPacket].map(({ packetSha256 }) => (
      `.orquesta/state/task-progress-packets/${packetSha256}.json#sha256=${packetSha256}`
    )),
  );
});

test("progress creates the first numbered cycle and normalizes working to in_progress", (t) => {
  const fixture = createFixture({ taskOverrides: { state: "working", execution_cycles: [] } });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = fixture.progress();
  assert.equal(result.status, "recorded");
  assert.equal(result.task.state, "in_progress");
  assert.equal(result.task.execution_cycles.length, 1);
  assert.equal(result.task.execution_cycles[0].cycle, 1);
  assert.equal(readJson(fixture.tasksPath).tasks[0].task_id, TASK_ID);
});

test("progress CAS and lifecycle transitions fail closed without canonical mutation", async (t) => {
  await t.test("stale task revision", (subtest) => {
    const fixture = createFixture();
    subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const packet = fixture.writeProgressPacket({ expectedTaskSha256: "0".repeat(64) });
    const before = canonicalSnapshot(fixture);
    expectControllerError(() => fixture.progress(packet), "TASK_CONTROL_STATE_CHANGED");
    assertCanonicalSnapshot(fixture, before);
  });

  await t.test("accepted task regression", (subtest) => {
    const fixture = createFixture({ taskOverrides: { state: "accepted", accepted_at: REVIEWED_AT } });
    subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const before = canonicalSnapshot(fixture);
    expectControllerError(() => fixture.progress(), "TASK_CONTROL_TRANSITION_INVALID");
    assertCanonicalSnapshot(fixture, before);
  });

  await t.test("completed cycle regression", (subtest) => {
    const fixture = createFixture({
      taskOverrides: {
        updated_at: REVIEWED_AT,
        execution_cycles: [{
          cycle: 1,
          status: "completed",
          started_at: CREATED_AT,
          completed_at: REVIEWED_AT,
        }],
      },
    });
    subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const before = canonicalSnapshot(fixture);
    expectControllerError(() => fixture.progress(), "TASK_CONTROL_TRANSITION_INVALID");
    assertCanonicalSnapshot(fixture, before);
  });

  await t.test("blocked task", (subtest) => {
    const fixture = createFixture({ taskOverrides: { state: "working", execution_cycles: [], blocked_by: ["OPEN"] } });
    subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const before = canonicalSnapshot(fixture);
    expectControllerError(() => fixture.progress(), "TASK_CONTROL_TRANSITION_INVALID");
    assertCanonicalSnapshot(fixture, before);
  });

  await t.test("canonical root mismatch", (subtest) => {
    const fixture = createFixture({ taskOverrides: { canonical_state_root: path.resolve("different-root") } });
    subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const before = canonicalSnapshot(fixture);
    expectControllerError(() => fixture.progress(), "TASK_CONTROL_ROOT_MISMATCH");
    assertCanonicalSnapshot(fixture, before);
  });

  await t.test("existing cycle gap", (subtest) => {
    const fixture = createFixture({
      taskOverrides: {
        updated_at: REVIEWED_AT,
        execution_cycles: [
          { cycle: 1, status: "completed", started_at: CREATED_AT, completed_at: REVIEWED_AT },
          { cycle: 3, status: "in_progress", started_at: REVIEWED_AT },
        ],
      },
    });
    subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const before = canonicalSnapshot(fixture);
    const packet = fixture.writeProgressPacket({
      packet: {
        cycle: {
          cycle: 4,
          cycle_id: "implementation-4",
          started_at: REVIEWED_AT,
          completed_at: "2026-08-28T00:44:00.000Z",
        },
      },
    });
    expectControllerError(() => fixture.progress(packet), "TASK_CONTROL_CYCLE_SEQUENCE_INVALID");
    assertCanonicalSnapshot(fixture, before);
  });

  await t.test("invalid task creation timestamp", (subtest) => {
    const fixture = createFixture({ taskOverrides: { created_at: "not-a-timestamp" } });
    subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const before = canonicalSnapshot(fixture);
    expectControllerError(() => fixture.progress(), "TASK_CONTROL_STATE_UNSUPPORTED");
    assertCanonicalSnapshot(fixture, before);
  });

  await t.test("immutable packet object changed", (subtest) => {
    const fixture = createFixture();
    subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const first = fixture.writeProgressPacket();
    fixture.progress(first);
    const immutablePath = path.join(
      fixture.root,
      ".orquesta",
      "state",
      "task-progress-packets",
      `${first.packetSha256}.json`,
    );
    fs.writeFileSync(immutablePath, "{}\n", "utf8");
    const next = fixture.writeProgressPacket({
      name: "progress-after-corruption.json",
      evidenceRelative: `workbench/inbox/${TASK_ID}/progress-after-corruption-evidence.json`,
      packet: {
        recorded_at: "2026-08-28T00:55:00.000Z",
        cycle: {
          cycle: 2,
          cycle_id: "correction-2",
          kind: "implementation_correction",
          started_at: "2026-08-28T00:46:00.000Z",
          completed_at: "2026-08-28T00:54:00.000Z",
        },
      },
    });
    const before = canonicalSnapshot(fixture);
    expectControllerError(() => fixture.progress(next), "TASK_CONTROL_IMMUTABLE_PACKET_CONFLICT");
    assertCanonicalSnapshot(fixture, before);
    assert.equal(
      fs.existsSync(path.join(path.dirname(immutablePath), `${next.packetSha256}.json`)),
      false,
    );
  });
});

test("junction-backed canonical state is rejected before any external write", (t) => {
  const fixture = createFixture();
  const packet = fixture.writeProgressPacket();
  const outsideParent = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-task-controller-outside-"));
  const outside = path.join(outsideParent, "state-root");
  fs.renameSync(path.join(fixture.root, ".orquesta"), outside);
  try {
    fs.symlinkSync(outside, path.join(fixture.root, ".orquesta"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    fs.renameSync(outside, path.join(fixture.root, ".orquesta"));
    fs.rmSync(outsideParent, { recursive: true, force: true });
    fs.rmSync(fixture.root, { recursive: true, force: true });
    t.skip(`directory link unavailable: ${error.code || error.message}`);
    return;
  }
  t.after(() => {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(outsideParent, { recursive: true, force: true });
  });
  const before = fs.readFileSync(path.join(outside, "state", "tasks.json"));
  expectControllerError(() => fixture.progress(packet), "TASK_CONTROL_ROOT_UNSAFE");
  assert.deepEqual(fs.readFileSync(path.join(outside, "state", "tasks.json")), before);
  assert.equal(fs.existsSync(`${path.join(outside, "state", "tasks.json")}.lock`), false);
});

test("progress evidence must be task-bound, structured, durable JSON", async (t) => {
  for (const [name, options, expectedCode] of [
    ["prose", { evidenceRelative: `workbench/inbox/${TASK_ID}/proof.md` }, "TASK_CONTROL_EVIDENCE_NOT_STRUCTURED"],
    ["temporary target", { evidenceRelative: `workbench/inbox/${TASK_ID}/target/proof.json` }, "TASK_CONTROL_EVIDENCE_NOT_DURABLE"],
    ["invalid JSON body", { evidenceBytes: Buffer.from("not-json\n", "utf8") }, "TASK_CONTROL_EVIDENCE_NOT_STRUCTURED"],
  ]) {
    await t.test(name, (subtest) => {
      const fixture = createFixture();
      subtest.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
      const packet = fixture.writeProgressPacket(options);
      const before = canonicalSnapshot(fixture);
      expectControllerError(() => fixture.progress(packet), expectedCode);
      assertCanonicalSnapshot(fixture, before);
    });
  }
});

test("older progress replay repairs its event without regressing latest CURRENT", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const firstPacket = fixture.writeProgressPacket();
  fixture.progress(firstPacket);
  const secondPacket = fixture.writeProgressPacket({
    name: "progress-2.json",
    evidenceRelative: `workbench/inbox/${TASK_ID}/progress-evidence-2.json`,
    packet: {
      recorded_at: "2026-08-28T00:55:00.000Z",
      summary: "A later correction cycle is complete.",
      cycle: {
        cycle: 2,
        cycle_id: "correction-2",
        kind: "implementation_correction",
        status: "completed",
        started_at: "2026-08-28T00:46:00.000Z",
        completed_at: "2026-08-28T00:54:00.000Z",
      },
    },
  });
  fixture.progress(secondPacket);
  const beforeReplay = canonicalSnapshot(fixture);
  const replay = fixture.progress(firstPacket);
  assert.equal(replay.status, "already_recorded");
  assertCanonicalSnapshot(fixture, beforeReplay);
  assert.match(fs.readFileSync(fixture.currentPath, "utf8"), /A later correction cycle is complete/u);
});

test("progress refuses ambiguous legacy cycle identity instead of inventing a migration", (t) => {
  const fixture = createFixture({
    taskOverrides: {
      execution_cycles: [{ cycle_id: "legacy-cycle", status: "in_progress", evidence_refs: [] }],
    },
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const before = canonicalSnapshot(fixture);
  expectControllerError(() => fixture.progress(), "TASK_CONTROL_STATE_UNSUPPORTED");
  assertCanonicalSnapshot(fixture, before);
});

test("CLI exposes the progress packet route", () => {
  const parsed = parseArguments([
    "progress",
    "--state-root", path.resolve("fixture-root"),
    "--packet", `workbench/inbox/${TASK_ID}/progress.json`,
    "--packet-sha256", "a".repeat(64),
  ]);
  assert.equal(parsed.command, "progress");
  assert.equal(parsed.packetPath, `workbench/inbox/${TASK_ID}/progress.json`);
  expectControllerError(
    () => parseArguments(["progress", "--state-root", path.resolve("fixture-root")]),
    "TASK_CONTROL_USAGE",
  );
});

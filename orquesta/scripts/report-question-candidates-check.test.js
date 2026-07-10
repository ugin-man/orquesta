#!/usr/bin/env node

const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  appendSubmittedQuestionCandidates,
  inspectReportQuestionCandidatesFromText,
  validateQuestionCandidateInbox
} = require("./report-question-candidates-check");

function submittedBlock() {
  return `# Report

\`\`\`json
{
  "question_candidates": {
    "status": "submitted",
    "items": [
      {
        "priority": "medium",
        "category": "workflow",
        "question": "Should report review hard-block missing metadata or start with warnings?",
        "why_now": "The report gate is being added now.",
        "user_impact": "This changes how noisy report review becomes.",
        "suggested_timing": "before_next_task",
        "source_task_id": "T126",
        "source_agent_id": "implementation-001",
        "source_report_path": ".orquesta/reports/T126-implementation-question-candidate-support.md"
      }
    ]
  }
}
\`\`\`
`;
}

{
  const result = inspectReportQuestionCandidatesFromText(submittedBlock());
  assert.strictEqual(result.status, "submitted");
  assert.strictEqual(result.itemCount, 1);
  assert.deepStrictEqual(result.errors, []);
}

{
  const result = inspectReportQuestionCandidatesFromText(`# Report

\`\`\`json
{
  "question_candidates": {
    "status": "submitted",
    "items": [
      {
        "priority": "low",
        "category": "workflow",
        "question": "Should this low-priority workflow signal stay an internal observation?",
        "why_now": "The workflow does not yet require a user decision.",
        "user_impact": "It should not become direct user-question spam.",
        "suggested_timing": "batch_later",
        "source_task_id": "T160",
        "source_agent_id": "implementation-001",
        "source_report_path": ".orquesta/reports/T160.md",
        "observation": {
          "value_type": "maintenance_note",
          "user_emergence_value": "low",
          "decision_cluster_id": null,
          "suggested_action": "keep_as_note",
          "reason": "This is a low-risk operating observation."
        }
      }
    ]
  }
}
\`\`\`
`);
  assert.deepStrictEqual(result.errors, []);
}

{
  const result = inspectReportQuestionCandidatesFromText(`# Report

\`\`\`json
{
  "question_candidates": {
    "status": "submitted",
    "items": [
      {
        "priority": "low",
        "category": "workflow",
        "question": "Invalid observation test",
        "why_now": "The schema must reject unsupported emergence values.",
        "user_impact": "Invalid observations must not reach the curator inbox.",
        "suggested_timing": "batch_later",
        "source_task_id": "T160",
        "source_agent_id": "implementation-001",
        "source_report_path": ".orquesta/reports/T160.md",
        "observation": {
          "value_type": "maintenance_note",
          "user_emergence_value": "urgent",
          "decision_cluster_id": null,
          "suggested_action": "keep_as_note",
          "reason": "Invalid test value."
        }
      }
    ]
  }
}
\`\`\`
`);
  assert(result.errors.some((error) => error.includes("user_emergence_value")));
}

{
  const result = inspectReportQuestionCandidatesFromText(`# Report

\`\`\`json
{
  "question_candidates": {
    "status": "none",
    "none_reason": "purely_mechanical_change",
    "none_rationale": "The task only corrected a generated selector and introduced no new user choice."
  }
}
\`\`\`
`);
  assert.strictEqual(result.status, "none");
  assert.deepStrictEqual(result.errors, []);
}

{
  const result = inspectReportQuestionCandidatesFromText("# Report\n\nNo metadata here.\n");
  assert.strictEqual(result.status, "missing");
  assert(result.errors.some((error) => error.includes("missing question_candidates")));
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-question-candidates-"));
  try {
    const metadata = inspectReportQuestionCandidatesFromText(submittedBlock()).metadata;
    const first = appendSubmittedQuestionCandidates(root, metadata, "2026-06-25T00:00:00.000Z");
    const second = appendSubmittedQuestionCandidates(root, metadata, "2026-06-25T00:01:00.000Z");
    const inboxPath = path.join(root, ".orquesta", "vision", "question_candidates.json");
    const inbox = JSON.parse(fs.readFileSync(inboxPath, "utf8"));

    assert.strictEqual(first.recorded, 1);
    assert.strictEqual(second.recorded, 0);
    assert.strictEqual(second.skipped, 1);
    assert.strictEqual(inbox.candidates.length, 1);
    assert.strictEqual(inbox.candidates[0].status, "pending_curator_review");
    assert.deepStrictEqual(validateQuestionCandidateInbox(inbox).errors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-question-observation-"));
  try {
    const metadata = inspectReportQuestionCandidatesFromText(`# Report

\`\`\`json
{
  "question_candidates": {
    "status": "submitted",
    "items": [
      {
        "priority": "low",
        "category": "workflow",
        "question": "Keep this as an internal observation",
        "why_now": "Low-risk workflow detail.",
        "user_impact": "No direct user question is needed.",
        "suggested_timing": "batch_later",
        "source_task_id": "T160",
        "source_agent_id": "implementation-001",
        "source_report_path": ".orquesta/reports/T160.md",
        "observation": {
          "value_type": "maintenance_note",
          "user_emergence_value": "low",
          "decision_cluster_id": null,
          "suggested_action": "keep_as_note",
          "reason": "Low-risk operating detail."
        }
      }
    ]
  }
}
\`\`\`
`).metadata;
    const first = appendSubmittedQuestionCandidates(root, metadata, "2026-07-10T00:00:00.000Z");
    const second = appendSubmittedQuestionCandidates(root, metadata, "2026-07-10T00:01:00.000Z");
    const inboxPath = path.join(root, ".orquesta", "vision", "question_candidates.json");
    const inbox = JSON.parse(fs.readFileSync(inboxPath, "utf8"));
    assert.strictEqual(first.recorded, 1);
    assert.strictEqual(second.recorded, 0);
    assert.strictEqual(inbox.candidates[0].status, "observation");
    assert.deepStrictEqual(inbox.candidates[0].observation, metadata.items[0].observation);
    assert.strictEqual(fs.existsSync(path.join(root, ".orquesta", "vision", "questions.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function runConcurrentCandidateWriters(root, count) {
  const helperPath = path.resolve(__dirname, "report-question-candidates-check.js");
  const startPath = path.join(root, "candidate-writers.start");
  const workerSource = [
    'const fs = require("fs");',
    'const { appendSubmittedQuestionCandidates } = require(process.argv[1]);',
    'const root = process.argv[2];',
    'const id = Number(process.argv[3]);',
    'const startPath = process.argv[4];',
    'process.stdout.write("ready\\n");',
    'while (!fs.existsSync(startPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);',
    'appendSubmittedQuestionCandidates(root, { status: "submitted", items: [{',
    'priority: "medium", category: "workflow", question: `Concurrent candidate ${id}`,',
    'why_now: "Concurrency verification", user_impact: "Prevents lost candidate observations",',
    'suggested_timing: "before_next_task", source_task_id: "T-QC-RACE",',
    'source_agent_id: `agent-${id}`, source_report_path: `.orquesta/reports/race-${id}.md`',
    '}] }, new Date(1783638000000 + id).toISOString());'
  ].join(" ");

  const workers = Array.from({ length: count }, (_, id) => {
    const child = spawn(process.execPath, ["-e", workerSource, helperPath, root, String(id), startPath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let readyResolve;
    const ready = new Promise((resolve) => { readyResolve = resolve; });
    const exited = new Promise((resolve) => {
      child.on("exit", (code, signal) => {
        readyResolve();
        resolve({ id, code, signal, stdout, stderr });
      });
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("ready")) readyResolve();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      stderr += error.stack || error.message;
      readyResolve();
    });
    return { ready, exited };
  });

  await Promise.all(workers.map((worker) => worker.ready));
  fs.writeFileSync(startPath, "go\n", "utf8");
  const results = await Promise.all(workers.map((worker) => worker.exited));
  fs.rmSync(startPath, { force: true });
  return results;
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-question-candidate-race-"));
  try {
    const requested = 30;
    const workers = await runConcurrentCandidateWriters(root, requested);
    const failures = workers.filter((worker) => worker.code !== 0);
    assert.deepStrictEqual(failures, [], failures.map((worker) => worker.stderr).join("\n"));

    const inboxPath = path.join(root, ".orquesta", "vision", "question_candidates.json");
    const inbox = JSON.parse(fs.readFileSync(inboxPath, "utf8"));
    assert.strictEqual(inbox.candidates.length, requested);
    assert.strictEqual(new Set(inbox.candidates.map((candidate) => candidate.candidate_id)).size, requested);
    assert.strictEqual(new Set(inbox.candidates.map((candidate) => candidate.question)).size, requested);
    assert.deepStrictEqual(validateQuestionCandidateInbox(inbox).errors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("report question candidate tests passed");
})().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});

#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  extractCompletionEnvelope,
  inspectCompletionEnvelope,
  validateCompletionEnvelope
} = require("./completion-envelope-check");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-completion-envelope-"));
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function issueCodes(issues) {
  return issues.map((issue) => issue.code);
}

function makeTask(overrides = {}) {
  return {
    task_id: "T200",
    owner_agent_id: "implementation-001",
    state: "completed",
    routing_class: "specialist_required",
    routing_gate_status: "handoff_sent",
    handoff_required: true,
    handoff_sent_at: "2026-07-10T06:00:00.000Z",
    specialist_report_required: true,
    specialist_report_path: ".orquesta/reports/T200.md",
    direct_exception_reason: null,
    bypass_review_owner: null,
    control_signals: {
      risk_level: "high"
    },
    model_route: {
      recommended_model: "Sol",
      requested_model: "gpt-5.6-sol",
      actual_model: null
    },
    ...overrides
  };
}

function makeEnvelope(overrides = {}) {
  const base = {
    version: 1,
    task_id: "T200",
    agent_id: "implementation-001",
    status: "submitted",
    risk_level: "high",
    required_reading: {
      status: "done",
      files: ["docs/spec.md"],
      not_read: []
    },
    delegation_evidence: {
      routing_class: "specialist_required",
      handoff_sent_at: "2026-07-10T06:00:00.000Z",
      specialist_report_path: ".orquesta/reports/T200.md",
      direct_exception_reason: null,
      bypass_review_owner: null
    },
    model_route: {
      recommended_model: "Sol",
      requested_model: "gpt-5.6-sol",
      requested_model_evidence: "The handoff requested this route.",
      actual_model: null,
      actual_model_evidence: null,
      confidence: "medium",
      reason: "The runtime did not expose the actual variant.",
      adapter: "codex_product"
    },
    changes: [
      {
        path: "orquesta/scripts/example.js",
        kind: "modified",
        summary: "Implemented the assigned behavior."
      }
    ],
    verification: {
      commands: [
        {
          command: "npm run check",
          status: "passed",
          expected: "checks pass",
          evidence: "exit 0"
        }
      ],
      browser: {
        status: "not_required",
        evidence: null
      },
      live_thread: {
        status: "not_required",
        evidence: null
      }
    },
    not_verified: [],
    fallbacks: [],
    open_risks: [],
    question_candidates_status: "none",
    created_at: "2026-07-10T06:05:00.000Z"
  };

  return {
    ...base,
    ...overrides,
    required_reading: {
      ...base.required_reading,
      ...(overrides.required_reading || {})
    },
    delegation_evidence: {
      ...base.delegation_evidence,
      ...(overrides.delegation_evidence || {})
    },
    model_route: {
      ...base.model_route,
      ...(overrides.model_route || {})
    },
    verification: {
      ...base.verification,
      ...(overrides.verification || {})
    }
  };
}

function writeReport(name, envelope) {
  const filePath = path.join(root, name);
  const block = envelope === null
    ? "No completion metadata is present."
    : `\`\`\`json\n${JSON.stringify({ completion_envelope: envelope }, null, 2)}\n\`\`\``;
  fs.writeFileSync(filePath, `# Fixture\n\n${block}\n`, "utf8");
  return filePath;
}

test("extracts a completion_envelope JSON block", () => {
  const envelope = makeEnvelope();
  const text = `prefix\n\`\`\`json\n${JSON.stringify({ completion_envelope: envelope })}\n\`\`\`\n`;
  assert.deepStrictEqual(extractCompletionEnvelope(text), envelope);
});

test("valid staged-in completion envelope passes", () => {
  const task = makeTask();
  const reportPath = writeReport("valid.md", makeEnvelope());
  const result = inspectCompletionEnvelope(reportPath, task);
  assert.strictEqual(result.present, true);
  assert.strictEqual(result.status, "valid");
  assert.deepStrictEqual(result.errors, []);
});

test("missing envelope blocks staged-in specialist work", () => {
  const result = inspectCompletionEnvelope(writeReport("missing.md", null), makeTask());
  assert.strictEqual(result.present, false);
  assert.strictEqual(result.status, "invalid");
  assert.ok(issueCodes(result.errors).includes("missing_completion_envelope"));
});

test("delegation evidence must match task state", () => {
  const result = validateCompletionEnvelope(makeEnvelope({
    agent_id: "other-agent",
    delegation_evidence: {
      handoff_sent_at: "2026-07-10T05:00:00.000Z",
      specialist_report_path: ".orquesta/reports/other.md"
    }
  }), makeTask());
  const codes = issueCodes(result.errors);
  assert.ok(codes.includes("agent_id_mismatch"));
  assert.ok(codes.includes("handoff_sent_at_mismatch"));
  assert.ok(codes.includes("specialist_report_path_mismatch"));
});

test("report-only work may omit commands only with an explicit reason", () => {
  const task = makeTask({
    control_signals: { risk_level: "low" }
  });
  const withoutReason = validateCompletionEnvelope(makeEnvelope({
    changes: [{ path: ".orquesta/reports/T200.md", kind: "report_only", summary: "Report only." }],
    verification: { commands: [] }
  }), task);
  assert.ok(issueCodes(withoutReason.errors).includes("empty_verification_commands"));

  const withReason = validateCompletionEnvelope(makeEnvelope({
    changes: [{ path: ".orquesta/reports/T200.md", kind: "report_only", summary: "Report only." }],
    verification: {
      commands: [],
      no_commands_reason: "The task produced only a review report and changed no executable files."
    }
  }), task);
  assert.deepStrictEqual(withReason.errors, []);
});

test("requested and actual model evidence remain separate", () => {
  const valid = validateCompletionEnvelope(makeEnvelope(), makeTask());
  assert.deepStrictEqual(valid.errors, []);

  const unprovenActual = validateCompletionEnvelope(makeEnvelope({
    model_route: {
      actual_model: "gpt-5.6-sol",
      actual_model_evidence: null
    }
  }), makeTask());
  assert.ok(issueCodes(unprovenActual.errors).includes("actual_model_evidence_missing"));

  const wrongRequested = validateCompletionEnvelope(makeEnvelope({
    model_route: {
      requested_model: "gpt-5.6-terra"
    }
  }), makeTask());
  assert.ok(issueCodes(wrongRequested.errors).includes("requested_model_mismatch"));
});

test("evidence-weakening fallback requires approval", () => {
  const fallback = {
    fallback_id: "FB-T200-001",
    category: "acceptance_evidence",
    quality_impact: "weakens_evidence",
    requires_user_approval: true,
    approval_status: "requested",
    reason: "Independent browser proof was unavailable."
  };
  const blocked = validateCompletionEnvelope(makeEnvelope({ fallbacks: [fallback] }), makeTask());
  assert.ok(issueCodes(blocked.errors).includes("fallback_user_approval_missing"));

  const approved = validateCompletionEnvelope(makeEnvelope({
    fallbacks: [{ ...fallback, approval_status: "approved" }]
  }), makeTask());
  assert.deepStrictEqual(approved.errors, []);
});

test("invalid timestamps and question candidate status are rejected", () => {
  const result = validateCompletionEnvelope(makeEnvelope({
    created_at: "not-a-time",
    question_candidates_status: "unknown"
  }), makeTask());
  const codes = issueCodes(result.errors);
  assert.ok(codes.includes("invalid_timestamp"));
  assert.ok(codes.includes("invalid_question_candidates_status"));
});

test("legacy accepted task without envelope remains a warning", () => {
  const legacyTask = makeTask({
    task_id: "T100",
    state: "accepted",
    control_signals: undefined,
    completion_envelope: undefined,
    created_at: "2026-06-01T00:00:00.000Z"
  });
  const result = inspectCompletionEnvelope(writeReport("legacy.md", null), legacyTask, {
    rolloutMode: "progressive"
  });
  assert.strictEqual(result.status, "legacy_warning");
  assert.deepStrictEqual(result.errors, []);
  assert.ok(issueCodes(result.warnings).includes("legacy_completion_envelope_missing"));
});

let failed = 0;
try {
  for (const { name, fn } of tests) {
    try {
      fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${name}`);
      console.error(error.stack || error.message || error);
    }
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (failed) {
  throw new Error(`completion-envelope test failed: ${failed} failure(s)`);
}

console.log("completion-envelope tests passed");

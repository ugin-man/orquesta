#!/usr/bin/env node

const assert = require("assert");
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

console.log("report question candidate tests passed");

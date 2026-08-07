import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { benchmarkRoot } from "../scripts/lib/paths.mjs";
import {
  createTaskWorkspace,
  stageRemoteTask,
  taskInstruction,
  verifyTask
} from "../scripts/lib/tasks.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

test("pins raw GitHub bytes rather than a Windows checkout conversion", async () => {
  const source = JSON.parse(await fs.readFile(path.join(benchmarkRoot, "tasks", "organization-json-generator", "source.json"), "utf8"));
  assert.deepEqual(Object.fromEntries(source.files.map((file) => [file.path, file.sha256])), {
    "departments.csv": "3510c090be52aca39c07bfe6ad26aabe4bd978a1d3d97c885c7a92b7cd499793",
    "employees.csv": "c7b25ed63b4e8713ed5009f2e8dc53e953e4f99aad895e42b37e476335990d48",
    "projects.csv": "014a754a9c4eccc5ab52973ffcb94483d2a38afea84ec851cfe1893f45689334",
    "schema.json": "7fbdfb390166f75bf96982562443aecb6cce5e176dc881b35911275ec8b5bfc8",
    "task.yaml": "10023ad450b88bc12ce3ba3ebb769efc70d6fed5b257356183f77f3de3cacaf1",
    "tests/test_outputs.py": "536413272874ddb8fe2d59b16d73c9acd00a7dd6ae12d8123ee38a239d67afd1"
  });
});

test("uses one fixed organization instruction for every benchmark mode", async () => {
  const instructions = await Promise.all(
    ["plain", "skills", "orquesta"].map(() => taskInstruction({
      benchmarkRoot,
      taskId: "organization-json-generator"
    }))
  );
  assert.equal(new Set(instructions).size, 1);
  assert.match(instructions[0], /Pilot Organization/);
  assert.match(instructions[0], /2020-01-01/);
  assert.doesNotMatch(instructions[0], /Benchmark condition/i);
});

test("stages only agent inputs while verifying hidden source evidence", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-public-task-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = new Map([
    ["https://example.test/input.txt", "agent input\n"],
    ["https://example.test/verifier.py", "hidden verifier\n"]
  ]);
  const definition = {
    files: [
      { path: "input.txt", role: "input", url: "https://example.test/input.txt", sha256: hash(files.get("https://example.test/input.txt")) },
      { path: "tests/verifier.py", role: "evidence", url: "https://example.test/verifier.py", sha256: hash(files.get("https://example.test/verifier.py")) }
    ]
  };
  const fetchImpl = async (url) => ({ ok: true, arrayBuffer: async () => Buffer.from(files.get(url)) });

  const result = await stageRemoteTask({ definition, destination: root, fetchImpl });
  assert.equal(result.verified_files, 2);
  assert.equal(await fs.readFile(path.join(root, "input.txt"), "utf8"), "agent input\n");
  await assert.rejects(fs.access(path.join(root, "tests", "verifier.py")));

  const bad = structuredClone(definition);
  bad.files[0].sha256 = "0".repeat(64);
  await assert.rejects(stageRemoteTask({ definition: bad, destination: path.join(root, "bad"), fetchImpl }), /sha-256/i);
});

test("copies only task base files into a clean agent workspace", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-task-workspace-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "workspace");
  await createTaskWorkspace({ benchmarkRoot, taskId: "parallel-integration", destination });
  assert.equal((await fs.stat(path.join(destination, "src", "normalize.ts"))).isFile(), true);
  await assert.rejects(fs.access(path.join(destination, "verifier")));
  await assert.rejects(fs.access(path.join(destination, "..", "verifier.mjs")));
});

test("parallel task fails before fixes and passes the same hidden verifier after fixes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-parallel-task-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "workspace");
  await createTaskWorkspace({ benchmarkRoot, taskId: "parallel-integration", destination });
  const before = await verifyTask({ benchmarkRoot, taskId: "parallel-integration", workspaceRoot: destination, timeoutMs: 10_000 });
  assert.equal(before.status, "failed", before.output);

  await fs.writeFile(path.join(destination, "src", "normalize.ts"), `export type RawWorkItem = { id: string; title: string; team: string; hours: string | number };
export type WorkItem = { id: string; title: string; team: string; hours: number };
export function normalizeItem(raw: RawWorkItem): WorkItem {
  return { id: raw.id.trim().toUpperCase(), title: raw.title.trim(), team: raw.team.trim().toLowerCase(), hours: Number(raw.hours) };
}
`, "utf8");
  await fs.writeFile(path.join(destination, "src", "summarize.ts"), `import type { WorkItem } from "./normalize.ts";
export type TeamSummary = { team: string; itemCount: number; totalHours: number };
export function summarizeTeams(items: WorkItem[]): TeamSummary[] {
  const totals = new Map<string, TeamSummary>();
  for (const item of items) {
    const current = totals.get(item.team) || { team: item.team, itemCount: 0, totalHours: 0 };
    current.itemCount += 1;
    current.totalHours += item.hours;
    totals.set(item.team, current);
  }
  return [...totals.values()];
}
`, "utf8");
  await fs.writeFile(path.join(destination, "src", "render.ts"), `import type { TeamSummary } from "./summarize.ts";
import type { WorkItem } from "./normalize.ts";
export function renderReport(items: WorkItem[], teams: TeamSummary[]): string {
  const orderedTeams = [...teams].sort((a, b) => a.team.localeCompare(b.team));
  return JSON.stringify({ items, teams: orderedTeams }, null, 2) + "\\n";
}
`, "utf8");

  const after = await verifyTask({ benchmarkRoot, taskId: "parallel-integration", workspaceRoot: destination, timeoutMs: 10_000 });
  assert.equal(after.status, "passed", after.output);
  assert.equal(after.passed, true);
});

test("conflicting requirements task fails without a decision and passes a safe triage record", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-triage-task-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "workspace");
  await createTaskWorkspace({
    benchmarkRoot,
    taskId: "conflicting-requirements-triage",
    destination
  });
  const before = await verifyTask({
    benchmarkRoot,
    taskId: "conflicting-requirements-triage",
    workspaceRoot: destination,
    timeoutMs: 10_000
  });
  assert.equal(before.status, "failed");

  await fs.writeFile(path.join(destination, "decision.json"), `${JSON.stringify({
    status: "needs_user_input",
    implementation_allowed: false,
    safe_default: "local_only_no_upload",
    conflicts: [
      {
        id: "first-run-upload-consent",
        documents: ["requirements/product.md", "requirements/security.md"],
        summary: "Product requires automatic upload while security requires project opt-in."
      },
      {
        id: "remote-retention-policy",
        documents: ["requirements/product.md", "requirements/security.md"],
        summary: "Product fixes retention at 30 days before the owner selects an allowed policy."
      }
    ],
    questions: [
      "May audit upload occur before explicit project opt-in?",
      "Which remote retention policy and period has the owner approved?"
    ]
  }, null, 2)}\n`, "utf8");
  const after = await verifyTask({
    benchmarkRoot,
    taskId: "conflicting-requirements-triage",
    workspaceRoot: destination,
    timeoutMs: 10_000
  });
  assert.equal(after.status, "passed", after.output);
});

test("diverse review tasks reject missing output and accept evidence-bound reports", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orquesta-diverse-review-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixtures = {
    "worldbuilding-consistency-review": {
      file: "worldbuilding-consistency.json",
      report: {
        issues: [
          {
            category: "timeline",
            severity: "high",
            summary: "The 22:00 curfew conflicts with Aria working and using the gate at 23:00.",
            source_refs: ["lore/world.md", "characters/aria.md", "scenes/chapter-4.md"]
          },
          {
            category: "signal",
            severity: "high",
            summary: "The lighthouse is defined as amber but appears blue in Aria's account.",
            source_refs: ["lore/world.md", "characters/aria.md", "scenes/chapter-4.md"]
          }
        ]
      }
    },
    "ui-visual-review": {
      file: "ui-review.json",
      report: {
        issues: [
          {
            category: "text_size",
            severity: "high",
            summary: "Primary status is 10px instead of the required 14px.",
            source_refs: ["requirements/ui.md", "ui/styles.css"]
          },
          {
            category: "keyboard_focus",
            severity: "high",
            summary: "The button removes its focus outline.",
            source_refs: ["requirements/ui.md", "ui/styles.css"]
          },
          {
            category: "viewport_overflow",
            severity: "high",
            summary: "A 130vh body forces page-level vertical scrolling.",
            source_refs: ["requirements/ui.md", "ui/styles.css"]
          }
        ]
      }
    },
    "external-comparison-review": {
      file: "external-comparison.json",
      report: {
        strengths: [{
          summary: "Local execution and user-installed plugin support are differentiators.",
          source_refs: ["product/current.md", "evidence/competitor-a.md", "evidence/competitor-b.md"]
        }],
        gaps: [
          {
            summary: "The product has no offline report export.",
            source_refs: ["product/current.md", "evidence/competitor-a.md"]
          },
          {
            summary: "The product has no durable audit trail.",
            source_refs: ["product/current.md", "evidence/competitor-b.md"]
          }
        ],
        recommendations: [
          {
            summary: "Add offline export while preserving local execution.",
            source_refs: ["product/current.md", "evidence/competitor-a.md"]
          },
          {
            summary: "Add a searchable audit trail without weakening plugin support.",
            source_refs: ["product/current.md", "evidence/competitor-b.md"]
          }
        ],
        citations: ["evidence/competitor-a.md", "evidence/competitor-b.md"]
      }
    }
  };

  for (const [taskId, fixture] of Object.entries(fixtures)) {
    const destination = path.join(root, taskId);
    await createTaskWorkspace({ benchmarkRoot, taskId, destination });
    const before = await verifyTask({
      benchmarkRoot,
      taskId,
      workspaceRoot: destination,
      timeoutMs: 10_000
    });
    assert.equal(before.status, "failed", taskId);
    await fs.mkdir(path.join(destination, "reports"), { recursive: true });
    await fs.writeFile(
      path.join(destination, "reports", fixture.file),
      `${JSON.stringify(fixture.report, null, 2)}\n`,
      "utf8"
    );
    const after = await verifyTask({
      benchmarkRoot,
      taskId,
      workspaceRoot: destination,
      timeoutMs: 10_000
    });
    assert.equal(after.status, "passed", `${taskId}: ${after.output}`);
  }
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { verifyTask } from "./lib/tasks.mjs";
import { benchmarkRoot } from "./lib/paths.mjs";
import {
  compareMatrix,
  renderMarkdownReport
} from "./lib/report.mjs";
import { runPreflightMatrix } from "./preflight.mjs";
import { executeMatrixPlan } from "./run-matrix.mjs";

const fixtureRoot = path.join(benchmarkRoot, "test", "fixtures", "results");

async function readFixture(name) {
  return JSON.parse(await fs.readFile(path.join(fixtureRoot, name), "utf8"));
}

function validOrganization() {
  const departments = ["Design", "Engineering", "Operations"].map(
    (name, index) => ({
      id: `D${index + 1}`,
      name,
      budget: 100_000 + index * 10_000,
      employees: [
        { id: `E${index + 1}A`, name: `${name} A` },
        { id: `E${index + 1}B`, name: `${name} B` }
      ],
      projects: []
    })
  );
  return {
    organization: {
      name: "Pilot Organization",
      founded: "2020-01-01",
      departments
    },
    statistics: {
      totalEmployees: 6,
      averageDepartmentBudget: 110_000,
      departmentSizes: Object.fromEntries(
        departments.map((department) => [department.name, 2])
      ),
      projectStatusDistribution: {}
    }
  };
}

async function main() {
  const outputRoot = path.join(benchmarkRoot, ".cache", "dry-run");
  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(outputRoot, { recursive: true });

  const results = await Promise.all([
    readFixture("plain-pass-v2.json"),
    readFixture("skills-pass-v2.json"),
    readFixture("orquesta-pass-v2.json")
  ]);
  const report = renderMarkdownReport([compareMatrix(results)]);
  const reportPath = path.join(outputRoot, "report.md");
  await fs.writeFile(reportPath, report, "utf8");

  const verifierWorkspace = await fs.mkdtemp(
    path.join(os.tmpdir(), "orquesta-benchmark-verifier-")
  );
  let verifier;
  try {
    await fs.writeFile(
      path.join(verifierWorkspace, "organization.json"),
      `${JSON.stringify(validOrganization(), null, 2)}\n`,
      "utf8"
    );
    verifier = await verifyTask({
      benchmarkRoot,
      taskId: "organization-json-generator",
      workspaceRoot: verifierWorkspace,
      timeoutMs: 10_000
    });
  } finally {
    await fs.rm(verifierWorkspace, { recursive: true, force: true });
  }
  if (!verifier.passed) {
    throw new Error(`dry-run verifier failed: ${verifier.output}`);
  }

  const execution = {
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    sandbox: "workspace-write",
    approval_policy: "never"
  };
  const preflight = await runPreflightMatrix({
    execution,
    async probe({ mode }) {
      return {
        mode,
        valid: true,
        observed: execution,
        process_id: `fake-process-${mode}`,
        write_probe: "passed"
      };
    }
  });
  const matrixStorage = path.join(outputRoot, "matrix");
  const matrix = await executeMatrixPlan({
    matrixId: "dry-run-matrix",
    storageRoot: matrixStorage,
    preflight,
    async runMode({ mode, runId }) {
      const runDir = path.join(matrixStorage, "runs", runId);
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(
        path.join(runDir, "result.json"),
        `${JSON.stringify({ mode, run_id: runId, fake: true })}\n`,
        "utf8"
      );
      return { mode, run_id: runId, status: "finalized" };
    }
  });

  process.stdout.write(`${JSON.stringify({
    status: "passed",
    codex_started: false,
    verifier: verifier.status,
    preflight_conditions: preflight.conditions.length,
    matrix_runs: matrix.results.length,
    fake_report: reportPath
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`Benchmark dry-run failed: ${error.message}\n`);
  process.exitCode = 1;
});

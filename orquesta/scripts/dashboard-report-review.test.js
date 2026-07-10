#!/usr/bin/env node

const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { updateJsonAtomic, writeJsonAtomic } = require("./json-state");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-report-review-race-"));
const stateRoot = path.join(root, ".orquesta", "state");
const reportsRoot = path.join(root, ".orquesta", "reports");
const readyRoot = path.join(root, "ready");
const exitRoot = path.join(root, "exits");
const startPath = path.join(root, "commit.start");
const serverPath = path.resolve(__dirname, "..", "dashboard-server.js");

function reportText() {
  return `# Review fixture

\`\`\`json
{
  "question_candidates": {
    "status": "none",
    "none_reason": "purely_mechanical_change",
    "none_rationale": "The fixture introduces no user choice."
  }
}
\`\`\`
`;
}

function waitForReady(expected, timeoutMs = 10000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      const count = fs.existsSync(readyRoot) ? fs.readdirSync(readyRoot).length : 0;
      if (count >= expected) return resolve();
      if (Date.now() - startedAt >= timeoutMs) {
        const exits = fs.existsSync(exitRoot)
          ? fs.readdirSync(exitRoot).map((name) => fs.readFileSync(path.join(exitRoot, name), "utf8")).join("\n")
          : "no worker exit evidence";
        return reject(new Error(`Timed out waiting for ${expected} report reviewers; saw ${count}\n${exits}`));
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function spawnReviewer(taskId, note) {
  const workerSource = String.raw`
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const serverPath = process.argv[1];
const testRoot = process.argv[2];
const taskId = process.argv[3];
const note = process.argv[4];
let source = fs.readFileSync(serverPath, "utf8");
source = source.replace('const root = path.resolve(__dirname, "..");', 'const root = ' + JSON.stringify(testRoot) + ';');
source = source.replace(/\nstartDashboardServer\(\)\.catch\(\(error\) => \{[\s\S]*?\n\}\);\s*$/, "\n");
const barrier = [
  '  fs.mkdirSync(process.env.REVIEW_READY_ROOT, { recursive: true });',
  '  fs.writeFileSync(path.join(process.env.REVIEW_READY_ROOT, process.pid + ".ready"), "ready\\n", "utf8");',
  '  while (!fs.existsSync(process.env.REVIEW_START_PATH)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);'
].join("\n");
source = source.replace('function reviewSpecialistReport(payload) {', 'function reviewSpecialistReport(payload) {\n' + barrier);
source += '\nmodule.exports.__test_reviewSpecialistReport = reviewSpecialistReport;\n';
const localRequire = createRequire(serverPath);
const loaded = { exports: {} };
new Function("require", "module", "exports", "__dirname", "__filename", source)(
  localRequire,
  loaded,
  loaded.exports,
  path.dirname(serverPath),
  serverPath
);
loaded.exports.__test_reviewSpecialistReport({ task_id: taskId, decision: "accept", note });
`;

  const child = spawn(process.execPath, ["-e", workerSource, serverPath, root, taskId, note], {
    env: {
      ...process.env,
      REVIEW_READY_ROOT: readyRoot,
      REVIEW_START_PATH: startPath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      fs.mkdirSync(exitRoot, { recursive: true });
      fs.writeFileSync(path.join(exitRoot, `${taskId}.json`), JSON.stringify({ taskId, code, signal, stdout, stderr }), "utf8");
      resolve({ taskId, code, signal, stdout, stderr });
    });
  });
}

(async () => {
  const reviewerCount = 12;
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(reportsRoot, { recursive: true });
  fs.mkdirSync(readyRoot, { recursive: true });
  fs.mkdirSync(exitRoot, { recursive: true });

  const tasks = Array.from({ length: reviewerCount }, (_, index) => ({
    task_id: `T-RACE-${index}`,
    owner_agent_id: `agent-${index}`,
    state: "completed",
    specialist_report_path: `.orquesta/reports/T-RACE-${index}.md`,
    artifacts: [`.orquesta/reports/T-RACE-${index}.md`],
    review_history: []
  }));
  const agents = Array.from({ length: reviewerCount }, (_, index) => ({
    agent_id: `agent-${index}`,
    status: "active",
    current_task: `T-RACE-${index}`,
    artifacts: []
  }));
  tasks.forEach((task) => fs.writeFileSync(path.join(root, task.specialist_report_path), reportText(), "utf8"));
  writeJsonAtomic(path.join(stateRoot, "tasks.json"), { version: 1, tasks, preserved: [] });
  writeJsonAtomic(path.join(stateRoot, "agents.json"), { version: 1, agents, preserved: [] });

  const reviewers = tasks.map((task, index) => spawnReviewer(task.task_id, `review-${index}`));
  await waitForReady(reviewerCount);

  updateJsonAtomic(path.join(stateRoot, "tasks.json"), { version: 1, tasks: [] }, (state) => ({
    ...state,
    preserved: [...(state.preserved || []), "unrelated-task-update"]
  }));
  updateJsonAtomic(path.join(stateRoot, "agents.json"), { version: 1, agents: [] }, (state) => ({
    ...state,
    preserved: [...(state.preserved || []), "unrelated-agent-update"]
  }));
  fs.writeFileSync(startPath, "go\n", "utf8");

  const results = await Promise.all(reviewers);
  const failures = results.filter((result) => result.code !== 0);
  assert.deepStrictEqual(failures, [], failures.map((result) => result.stderr).join("\n"));

  const finalTasks = JSON.parse(fs.readFileSync(path.join(stateRoot, "tasks.json"), "utf8"));
  const finalAgents = JSON.parse(fs.readFileSync(path.join(stateRoot, "agents.json"), "utf8"));
  assert.deepStrictEqual(finalTasks.preserved, ["unrelated-task-update"]);
  assert.deepStrictEqual(finalAgents.preserved, ["unrelated-agent-update"]);
  assert.strictEqual(finalTasks.tasks.filter((task) => task.state === "accepted").length, reviewerCount);
  assert.strictEqual(finalTasks.tasks.filter((task) => task.review_history?.length === 1).length, reviewerCount);
  assert.strictEqual(finalAgents.agents.filter((agent) => agent.status === "standby").length, reviewerCount);
  assert.strictEqual(finalAgents.agents.filter((agent) => agent.current_task === null).length, reviewerCount);

  console.log("dashboard report review concurrency tests passed");
})().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

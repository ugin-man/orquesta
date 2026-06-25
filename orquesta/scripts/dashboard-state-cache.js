const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DASHBOARD_STATE_TARGETS = [
  [".orquesta", "state", "agents.json"],
  [".orquesta", "state", "sessions.json"],
  [".orquesta", "state", "tasks.json"],
  [".orquesta", "state", "trigger_audit.json"],
  [".orquesta", "state", "directives.json"],
  [".orquesta", "state", "events.jsonl"],
  [".orquesta", "vision", "question_candidates.json"],
  [".orquesta", "vision", "questions.json"],
  [".orquesta", "vision", "answers.json"],
  [".orquesta", "failures", "incidents.json"],
  [".orquesta", "failures", "user_actions.json"],
  [".orquesta", "user_tasks", "queue.json"],
  [".orquesta", "setup", "options.json"],
  [".orquesta", "setup", "wizard.json"],
  [".orquesta", "setup", "project_intake.json"],
  [".orquesta", "setup", "specialist_plan.json"],
  [".orquesta", "setup", "production_start.json"],
  [".orquesta", "project", "completion_map.json"],
  [".orquesta", "CURRENT_ORCHESTRA.md"]
];

function normalizeEntry(filePath) {
  return filePath.replace(/\\/g, "/");
}

function collectMarkdownFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(dirPath, entry.name));
}

function collectDashboardStateEntries(root) {
  const files = DASHBOARD_STATE_TARGETS
    .map((parts) => path.join(root, ...parts))
    .filter((filePath) => fs.existsSync(filePath));

  files.push(...collectMarkdownFiles(path.join(root, ".orquesta", "reports")));
  return files.map(normalizeEntry).sort();
}

function statSignature(root, filePath) {
  const absolute = path.resolve(filePath);
  const relative = path.relative(root, absolute).replace(/\\/g, "/");
  const stat = fs.statSync(absolute);
  return `${relative}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
}

function buildDashboardStateEtag(root) {
  const entries = collectDashboardStateEntries(root);
  const signature = entries.map((entry) => statSignature(root, entry)).join("|");
  const hash = crypto.createHash("sha1").update(signature).digest("hex");
  return `"orquesta-${hash}"`;
}

module.exports = {
  DASHBOARD_STATE_TARGETS,
  buildDashboardStateEtag,
  collectDashboardStateEntries
};

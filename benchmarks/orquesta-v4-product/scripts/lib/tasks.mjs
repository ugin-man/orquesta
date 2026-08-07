import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function taskDefinition({ benchmarkRoot, taskId }) {
  const taskRoot = path.join(benchmarkRoot, "tasks", taskId);
  const sourcePath = path.join(taskRoot, "source.json");
  const taskPath = path.join(taskRoot, "task.json");
  const source = await fs.stat(sourcePath).then(() => true, () => false);
  if (source) {
    return {
      kind: "remote",
      root: taskRoot,
      definition: await readJson(sourcePath)
    };
  }
  const local = await fs.stat(taskPath).then(() => true, () => false);
  if (local) {
    return {
      kind: "local",
      root: taskRoot,
      definition: await readJson(taskPath)
    };
  }
  throw new Error(`unknown task: ${taskId}`);
}

export async function stageRemoteTask({ definition, destination, fetchImpl = fetch }) {
  const inputs = [];
  for (const file of definition.files || []) {
    const response = await fetchImpl(file.url);
    if (!response?.ok) throw new Error(`source fetch failed for ${file.path}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = sha256(bytes);
    if (actual !== file.sha256) throw new Error(`SHA-256 mismatch for ${file.path}: expected ${file.sha256}, got ${actual}`);
    if (file.role === "input") inputs.push({ file, bytes });
  }
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  for (const { file, bytes } of inputs) {
    const target = path.join(destination, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
  return { verified_files: definition.files.length, staged_inputs: inputs.length, destination };
}

export async function prepareTasks({ benchmarkRoot, fetchImpl = fetch }) {
  const tasksRoot = path.join(benchmarkRoot, "tasks");
  const entries = (await fs.readdir(tasksRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const prepared = [];
  for (const entry of entries) {
    const taskId = entry.name;
    const task = await taskDefinition({ benchmarkRoot, taskId });
    if (task.kind === "remote") {
      const destination = path.join(benchmarkRoot, ".cache", "tasks", taskId, "base");
      const result = await stageRemoteTask({
        definition: task.definition,
        destination,
        fetchImpl
      });
      prepared.push({
        task_id: taskId,
        source_commit: task.definition.source_commit,
        ...result
      });
      continue;
    }
    const destination = path.join(task.root, "base");
    const stat = await fs.stat(destination).catch(() => null);
    if (!stat?.isDirectory()) throw new Error(`${taskId} base is unavailable`);
    prepared.push({ task_id: taskId, source_commit: null, destination });
  }
  return prepared;
}

export async function createTaskWorkspace({ benchmarkRoot, taskId, destination }) {
  const task = await taskDefinition({ benchmarkRoot, taskId });
  const source = task.kind === "remote"
    ? path.join(benchmarkRoot, ".cache", "tasks", taskId, "base")
    : path.join(task.root, "base");
  const stat = await fs.stat(source).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`task ${taskId} is not prepared`);
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
  return { task_id: taskId, workspace_root: destination };
}

export async function taskInstruction({ benchmarkRoot, taskId }) {
  const task = await taskDefinition({ benchmarkRoot, taskId });
  if (typeof task.definition.instruction !== "string" || !task.definition.instruction.trim()) {
    throw new Error(`task ${taskId} has no instruction`);
  }
  return task.definition.instruction;
}

export async function verifyTask({ benchmarkRoot, taskId, workspaceRoot, timeoutMs }) {
  await taskDefinition({ benchmarkRoot, taskId });
  const verifierPath = path.join(benchmarkRoot, "tasks", taskId, "verifier.mjs");
  const verifier = await import(`${pathToFileURL(verifierPath).href}?v=${Date.now()}`);
  try {
    return await verifier.verify({ workspaceRoot, timeoutMs });
  } catch (error) {
    return { status: "infrastructure_error", passed: false, duration_ms: 0, output: error.message };
  }
}

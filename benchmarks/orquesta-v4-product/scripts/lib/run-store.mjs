import fs from "node:fs/promises";
import path from "node:path";

export function runDirectory(storageRoot, runId) {
  if (!/^[a-zA-Z0-9._-]+$/.test(runId || "")) throw new Error("run ID contains unsupported characters");
  return path.join(storageRoot, "runs", runId);
}

export async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rm(filePath, { force: true });
  await fs.rename(temporary, filePath);
}

export async function saveRun(storageRoot, run) {
  const directory = runDirectory(storageRoot, run.run_id);
  await writeJsonAtomic(path.join(directory, "run.json"), run);
  return directory;
}

export async function loadRun(storageRoot, runId) {
  const filePath = path.join(runDirectory(storageRoot, runId), "run.json");
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`run was not found: ${runId}`);
    throw error;
  }
}

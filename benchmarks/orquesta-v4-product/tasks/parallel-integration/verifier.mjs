import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const verifierRoot = path.dirname(fileURLToPath(import.meta.url));

export async function verify({ workspaceRoot, timeoutMs }) {
  const started = Date.now();
  try {
    const childEnv = { ...process.env, BENCHMARK_WORKSPACE: workspaceRoot };
    delete childEnv.NODE_TEST_CONTEXT;
    const visibleTests = fs.readdirSync(path.join(workspaceRoot, "test"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
      .map((entry) => path.join(workspaceRoot, "test", entry.name));
    const hiddenTest = path.join(verifierRoot, "verifier", "integration.test.ts");
    const result = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", "--test", ...visibleTests, hiddenTest], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: childEnv,
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
      maxBuffer: 1024 * 1024
    });
    if (result.error?.code === "ETIMEDOUT") return { status: "infrastructure_error", passed: false, duration_ms: Date.now() - started, output: "verifier timed out" };
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim().slice(-8000);
    return { status: result.status === 0 ? "passed" : "failed", passed: result.status === 0, duration_ms: Date.now() - started, output };
  } catch (error) {
    return { status: "infrastructure_error", passed: false, duration_ms: Date.now() - started, output: error.message };
  }
}

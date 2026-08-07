import fs from "node:fs/promises";
import path from "node:path";

export async function verify({ workspaceRoot }) {
  const started = Date.now();
  try {
    const report = JSON.parse(await fs.readFile(
      path.join(workspaceRoot, "reports", "ui-review.json"),
      "utf8",
    ));
    const issues = Array.isArray(report.issues) ? report.issues : [];
    const text = JSON.stringify(issues).toLowerCase();
    const categories = new Set(issues.map((issue) => String(issue.category || "").toLowerCase()));
    const refs = new Set(issues.flatMap((issue) => Array.isArray(issue.source_refs) ? issue.source_refs : []));
    const textSize = categories.has("text_size") || (text.includes("10px") && text.includes("14px"));
    const focus = categories.has("keyboard_focus") || text.includes("outline");
    const overflow = categories.has("viewport_overflow") || text.includes("130vh");
    const cited = refs.has("requirements/ui.md") && refs.has("ui/styles.css");
    const passed = issues.length >= 3 && textSize && focus && overflow && cited;
    return {
      status: passed ? "passed" : "failed",
      passed,
      duration_ms: Date.now() - started,
      output: passed ? "UI requirement violations are reported with evidence" : "UI review missed a required issue or citation",
    };
  } catch (error) {
    return { status: "failed", passed: false, duration_ms: Date.now() - started, output: error.message };
  }
}

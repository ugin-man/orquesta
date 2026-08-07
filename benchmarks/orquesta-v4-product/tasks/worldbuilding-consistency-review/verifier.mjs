import fs from "node:fs/promises";
import path from "node:path";

export async function verify({ workspaceRoot }) {
  const started = Date.now();
  try {
    const report = JSON.parse(await fs.readFile(
      path.join(workspaceRoot, "reports", "worldbuilding-consistency.json"),
      "utf8",
    ));
    const issues = Array.isArray(report.issues) ? report.issues : [];
    const text = JSON.stringify(issues).toLowerCase();
    const refs = new Set(issues
      .flatMap((issue) => Array.isArray(issue.source_refs) ? issue.source_refs : [])
      .map((reference) => String(reference).replace(/:\d+(?:-\d+)?$/u, "")));
    const curfew = text.includes("22:00") && text.includes("23:00");
    const lighthouse = text.includes("amber") && text.includes("blue");
    const cited = refs.has("lore/world.md")
      && refs.has("characters/aria.md")
      && refs.has("scenes/chapter-4.md");
    const passed = issues.length >= 2 && curfew && lighthouse && cited;
    return {
      status: passed ? "passed" : "failed",
      passed,
      duration_ms: Date.now() - started,
      output: passed ? "continuity conflicts are reported with evidence" : "required continuity conflicts or citations are missing",
    };
  } catch (error) {
    return { status: "failed", passed: false, duration_ms: Date.now() - started, output: error.message };
  }
}

import fs from "node:fs/promises";
import path from "node:path";

function rows(value) {
  return Array.isArray(value) ? value : [];
}

export async function verify({ workspaceRoot }) {
  const started = Date.now();
  try {
    const report = JSON.parse(await fs.readFile(
      path.join(workspaceRoot, "reports", "external-comparison.json"),
      "utf8",
    ));
    const strengths = rows(report.strengths);
    const gaps = rows(report.gaps);
    const recommendations = rows(report.recommendations);
    const citations = rows(report.citations);
    const text = JSON.stringify({ strengths, gaps, recommendations, citations }).toLowerCase();
    const evidence = text.includes("competitor-a.md") && text.includes("competitor-b.md");
    const passed = strengths.length >= 1
      && gaps.length >= 2
      && recommendations.length >= 2
      && citations.length >= 2
      && text.includes("offline")
      && text.includes("audit")
      && text.includes("plugin")
      && evidence;
    return {
      status: passed ? "passed" : "failed",
      passed,
      duration_ms: Date.now() - started,
      output: passed ? "comparison covers strengths, gaps, recommendations, and evidence" : "comparison is incomplete or not evidence-bound",
    };
  } catch (error) {
    return { status: "failed", passed: false, duration_ms: Date.now() - started, output: error.message };
  }
}

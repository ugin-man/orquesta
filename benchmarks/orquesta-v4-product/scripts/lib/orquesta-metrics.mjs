import fs from "node:fs/promises";
import path from "node:path";

export async function readOrquestaMetrics(workspaceRoot) {
  const filePath = path.join(workspaceRoot, ".orquesta", "state", "tasks.json");
  let value;
  try {
    value = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { handoffs: null, independent_reviews: null, correction_batches: null };
    return { handoffs: null, independent_reviews: null, correction_batches: null, error: error.message };
  }
  const tasks = Array.isArray(value) ? value : Array.isArray(value.tasks) ? value.tasks : [];
  const metrics = tasks
    .map((task) => task?.execution_metrics)
    .filter((entry) => entry && typeof entry === "object");
  const sum = (key) => metrics.reduce((total, entry) => total + (Number.isInteger(entry[key]) && entry[key] >= 0 ? entry[key] : 0), 0);
  const observedHandoffs = tasks.filter((task) => (
    task?.handoff_required === true
    && typeof task?.handoff_sent_at === "string"
    && task.handoff_sent_at.length > 0
  )).length;
  const observedReviews = tasks.reduce(
    (total, task) => total + (
      Array.isArray(task?.review_receipts) ? task.review_receipts.length : 0
    ),
    0
  );
  const observedCorrections = tasks.reduce(
    (total, task) => total + (
      Array.isArray(task?.correction_batches) ? task.correction_batches.length : 0
    ),
    0
  );
  return {
    handoffs: Math.max(sum("handoffs"), observedHandoffs),
    independent_reviews: Math.max(sum("independent_reviews"), observedReviews),
    correction_batches: Math.max(sum("correction_batches"), observedCorrections)
  };
}

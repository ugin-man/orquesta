import { classifyStoredResult } from "./contract.mjs";

const MODES = ["plain", "skills", "orquesta"];

function lowerWinner(left, right) {
  if (left === right) return null;
  return left < right ? "left" : "right";
}

function pair(left, right, directComparisonAllowed) {
  const timeWinner = directComparisonAllowed
    ? lowerWinner(left.wall_time_ms, right.wall_time_ms)
    : null;
  const tokenComparable = directComparisonAllowed
    && left.token_usage?.coverage === "complete"
    && right.token_usage?.coverage === "complete";
  const leftTotals = left.token_usage?.totals;
  const rightTotals = right.token_usage?.totals;
  return {
    left_mode: left.mode,
    right_mode: right.mode,
    time_winner: timeWinner === "left"
      ? left.mode
      : timeWinner === "right"
        ? right.mode
        : null,
    time_delta_ms: directComparisonAllowed
      ? right.wall_time_ms - left.wall_time_ms
      : null,
    total_token_winner: tokenComparable
      ? lowerWinner(leftTotals.total_tokens, rightTotals.total_tokens) === "left"
        ? left.mode
        : lowerWinner(leftTotals.total_tokens, rightTotals.total_tokens) === "right"
          ? right.mode
          : null
      : null,
    total_token_delta: tokenComparable
      ? rightTotals.total_tokens - leftTotals.total_tokens
      : null,
    uncached_input_delta: tokenComparable
      ? rightTotals.uncached_input_tokens - leftTotals.uncached_input_tokens
      : null,
    cached_input_delta: tokenComparable
      ? rightTotals.cached_input_tokens - leftTotals.cached_input_tokens
      : null
  };
}

export function compareMatrix(runs) {
  const byMode = new Map((runs || []).map((run) => [run.mode, run]));
  if (
    runs?.length !== 3
    || MODES.some((mode) => !byMode.has(mode))
    || byMode.size !== 3
  ) {
    throw new Error("comparison requires plain, skills, and orquesta exactly once");
  }
  const values = MODES.map((mode) => byMode.get(mode));
  const matrixIds = new Set(values.map((run) => run.matrix_id));
  if (matrixIds.size !== 1) throw new Error("comparison results must use the same matrix_id");
  const taskIds = new Set(values.map((run) => run.task_id));
  if (taskIds.size !== 1) throw new Error("comparison results must use the same task_id");
  const allPassed = values.every((run) => (
    run.status === "finalized"
    && run.verifier?.passed === true
  ));
  return {
    matrix_id: values[0].matrix_id,
    task_id: values[0].task_id,
    decision: allPassed ? "all_passed" : "quality_mismatch",
    direct_comparison_allowed: allPassed,
    runs: Object.fromEntries(values.map((run) => [run.mode, run])),
    pairs: {
      plain_vs_skills: pair(
        byMode.get("plain"),
        byMode.get("skills"),
        allPassed
      ),
      skills_vs_orquesta: pair(
        byMode.get("skills"),
        byMode.get("orquesta"),
        allPassed
      ),
      plain_vs_orquesta: pair(
        byMode.get("plain"),
        byMode.get("orquesta"),
        allPassed
      )
    }
  };
}

export function splitMatrixAndLegacy(results) {
  const matrixRuns = [];
  const legacyPilots = [];
  const unknown = [];
  for (const result of results || []) {
    const classification = classifyStoredResult(result);
    if (classification.classification === "matrix_run") matrixRuns.push(result);
    else if (classification.classification === "legacy_pilot") legacyPilots.push(result);
    else unknown.push(result);
  }
  return {
    matrix_runs: matrixRuns,
    legacy_pilots: legacyPilots,
    unknown
  };
}

function seconds(value) {
  return Number.isFinite(value) ? (value / 1000).toFixed(1) : "-";
}

function metric(run, key) {
  const value = run.token_usage?.totals?.[key];
  return Number.isFinite(value) ? String(value) : "-";
}

function diagnostic(run, key) {
  const value = run.diagnostics?.[key];
  return value === null || value === undefined ? "-" : String(value);
}

function quality(run) {
  if (run.verifier?.status === "infrastructure_error") return "INFRA";
  return run.verifier?.passed ? "PASS" : "FAIL";
}

export function renderMarkdownReport(comparisons, legacyPilots = []) {
  const lines = [
    "# Codex / Common Skills / Orquesta V4-fast Benchmark",
    "",
    "> 同一課題を三条件で実行した少数runの比較です。品質が揃わない場合、速度やtokenだけで勝者を決めません。",
    ""
  ];
  for (const comparison of comparisons) {
    const { plain, skills, orquesta } = comparison.runs;
    lines.push(
      `## ${comparison.matrix_id}`,
      "",
      `Task: ${comparison.task_id}`,
      "",
      `Decision: ${comparison.decision}`,
      "",
      "| Metric | Plain Codex | Common skills | Orquesta V4-fast |",
      "| --- | ---: | ---: | ---: |",
      `| Quality | ${quality(plain)} | ${quality(skills)} | ${quality(orquesta)} |`,
      `| Wall time (sec) | ${seconds(plain.wall_time_ms)} | ${seconds(skills.wall_time_ms)} | ${seconds(orquesta.wall_time_ms)} |`,
      `| Uncached input tokens | ${metric(plain, "uncached_input_tokens")} | ${metric(skills, "uncached_input_tokens")} | ${metric(orquesta, "uncached_input_tokens")} |`,
      `| Cached input tokens | ${metric(plain, "cached_input_tokens")} | ${metric(skills, "cached_input_tokens")} | ${metric(orquesta, "cached_input_tokens")} |`,
      `| Output tokens | ${metric(plain, "output_tokens")} | ${metric(skills, "output_tokens")} | ${metric(orquesta, "output_tokens")} |`,
      `| Reasoning output tokens | ${metric(plain, "reasoning_output_tokens")} | ${metric(skills, "reasoning_output_tokens")} | ${metric(orquesta, "reasoning_output_tokens")} |`,
      `| Total tokens | ${metric(plain, "total_tokens")} | ${metric(skills, "total_tokens")} | ${metric(orquesta, "total_tokens")} |`,
      `| Threads | ${diagnostic(plain, "participating_threads")} | ${diagnostic(skills, "participating_threads")} | ${diagnostic(orquesta, "participating_threads")} |`,
      `| Turns | ${diagnostic(plain, "agent_turns")} | ${diagnostic(skills, "agent_turns")} | ${diagnostic(orquesta, "agent_turns")} |`,
      `| Handoffs | ${diagnostic(plain, "handoffs")} | ${diagnostic(skills, "handoffs")} | ${diagnostic(orquesta, "handoffs")} |`,
      `| Independent reviews | ${diagnostic(plain, "independent_reviews")} | ${diagnostic(skills, "independent_reviews")} | ${diagnostic(orquesta, "independent_reviews")} |`,
      `| Correction batches | ${diagnostic(plain, "correction_batches")} | ${diagnostic(skills, "correction_batches")} | ${diagnostic(orquesta, "correction_batches")} |`,
      `| User interventions | ${diagnostic(plain, "user_interventions")} | ${diagnostic(skills, "user_interventions")} | ${diagnostic(orquesta, "user_interventions")} |`,
      ""
    );
  }
  if (legacyPilots.length > 0) {
    lines.push(
      "## Legacy pilots",
      "",
      "旧`solo`は実行条件をplainまたはskillsへ変換せず、正式比較から除外しています。",
      ""
    );
    for (const run of legacyPilots) {
      lines.push(`- ${run.run_id || "unknown"}: ${run.mode || "unknown"}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

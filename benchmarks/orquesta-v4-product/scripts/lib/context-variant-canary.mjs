import fs from "node:fs/promises";
import path from "node:path";

export const CONTEXT_VARIANTS = Object.freeze([
  "v1",
  "fixed_minimal",
  "v2_initial",
  "v2_bounded_retrieval",
]);

export const CANARY_DIRECT_SOURCES = Object.freeze([
  "lore/world.md",
  "characters/aria.md",
  "scenes/chapter-4.md",
]);

const LEGACY_OPERATING_CONTEXT = Object.freeze([
  ".agents/skills/orquesta/SKILL.md",
  ".agents/skills/orquesta/references/orchestration-protocol.md",
  ".agents/skills/orquesta/references/agent-contract.md",
  ".agents/skills/orquesta/references/initial-setup.md",
  ".orquesta/CURRENT_ORCHESTRA.md",
  ".orquesta/state/tasks.json",
  ".orquesta/project/project_understanding.json",
  ".benchmark-context/legacy-project-history.md",
  ".benchmark-context/legacy-architecture-notes.md",
  ".benchmark-context/legacy-review-log.md",
  ...CANARY_DIRECT_SOURCES,
]);

function quoted(values) {
  return values.map((value) => `- ${value}`).join("\n");
}

function commonPrompt(benchmarkPrompt) {
  return [
    "You are the only bounded specialist for this canary.",
    "Do not coordinate, delegate, inspect unrelated history, or modify .orquesta state.",
    "Complete the requested deliverable in the current workspace and run the shortest useful check.",
    "End after the deliverable is complete.",
    "",
    "Task:",
    benchmarkPrompt,
  ].join("\n");
}

export function contextPrompt({
  variant,
  benchmarkPrompt,
  workspaceRoot,
  taskId,
  brokerPath = null,
}) {
  if (!CONTEXT_VARIANTS.includes(variant)) {
    throw new TypeError(`unsupported context variant: ${variant}`);
  }
  const common = commonPrompt(benchmarkPrompt);
  if (variant === "v1") {
    return [
      common,
      "",
      "Legacy V1 context contract:",
      "Before solving the task, read every operating and project-context source listed below.",
      "Treat the list as required reading even when some files do not affect the final answer.",
      quoted(LEGACY_OPERATING_CONTEXT),
    ].join("\n");
  }
  if (variant === "fixed_minimal") {
    return [
      common,
      "",
      "Fixed minimal context contract:",
      "Read only the three task sources below. Do not load the Orquesta skill or canonical project history.",
      quoted(CANARY_DIRECT_SOURCES),
    ].join("\n");
  }
  const broker = brokerPath || path.join(
      workspaceRoot,
      ".agents",
      "skills",
      "orquesta",
      "scripts",
      "context-v2-broker.js",
    );
  const base = [
    common,
    "",
    `Context V2 contract (${variant}):`,
    "Bootstrap the selected context and its contents with one command:",
    `node "${broker}" --root "${workspaceRoot}" --task "${taskId}" bootstrap`,
    "Use the returned opened content as the task context. Do not read the Orquesta skill or unrelated files directly.",
  ];
  if (variant === "v2_initial") {
    base.push("Do not search for or expand additional sources in this condition.");
  } else {
    base.push(
      "If the initial selection is insufficient, state the missing fact, search through the same broker,",
      "then expand only the smallest relevant source set before opening it. Do not scan the repository.",
    );
  }
  return base.join("\n");
}

export async function writeLegacyNoise(workspaceRoot) {
  const root = path.join(workspaceRoot, ".benchmark-context");
  await fs.mkdir(root, { recursive: true });
  const paragraphs = Array.from({ length: 28 }, (_, index) => (
    `Historical note ${index + 1}: This archived project discussion describes unrelated deployment, `
    + "marketing, migration, and release decisions. It is intentionally irrelevant to the continuity task."
  )).join("\n\n");
  const files = [
    "legacy-project-history.md",
    "legacy-architecture-notes.md",
    "legacy-review-log.md",
  ];
  await Promise.all(files.map((file, index) => fs.writeFile(
    path.join(root, file),
    `# Legacy context ${index + 1}\n\n${paragraphs}\n`,
    "utf8",
  )));
  return files.map((file) => `.benchmark-context/${file}`);
}

async function estimateFiles(workspaceRoot, refs) {
  let bytes = 0;
  const observed = [];
  for (const ref of refs) {
    const file = path.join(workspaceRoot, ...ref.split("/"));
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) continue;
    bytes += stat.size;
    observed.push(ref);
  }
  return {
    refs: observed,
    bytes,
    token_estimate: Math.max(1, Math.ceil(bytes / 4)),
  };
}

export async function estimateVariantContext({
  variant,
  workspaceRoot,
  contextPack,
}) {
  if (variant === "v1") return estimateFiles(workspaceRoot, LEGACY_OPERATING_CONTEXT);
  if (variant === "fixed_minimal") return estimateFiles(workspaceRoot, CANARY_DIRECT_SOURCES);
  return {
    refs: contextPack.provenance.map((entry) => entry.source_ref),
    bytes: null,
    token_estimate: contextPack.budget_receipt.selected_tokens,
  };
}

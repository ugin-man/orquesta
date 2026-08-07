const RUNTIME_FIELDS = [
  "model",
  "reasoning_effort",
  "sandbox",
  "approval_policy"
];

function skillName(skill) {
  return String(typeof skill === "string" ? skill : skill?.name || "").toLowerCase();
}

function skillSource(skill) {
  return String(typeof skill === "string" ? "unknown" : skill?.source || "unknown").toLowerCase();
}

export function auditEnvironment({ mode, expectedRuntime, observed }) {
  const violations = [];

  for (const field of RUNTIME_FIELDS) {
    if (observed?.[field] !== expectedRuntime?.[field]) {
      violations.push(
        `${field} mismatch: expected ${expectedRuntime?.[field]}, observed ${observed?.[field]}`
      );
    }
  }

  const skills = Array.isArray(observed?.loaded_skills) ? observed.loaded_skills : [];
  const plugins = Array.isArray(observed?.loaded_plugins) ? observed.loaded_plugins : [];
  const mcpServers = Array.isArray(observed?.mcp_servers) ? observed.mcp_servers : [];
  const instructionSources = Array.isArray(observed?.instruction_sources)
    ? observed.instruction_sources.map((value) => String(value).toLowerCase())
    : [];
  const orquestaSkills = skills.filter((skill) => skillName(skill) === "orquesta");

  if (mode === "plain") {
    if (observed?.multi_agent) violations.push("plain must not enable multi-agent");
    const nonSystemSkills = skills.filter((skill) => skillSource(skill) !== "system");
    if (nonSystemSkills.length > 0) violations.push("plain loaded a non-system skill");
    if (plugins.length > 0) violations.push("plain loaded a plugin");
    if (mcpServers.length > 0) violations.push("plain loaded an MCP server");
    const forbiddenInstructions = instructionSources.filter((source) => source !== "system");
    if (forbiddenInstructions.length > 0) {
      violations.push(`plain loaded forbidden instruction sources: ${forbiddenInstructions.join(", ")}`);
    }
  } else if (mode === "skills") {
    if (observed?.multi_agent) violations.push("skills must not enable multi-agent");
    if (orquestaSkills.length > 0) violations.push("skills loaded the Orquesta repository skill");
  } else if (mode === "orquesta") {
    if (!observed?.multi_agent) violations.push("orquesta must enable multi-agent");
    if (orquestaSkills.length !== 1) {
      violations.push("orquesta requires exactly one Orquesta repository skill");
    } else if (!orquestaSkills[0]?.runtime_snapshot_hash) {
      violations.push("Orquesta skill is missing its runtime snapshot hash");
    }
  } else {
    violations.push(`unsupported benchmark mode: ${mode}`);
  }

  return {
    valid: violations.length === 0,
    status: violations.length === 0 ? "clean" : "environment_contamination",
    violations
  };
}

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PROVENANCE = Symbol("contextCompilerAgentContractProvenance");

function contextError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function loadAgentContract({ agentsPath, agentId } = {}) {
  if (typeof agentsPath !== "string" || !agentsPath || typeof agentId !== "string" || !agentId) {
    throw contextError("CONTEXT_AGENT_FILE_INVALID", "Agent contract input must name a file and agent.");
  }

  let source;
  let document;
  try {
    source = fs.readFileSync(agentsPath);
    document = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw contextError("CONTEXT_AGENT_FILE_INVALID", "Agent contract file is not readable JSON.", { agents_path: agentsPath });
  }

  if (!document || typeof document !== "object" || Array.isArray(document) || !Array.isArray(document.agents)) {
    throw contextError("CONTEXT_AGENT_FILE_INVALID", "Agent contract file must contain an agents array.", { agents_path: agentsPath });
  }

  const matches = document.agents.filter((agent) => agent && typeof agent === "object" && !Array.isArray(agent) && agent.agent_id === agentId);
  if (!matches.length) {
    throw contextError("CONTEXT_AGENT_NOT_FOUND", "Named agent contract was not found.", { agent_id: agentId });
  }
  if (matches.length !== 1) {
    throw contextError("CONTEXT_AGENT_DUPLICATE", "Named agent contract must be unique.", { agent_id: agentId });
  }

  const contract = matches[0];
  Object.defineProperty(contract, PROVENANCE, {
    value: {
      agents_path: path.resolve(agentsPath),
      source_hash: crypto.createHash("sha256").update(source).digest("hex"),
      target_agent_id: agentId,
    },
    enumerable: false,
  });
  return contract;
}

function getAgentContractProvenance(contract) {
  return contract && contract[PROVENANCE] ? contract[PROVENANCE] : null;
}

module.exports = { contextError, getAgentContractProvenance, loadAgentContract };

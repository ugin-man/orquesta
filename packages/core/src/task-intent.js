"use strict";

const { assertContract, canonicalHash } = require("@orquesta/contracts");

const INPUT_FIELDS = [
  "rawRequestRef",
  "desiredOutcome",
  "acceptanceCriteria",
  "constraints",
  "risk",
  "authorityBoundary",
  "assumptions",
  "status",
];

function createTaskIntent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("TaskIntent input must be an object");
  }
  for (const field of Object.keys(input)) {
    if (!INPUT_FIELDS.includes(field)) throw new TypeError(`TaskIntent input field is not allowed: ${field}`);
  }
  const outcome = {
    raw_request_ref: input.rawRequestRef,
    desired_outcome: input.desiredOutcome,
    acceptance_criteria: input.acceptanceCriteria,
    constraints: input.constraints,
    risk: input.risk,
    authority_boundary: input.authorityBoundary,
    assumptions: input.assumptions,
    status: input.status === undefined ? "compiled" : input.status,
  };
  const taskIntent = {
    task_intent_id: `TI-${canonicalHash(outcome).slice(0, 12)}`,
    ...outcome,
  };
  return assertContract("task-intent", taskIntent);
}

module.exports = { createTaskIntent };

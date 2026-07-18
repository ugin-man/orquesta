"use strict";

const { assertContract } = require("@orquesta/contracts");
const { buildGraph } = require("./graph");
const { compilerError, matchedRules } = require("./rule-source");

function compileCapabilities({ taskIntent, rules } = {}) {
  try {
    assertContract("task-intent", taskIntent);
  } catch (error) {
    throw compilerError("CAPABILITY_TASK_INTENT_INVALID", "TaskIntent must be a valid outcome contract", { errors: error.errors || [] });
  }
  return buildGraph({ taskIntent, matches: matchedRules(rules, taskIntent) });
}

module.exports = { compileCapabilities };

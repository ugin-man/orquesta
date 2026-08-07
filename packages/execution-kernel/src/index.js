"use strict";

const {
  ACTIVE_STATES,
  TERMINAL_STATES,
  TASK_STATES,
  applyKernelEvent,
  claimDispatch,
  createKernelState,
  dispatchIdFor,
  executionKeyFor,
  normalizeTaskDefinition,
  reconcileTasks,
  retryDelayMs,
  selectDispatches,
} = require("./kernel");
const { executionKernelEnabled, planDispatchTick, runDispatchTick } = require("./scheduler");
const { createAppServerExecutionBridge } = require("./app-server-bridge");
const { reconcileContextReceiptV2 } = require("./context-reconciler");
const {
  createOrchestratorResumePlan,
  verifyControlPlaneContinuity,
} = require("./orchestrator-loop");
const {
  DEFAULT_REQUIREMENTS,
  REQUIRED_SCENARIOS,
  evaluateExecutionKernelCutover,
} = require("./cutover-evaluator");
const {
  DEFAULT_SESSION_ROTATION_POLICY,
  ROTATION_STATES,
  activateSessionSuccessor,
  beginSessionDrain,
  createSessionRotationRegistry,
  markSessionCheckpointed,
  markSuccessorVerified,
  normalizeRotationPolicy,
  recordCompaction,
  registerSessionSuccessor,
  rotationStateForCount,
  selectActiveAgentSession,
  verifySuccessorReceipt,
} = require("./session-rotation");

module.exports = {
  ACTIVE_STATES,
  DEFAULT_REQUIREMENTS,
  DEFAULT_SESSION_ROTATION_POLICY,
  REQUIRED_SCENARIOS,
  ROTATION_STATES,
  TERMINAL_STATES,
  TASK_STATES,
  activateSessionSuccessor,
  applyKernelEvent,
  beginSessionDrain,
  claimDispatch,
  createAppServerExecutionBridge,
  createKernelState,
  createSessionRotationRegistry,
  createOrchestratorResumePlan,
  dispatchIdFor,
  evaluateExecutionKernelCutover,
  executionKernelEnabled,
  executionKeyFor,
  markSessionCheckpointed,
  markSuccessorVerified,
  normalizeRotationPolicy,
  normalizeTaskDefinition,
  planDispatchTick,
  reconcileTasks,
  reconcileContextReceiptV2,
  recordCompaction,
  registerSessionSuccessor,
  retryDelayMs,
  rotationStateForCount,
  runDispatchTick,
  selectDispatches,
  selectActiveAgentSession,
  verifySuccessorReceipt,
  verifyControlPlaneContinuity,
};

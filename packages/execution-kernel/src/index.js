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
const organizationV3 = require("./organization-v3");
const organizationControllerV3 = require("./organization-controller-v3");
const exclusiveProcessLockV1 = require("./exclusive-process-lock-v1");
const organizationStoreV3 = require("./organization-store-v3");
const foundationBootstrapV3 = require("./foundation-bootstrap-v3");
const placementIntentV3 = require("./placement-intent-v3");
const placementSagaStoreV1 = require("./placement-saga-store-v1");
const desktopOperationWorkflow = require("./desktop-operation-workflow");
const projectExecutionContext = require("./project-execution-context");

module.exports = {
  ...organizationV3,
  ...organizationControllerV3,
  ...exclusiveProcessLockV1,
  createOrganizationV3Store: organizationStoreV3.createOrganizationV3Store,
  inspectOrganizationV3: organizationStoreV3.inspectOrganizationV3,
  BOOTSTRAP_PHASES: foundationBootstrapV3.BOOTSTRAP_PHASES,
  FOUNDATION_BOOTSTRAP_CLASSIFICATIONS: foundationBootstrapV3.FOUNDATION_BOOTSTRAP_CLASSIFICATIONS,
  classifyFoundationBootstrapV3: foundationBootstrapV3.classifyFoundationBootstrapV3,
  runFoundationBootstrapV3: foundationBootstrapV3.runFoundationBootstrapV3,
  PERSISTENT_AGENT_PLACEMENT_OPERATION_ID: placementIntentV3.OPERATION_ID,
  runPersistentAgentPlacement: placementIntentV3.runPersistentAgentPlacement,
  taskFingerprint: placementSagaStoreV1.taskFingerprint,
  ...desktopOperationWorkflow,
  ...projectExecutionContext,
  ACTIVE_STATES,
  DEFAULT_REQUIREMENTS,
  REQUIRED_SCENARIOS,
  TERMINAL_STATES,
  TASK_STATES,
  applyKernelEvent,
  claimDispatch,
  createAppServerExecutionBridge,
  createKernelState,
  createOrchestratorResumePlan,
  dispatchIdFor,
  evaluateExecutionKernelCutover,
  executionKernelEnabled,
  executionKeyFor,
  normalizeTaskDefinition,
  planDispatchTick,
  reconcileTasks,
  reconcileContextReceiptV2,
  retryDelayMs,
  runDispatchTick,
  selectDispatches,
  verifyControlPlaneContinuity,
};

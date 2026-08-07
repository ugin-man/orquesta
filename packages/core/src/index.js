"use strict";

const { createTaskIntent } = require("./task-intent");
const { COMMAND_NAMES, createCommandBoundary } = require("./commands");
const { createProjectors, initialProjection, replayProjection, projectionHash } = require("./projectors");
const { createPhaseReview, decidePhaseReview } = require("./phase-review");
const { createInstallApprovalTarget } = require("./install-approval");
const { REQUIRED_PACKET_FIELDS, createReviewPacket } = require("./review-packet");
const {
  CORRECTION_THRESHOLD_REPLAN_REASON,
  EXECUTION_LANES,
  EXECUTION_BUDGETS,
  assessExecutionBudget,
  createExecutionPlan,
  escalateExecutionPlan,
  reviseExecutionPlan,
} = require("./execution-policy");
const {
  ORGANIZATION_POLICY,
  createOrganizationState,
  canonicalRoleId,
  assertOrganizationInvariants,
  applyOrganizationDecision,
  agentCapabilityProviders
} = require("./organization-model");
const { STAFFING_ORDER, analyzeTaskStructure, evaluateStaffing, createOrganizationPreflight } = require("./organization-preflight");
const { FOUNDATION, normalizeProjectUnderstanding, selectFirstExecutableBatch, createFoundationPlan, createAdaptiveSpecialistPlan } = require("./adaptive-setup");
const { profileTask } = require("./task-profiler");
const { createProfiledExecutionPlan } = require("./profiled-execution-plan");
const {
  completeReuseDiscovery,
  executeReuseDiscovery,
  integrateReuseDiscovery,
  planReuseDiscovery,
} = require("./reuse-discovery");

module.exports = {
  COMMAND_NAMES, REQUIRED_PACKET_FIELDS, createCommandBoundary, createInstallApprovalTarget, createPhaseReview, createProjectors, createReviewPacket, createTaskIntent,
  assessExecutionBudget, decidePhaseReview, CORRECTION_THRESHOLD_REPLAN_REASON, EXECUTION_BUDGETS, EXECUTION_LANES, createExecutionPlan, escalateExecutionPlan, reviseExecutionPlan,
  ORGANIZATION_POLICY, createOrganizationState, canonicalRoleId, assertOrganizationInvariants, applyOrganizationDecision, agentCapabilityProviders,
  STAFFING_ORDER, analyzeTaskStructure, evaluateStaffing, createOrganizationPreflight,
  FOUNDATION, normalizeProjectUnderstanding, selectFirstExecutableBatch, createFoundationPlan, createAdaptiveSpecialistPlan,
  completeReuseDiscovery, createProfiledExecutionPlan, executeReuseDiscovery, integrateReuseDiscovery, planReuseDiscovery, profileTask,
  initialProjection, projectionHash, replayProjection,
};

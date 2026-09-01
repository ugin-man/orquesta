"use strict";

const { auditProjectStructure } = require("./audit");
const {
  classifyReference,
  createLifecycleProjection,
  scanProjectStructure,
} = require("./inventory");
const { matchesAny, matchesGlob, normalizeRef, relativeToRoot } = require("./patterns");
const { renderLifecycleContextReport, renderShadowAuditReport } = require("./report");
const {
  createComponentLifecycleSummary,
  createCompactProjectMapView,
  createLifecycleContextReceipt,
  createLifecycleReadBoundary,
  enrichProjectMapWithLifecycle,
} = require("./context-v2");
const {
  auditCanonicalClaimsForPlacement,
  detectSupersedesCandidates,
  inspectTaskPlacementCompletion,
  resolvePlacement,
} = require("./placement");
const {
  PROJECT_STRUCTURE_TEMPLATE_VERSION,
  createInitialStructureContextView,
  createPreservedProjectStructureSetup,
  createProjectStructureSetupPlan,
  extendProjectStructureComponents,
  inferProjectArchetype,
  inspectProjectStructureEvidence,
  normalizeSetupAnswers,
} = require("./setup");
const {
  createProjectStructureMigrationPlan,
  renderMigrationPlanReview,
  workspaceFingerprint,
} = require("./migration");

module.exports = {
  auditProjectStructure,
  auditCanonicalClaimsForPlacement,
  classifyReference,
  createInitialStructureContextView,
  createComponentLifecycleSummary,
  createCompactProjectMapView,
  createLifecycleContextReceipt,
  createLifecycleProjection,
  createLifecycleReadBoundary,
  createProjectStructureMigrationPlan,
  createPreservedProjectStructureSetup,
  createProjectStructureSetupPlan,
  detectSupersedesCandidates,
  enrichProjectMapWithLifecycle,
  extendProjectStructureComponents,
  inferProjectArchetype,
  inspectProjectStructureEvidence,
  inspectTaskPlacementCompletion,
  matchesAny,
  matchesGlob,
  normalizeRef,
  normalizeSetupAnswers,
  PROJECT_STRUCTURE_TEMPLATE_VERSION,
  relativeToRoot,
  renderLifecycleContextReport,
  renderMigrationPlanReview,
  renderShadowAuditReport,
  resolvePlacement,
  scanProjectStructure,
  workspaceFingerprint,
};

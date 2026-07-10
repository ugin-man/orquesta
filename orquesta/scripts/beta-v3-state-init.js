#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const { readJsonFile, writeJsonAtomic } = require("./json-state");
const {
  defaultIncidentCandidateInbox,
  defaultIncidentClusterInbox
} = require("./incident-intake");

function defaultDashboardActionsState() {
  return { version: 1, actions: [] };
}

function defaultBetaV3State() {
  return {
    dashboardActions: defaultDashboardActionsState(),
    incidentCandidates: defaultIncidentCandidateInbox(),
    incidentClusters: defaultIncidentClusterInbox()
  };
}

function stateDefinitions(root) {
  const defaults = defaultBetaV3State();
  return [
    {
      relativePath: ".orquesta/state/dashboard_actions.json",
      filePath: path.join(root, ".orquesta", "state", "dashboard_actions.json"),
      defaultValue: defaults.dashboardActions,
      collectionKey: "actions"
    },
    {
      relativePath: ".orquesta/failures/incident_candidates.json",
      filePath: path.join(root, ".orquesta", "failures", "incident_candidates.json"),
      defaultValue: defaults.incidentCandidates,
      collectionKey: "candidates"
    },
    {
      relativePath: ".orquesta/failures/incident_clusters.json",
      filePath: path.join(root, ".orquesta", "failures", "incident_clusters.json"),
      defaultValue: defaults.incidentClusters,
      collectionKey: "clusters"
    }
  ];
}

function assertValidStateFile(definition) {
  let value;
  try {
    value = readJsonFile(definition.filePath, definition.defaultValue);
  } catch (cause) {
    const error = new Error(`Beta V3 state file is not valid JSON: ${definition.relativePath}`);
    error.code = "BETA_V3_STATE_INVALID";
    error.filePath = definition.filePath;
    error.cause = cause;
    throw error;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || !Number.isInteger(value.version) || !Array.isArray(value[definition.collectionKey])) {
    const error = new Error(`Beta V3 state file has an invalid schema: ${definition.relativePath}`);
    error.code = "BETA_V3_STATE_INVALID";
    error.filePath = definition.filePath;
    throw error;
  }
  return value;
}

function ensureBetaV3ReleaseState(rootInput, options = {}) {
  const root = path.resolve(rootInput);
  const created = [];
  const existing = [];
  const writes = [];
  for (const definition of stateDefinitions(root)) {
    if (fs.existsSync(definition.filePath)) {
      assertValidStateFile(definition);
      existing.push(definition.relativePath);
      continue;
    }
    const write = writeJsonAtomic(definition.filePath, definition.defaultValue, options);
    created.push(definition.relativePath);
    writes.push({ path: definition.relativePath, lock: write.lock || null });
  }
  return { root, created, existing, writes };
}

function parseRoot(args) {
  const rootIndex = args.indexOf("--root");
  if (rootIndex >= 0 && args[rootIndex + 1]) return args[rootIndex + 1];
  return path.resolve(__dirname, "../..");
}

if (require.main === module) {
  try {
    const result = ensureBetaV3ReleaseState(parseRoot(process.argv.slice(2)));
    console.log(JSON.stringify({
      initialized: result.created,
      preserved: result.existing
    }, null, 2));
  } catch (error) {
    console.error(`Beta V3 state initialization failed: ${error.code || "ERROR"}: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  defaultBetaV3State,
  ensureBetaV3ReleaseState
};

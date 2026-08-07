"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createProfiledExecutionPlan } = require("../../packages/core/src/profiled-execution-plan");
const { createTaskIntent } = require("../../packages/core/src/task-intent");
const {
  buildSourceCatalogV2,
  compileContextPackV2Shadow,
  createProjectControlPlaneV2,
  evaluateContextV2Activation,
} = require("../../packages/context-compiler/src");
const { writeJsonAtomic } = require("./json-state");
const { LIMITED_CONTEXT_QUALIFICATION } = require("./context-v2-canonical");

const UNSTARTED_STATES = new Set(["queued", "ready", "pending", "planned", "created"]);

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function taskState(task) {
  return String(task.state || task.status || "").trim().toLowerCase();
}

function isUnstartedTask(task) {
  return UNSTARTED_STATES.has(taskState(task))
    && !task.started_at
    && !task.handoff_sent_at
    && (!Array.isArray(task.handoff_attempts) || task.handoff_attempts.length === 0)
    && (!Array.isArray(task.execution_cycles) || task.execution_cycles.length === 0)
    && (!Array.isArray(task.completion_evidence) || task.completion_evidence.length === 0);
}

function list(value, fallback = []) {
  return Array.isArray(value) && value.length ? value.filter((entry) => typeof entry === "string" && entry.trim()) : fallback;
}

function compileIntent(task) {
  const existing = task.task_intent;
  if (existing?.task_intent_id && existing?.desired_outcome && Array.isArray(existing.acceptance_criteria)) return clone(existing);
  return createTaskIntent({
    rawRequestRef: `context-v2-migration:${task.task_id}`,
    desiredOutcome: task.desired_outcome || task.title || `Complete ${task.task_id}`,
    acceptanceCriteria: list(task.acceptance_criteria || task.acceptance_checks, [
      `Produce verifiable completion evidence for ${task.task_id}.`,
    ]),
    constraints: list(task.constraints, ["Keep work within the approved project workspace." ]),
    risk: task.risk || { impact: "medium", reversible: true },
    authorityBoundary: task.authority_boundary || {
      agent_may: ["read approved context", "work inside the approved scope", "report evidence"],
      user_only: ["authorize external, destructive, or public actions"],
    },
    assumptions: list(task.assumptions, ["This migration does not change task ownership or scope."]),
    status: "compiled",
  });
}

function compileTask(task, projectUnderstanding) {
  const intent = compileIntent(task);
  const oldProfile = task.task_profile || {};
  const manifest = oldProfile.context_manifest || task.context_manifest || {};
  const scopes = list(task.scope_boundaries || manifest.allowed_files, ["."]);
  const result = createProfiledExecutionPlan({
    taskIntent: intent,
    workItem: {
      scope_boundaries: scopes,
      effects: list(task.effects || oldProfile.risk_profile?.effects, []),
      verification_method: task.verification_method || oldProfile.risk_profile?.verification,
      work_mode: task.work_mode || oldProfile.recommended_work_mode || "implementation",
      context_manifest: {
        required_reading: list(manifest.required_reading, ["canonical_task_record", ...scopes]),
        allowed_files: list(manifest.allowed_files, scopes),
        excluded_context: list(manifest.excluded_context, ["unrelated_project_context"]),
        missing_context_behavior: manifest.missing_context_behavior || "needs_context",
      },
      control_signals: oldProfile.control_signals || task.control_signals || {},
    },
    projectUnderstanding,
    capabilityNeeds: task.capability_needs || [],
    failureHistory: task.failure_history || [],
  });
  return { intent, profile: { ...clone(oldProfile), ...clone(result.task_profile) } };
}

function migrateContextV2(root, { apply = false, now = () => new Date().toISOString() } = {}) {
  const workspaceRoot = path.resolve(root);
  const stateRoot = path.join(workspaceRoot, ".orquesta", "state");
  const contextRoot = path.join(workspaceRoot, ".orquesta", "context");
  const tasksPath = path.join(stateRoot, "tasks.json");
  const tasksState = readJson(tasksPath, { version: 1, tasks: [] });
  const batchPath = path.join(workspaceRoot, ".orquesta", "setup", "provisioning_batch.json");
  const batch = readJson(batchPath, null);
  const projectUnderstanding = readJson(path.join(workspaceRoot, ".orquesta", "project", "project_understanding.json"), {});
  const existingCatalog = readJson(path.join(contextRoot, "source_catalog.json"), { version: 2, records: [] });
  const existingIndex = readJson(path.join(contextRoot, "shadow_index.json"), { version: 2, comparisons: [] });
  const timestamp = now();
  const artifacts = [];
  const skipped = [];

  for (const task of tasksState.tasks || []) {
    if (!isUnstartedTask(task)) {
      skipped.push({ task_id: task.task_id, reason: "task_already_started_or_terminal" });
      continue;
    }
    if (task.task_profile?.context_pack_id && task.task_profile?.context_route) {
      skipped.push({ task_id: task.task_id, reason: "already_bound" });
      continue;
    }
    const execution = compileTask(task, projectUnderstanding);
    const requirement = execution.profile.context_requirement;
    const envelope = execution.profile.task_envelope;
    const refs = [
      ...list(execution.profile.context_manifest?.required_reading, []),
      ...list(execution.profile.context_manifest?.allowed_files, []),
      ...(Array.isArray(projectUnderstanding.evidence)
        ? projectUnderstanding.evidence.map((entry) => entry?.path).filter((entry) => typeof entry === "string" && entry.trim())
        : []),
    ];
    const catalog = buildSourceCatalogV2({
      workspaceRoot,
      taskIntent: execution.intent,
      taskEnvelope: envelope,
      contextRequirement: requirement,
      sourceRefs: refs,
    });
    const compiled = compileContextPackV2Shadow({
      taskIntent: execution.intent,
      taskEnvelope: envelope,
      contextRequirement: requirement,
      agentCapabilityProfile: {
        agent_id: task.owner_agent_id || "unassigned-specialist",
        capabilities: [], availability: "available", organization_revision: 0,
      },
      sourceCatalog: catalog,
    });
    const route = {
      ...evaluateContextV2Activation({
        featureMode: "limited", contextRequirement: requirement,
        contextPack: compiled.context_pack, variantComparison: LIMITED_CONTEXT_QUALIFICATION,
      }),
      task_id: task.task_id,
      selected_source_refs: compiled.context_pack.selected_sources.map((sourceId) => (
        catalog.find((entry) => entry.source_id === sourceId)?.source_ref
      )).filter(Boolean).sort(),
      qualification_id: LIMITED_CONTEXT_QUALIFICATION.qualification_id,
      generated_at: timestamp,
    };
    artifacts.push({ task, execution, requirement, catalog, pack: compiled.context_pack, route });
  }

  const migratedIds = new Set(artifacts.map(({ task }) => task.task_id));
  const nextTasks = {
    ...tasksState,
    tasks: (tasksState.tasks || []).map((task) => {
      const artifact = artifacts.find((entry) => entry.task.task_id === task.task_id);
      if (!artifact) return task;
      return {
        ...task,
        task_intent: artifact.execution.intent,
        task_profile: {
          ...artifact.execution.profile,
          context_pack_id: artifact.pack.context_pack_id,
          context_route: artifact.route,
        },
      };
    }),
    updated_at: timestamp,
  };
  const nextBatch = batch ? {
    ...batch,
    requests: (batch.requests || []).map((request) => {
      if (!migratedIds.has(request.task_id)) return request;
      const task = nextTasks.tasks.find((entry) => entry.task_id === request.task_id);
      return { ...request, task_profile: clone(task.task_profile) };
    }),
    updated_at: timestamp,
  } : null;
  const catalogById = new Map((existingCatalog.records || []).map((entry) => [entry.source_id, entry]));
  for (const artifact of artifacts) for (const record of artifact.catalog) catalogById.set(record.source_id, record);
  const comparisonByTask = new Map((existingIndex.comparisons || []).map((entry) => [entry.task_id, entry]));
  for (const artifact of artifacts) comparisonByTask.set(artifact.task.task_id, {
    task_id: artifact.task.task_id,
    owner_agent_id: artifact.task.owner_agent_id || null,
    task_envelope_id: artifact.execution.profile.task_envelope.task_envelope_id,
    context_requirement_id: artifact.requirement.requirement_id,
    context_pack_id: artifact.pack.context_pack_id,
    migration_source: "unstarted_task_context_v2",
  });

  if (apply && artifacts.length) {
    for (const artifact of artifacts) {
      writeJsonAtomic(path.join(contextRoot, "requirements", `${artifact.requirement.requirement_id}.json`), artifact.requirement);
      writeJsonAtomic(path.join(contextRoot, "packs", `${artifact.pack.context_pack_id}.json`), artifact.pack);
      writeJsonAtomic(path.join(contextRoot, "activation", `${encodeURIComponent(artifact.task.task_id)}.json`), artifact.route);
    }
    writeJsonAtomic(path.join(contextRoot, "source_catalog.json"), { version: 2, records: [...catalogById.values()], updated_at: timestamp });
    writeJsonAtomic(path.join(contextRoot, "shadow_index.json"), { version: 2, mode: "limited", comparisons: [...comparisonByTask.values()], updated_at: timestamp });
    writeJsonAtomic(path.join(contextRoot, "variant_comparison.json"), LIMITED_CONTEXT_QUALIFICATION);
    if (!fs.existsSync(path.join(contextRoot, "project_control_plane.json"))) {
      writeJsonAtomic(path.join(contextRoot, "project_control_plane.json"), createProjectControlPlaneV2({
        projectId: projectUnderstanding.project_id || path.basename(workspaceRoot),
        revision: 1,
        projectBrief: { title: projectUnderstanding.project_name || path.basename(workspaceRoot), goal: projectUnderstanding.goal || "", source: "context_v2_migration" },
        updatedAt: timestamp,
      }));
    }
    if (nextBatch) writeJsonAtomic(batchPath, nextBatch);
    writeJsonAtomic(tasksPath, nextTasks);
  }
  return {
    status: apply ? "applied" : "dry_run",
    root: workspaceRoot,
    migrated_task_ids: [...migratedIds].sort(),
    skipped,
    changed: artifacts.length > 0,
  };
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

if (require.main === module) {
  try {
    const root = option(process.argv.slice(2), "--root") || process.cwd();
    const result = migrateContextV2(root, { apply: process.argv.includes("--apply") });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { UNSTARTED_STATES, isUnstartedTask, migrateContextV2 };

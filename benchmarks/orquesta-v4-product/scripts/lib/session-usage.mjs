import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const TOKEN_KEYS = [
  "input_tokens",
  "uncached_input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens"
];

function zeroUsage() {
  return Object.fromEntries(TOKEN_KEYS.map((key) => [key, 0]));
}

function normalizeUsage(value) {
  const result = zeroUsage();
  for (const key of TOKEN_KEYS) {
    result[key] = Number.isFinite(value?.[key]) && value[key] >= 0 ? value[key] : 0;
  }
  if (!Number.isFinite(value?.uncached_input_tokens)) {
    result.uncached_input_tokens = Math.max(
      0,
      result.input_tokens - result.cached_input_tokens
    );
  }
  return result;
}

function addUsage(target, value) {
  for (const key of TOKEN_KEYS) target[key] += value[key] || 0;
  return target;
}

function usageDelta(current, previous) {
  const reset = current.total_tokens < previous.total_tokens;
  const delta = zeroUsage();
  for (const key of TOKEN_KEYS) delta[key] = reset ? current[key] : Math.max(0, current[key] - previous[key]);
  return delta;
}

function normalizedPath(value) {
  return path.resolve(String(value || "")).replaceAll("/", path.sep).toLowerCase();
}

function matchesWorkspace(cwd, workspaceRoot) {
  const candidate = normalizedPath(cwd);
  const root = normalizedPath(workspaceRoot);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function listJsonl(root) {
  const result = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(target);
    }
  }
  await visit(root);
  return result.sort();
}

async function firstJsonLine(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8", start: 0, end: 1024 * 1024 - 1 });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return null;
}

async function lastSessionState(filePath) {
  const stat = await fsp.stat(filePath);
  const chunkSize = Math.min(stat.size, 64 * 1024 * 1024);
  if (chunkSize === 0) return { byte_offset: 0, totals: zeroUsage(), model: null, effort: null };
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(chunkSize);
    await handle.read(buffer, 0, chunkSize, stat.size - chunkSize);
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    let totals = null;
    let model = null;
    let effort = null;
    for (let index = lines.length - 1; index >= 0 && (!totals || !model); index -= 1) {
      let row;
      try {
        row = JSON.parse(lines[index]);
      } catch {
        continue;
      }
      if (!totals && row?.type === "event_msg" && row?.payload?.type === "token_count") totals = normalizeUsage(row.payload.info?.total_token_usage);
      if (!model && row?.type === "turn_context") {
        model = typeof row.payload?.model === "string" ? row.payload.model : null;
        effort = typeof row.payload?.effort === "string" ? row.payload.effort : null;
      }
    }
    return { byte_offset: stat.size, totals: totals || zeroUsage(), model, effort };
  } finally {
    await handle.close();
  }
}

async function sessionIdentity(filePath) {
  const first = await firstJsonLine(filePath);
  if (first?.type !== "session_meta") return null;
  const sessionId = first.payload?.id;
  const cwd = first.payload?.cwd;
  return typeof sessionId === "string" && typeof cwd === "string" ? { session_id: sessionId, cwd } : null;
}

export async function snapshotSessions({ sessionsRoot, workspaceRoot }) {
  const sessions = {};
  for (const filePath of await listJsonl(sessionsRoot)) {
    const identity = await sessionIdentity(filePath);
    if (!identity || !matchesWorkspace(identity.cwd, workspaceRoot)) continue;
    const state = await lastSessionState(filePath);
    sessions[identity.session_id] = {
      file: path.relative(sessionsRoot, filePath),
      cwd: identity.cwd,
      ...state
    };
  }
  return { captured_at: new Date().toISOString(), workspace_root: path.resolve(workspaceRoot), sessions };
}

async function scanDelta({ filePath, baseline, startedAt, endedAt }) {
  const previous = normalizeUsage(baseline?.totals);
  let currentModel = baseline?.model || null;
  let currentEffort = baseline?.effort || null;
  const byModel = {};
  const models = new Set();
  const efforts = new Set();
  const total = zeroUsage();
  let turnCount = 0;
  let parseErrors = 0;
  let unknownModelTokens = 0;
  const start = Date.parse(startedAt || "1970-01-01T00:00:00.000Z");
  const end = Date.parse(endedAt || "9999-12-31T23:59:59.999Z");
  const stream = fs.createReadStream(filePath, { encoding: "utf8", start: baseline?.byte_offset || 0 });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      parseErrors += 1;
      continue;
    }
    if (row?.type === "turn_context") {
      currentModel = typeof row.payload?.model === "string" ? row.payload.model : null;
      currentEffort = typeof row.payload?.effort === "string" ? row.payload.effort : null;
      if (currentModel) models.add(currentModel);
      if (currentEffort) efforts.add(currentEffort);
      const at = Date.parse(row.timestamp || "");
      if (Number.isFinite(at) && at >= start && at <= end) turnCount += 1;
      continue;
    }
    if (row?.type !== "event_msg" || row?.payload?.type !== "token_count") continue;
    const next = normalizeUsage(row.payload.info?.total_token_usage);
    const delta = usageDelta(next, previous);
    Object.assign(previous, next);
    if (delta.total_tokens === 0) continue;
    const at = Date.parse(row.timestamp || "");
    if (!Number.isFinite(at)) {
      parseErrors += 1;
      continue;
    }
    if (at < start || at > end) continue;
    addUsage(total, delta);
    if (!currentModel) {
      unknownModelTokens += delta.total_tokens;
      continue;
    }
    byModel[currentModel] ||= zeroUsage();
    addUsage(byModel[currentModel], delta);
  }
  return { totals: total, by_model: byModel, models: [...models].sort(), efforts: [...efforts].sort(), turn_count: turnCount, parse_errors: parseErrors, unknown_model_tokens: unknownModelTokens };
}

export async function measureSessionDelta({ baseline, sessionsRoot, workspaceRoot, startedAt, endedAt }) {
  const byThread = [];
  const byModel = {};
  const totals = zeroUsage();
  let turnCount = 0;
  let complete = true;

  for (const filePath of await listJsonl(sessionsRoot)) {
    const identity = await sessionIdentity(filePath);
    if (!identity || !matchesWorkspace(identity.cwd, workspaceRoot)) continue;
    const prior = baseline?.sessions?.[identity.session_id] || { byte_offset: 0, totals: zeroUsage(), model: null, effort: null };
    const delta = await scanDelta({ filePath, baseline: prior, startedAt, endedAt });
    if (delta.totals.total_tokens === 0 && !baseline?.sessions?.[identity.session_id]) continue;
    if (delta.parse_errors > 0 || delta.unknown_model_tokens > 0) complete = false;
    addUsage(totals, delta.totals);
    turnCount += delta.turn_count;
    for (const [model, usage] of Object.entries(delta.by_model)) {
      byModel[model] ||= zeroUsage();
      addUsage(byModel[model], usage);
    }
    byThread.push({
      thread_id: identity.session_id,
      measured_tokens: delta.totals.total_tokens,
      totals: delta.totals,
      by_model: delta.by_model,
      models: delta.models,
      efforts: delta.efforts,
      evidence_source: "codex_session_jsonl",
      evidence_ref: path.relative(sessionsRoot, filePath),
      parse_errors: delta.parse_errors
    });
  }

  const activeThreads = byThread.filter((thread) => thread.measured_tokens > 0);
  if (activeThreads.length === 0) return { coverage: "unknown", totals: null, by_thread: [], by_model: {}, turn_count: 0 };
  const modelTotal = Object.values(byModel).reduce((sum, usage) => sum + usage.total_tokens, 0);
  if (modelTotal !== totals.total_tokens) complete = false;
  return {
    coverage: complete ? "complete" : "partial",
    totals,
    by_thread: activeThreads.sort((a, b) => a.thread_id.localeCompare(b.thread_id)),
    by_model: byModel,
    turn_count: turnCount
  };
}

export async function measureSessionRootsDelta({
  roots,
  workspaceRoot,
  startedAt,
  endedAt
}) {
  const byThread = new Map();
  const duplicates = new Set();
  const byModel = {};
  const totals = zeroUsage();
  let turnCount = 0;
  let complete = true;

  for (const root of roots || []) {
    const measured = await measureSessionDelta({
      baseline: root.baseline,
      sessionsRoot: root.sessionsRoot,
      workspaceRoot,
      startedAt,
      endedAt
    });
    if (measured.coverage !== "complete") complete = false;
    turnCount += measured.turn_count || 0;
    for (const thread of measured.by_thread || []) {
      if (byThread.has(thread.thread_id)) {
        duplicates.add(thread.thread_id);
        continue;
      }
      byThread.set(thread.thread_id, {
        ...thread,
        source_root: root.label
      });
      addUsage(totals, thread.totals || zeroUsage());
      for (const [model, usage] of Object.entries(thread.by_model || {})) {
        byModel[model] ||= zeroUsage();
        addUsage(byModel[model], usage);
      }
    }
  }
  if (duplicates.size > 0) complete = false;
  if (byThread.size === 0) {
    return {
      coverage: "unknown",
      totals: null,
      by_thread: [],
      by_model: {},
      turn_count: 0,
      duplicate_thread_ids: []
    };
  }
  return {
    coverage: complete ? "complete" : "partial",
    totals,
    by_thread: [...byThread.values()].sort((a, b) => (
      a.thread_id.localeCompare(b.thread_id)
    )),
    by_model: byModel,
    turn_count: turnCount,
    duplicate_thread_ids: [...duplicates].sort()
  };
}

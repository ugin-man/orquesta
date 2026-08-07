"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { updateJsonAtomic, readJsonFile } = require("./json-state");

function requireRotationRuntime() {
  const candidates = [
    path.resolve(__dirname, "..", "..", "packages", "execution-kernel", "src"),
    path.resolve(__dirname, "..", "..", "..", "..", "packages", "execution-kernel", "src"),
    path.resolve(__dirname, "..", "runtime", "context-v2-runtime.cjs"),
  ];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      if (error?.code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error("orquesta_session_rotation_runtime_missing");
}

const {
  createSessionRotationRegistry,
  recordCompaction,
} = requireRotationRuntime();

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function safeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function findProjectRoot(cwd, explicitRoot = process.env.ORQUESTA_CANONICAL_ROOT) {
  if (safeString(explicitRoot)) {
    const candidate = path.resolve(explicitRoot);
    if (fs.existsSync(path.join(candidate, ".orquesta", "state", "sessions.json"))) return candidate;
  }
  let current = path.resolve(cwd || process.cwd());
  while (true) {
    if (fs.existsSync(path.join(current, ".orquesta", "state", "sessions.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function transcriptFingerprint(transcriptPath) {
  const filePath = safeString(transcriptPath);
  if (!filePath) return `missing:${Date.now()}:${process.pid}`;
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return `unavailable:${Date.now()}:${process.pid}`;
  }
}

function eventId(input, fingerprint) {
  const material = [input.session_id, input.turn_id, input.trigger, fingerprint].join("\0");
  return `compact:${crypto.createHash("sha256").update(material).digest("hex")}`;
}

function thresholdMessage(state, count) {
  if (state === "rotation_preparing") {
    return `Orquesta session health: compaction ${count}. Prepare canonical state and handoff evidence; do not rotate yet.`;
  }
  if (state === "rotation_pending") {
    return `Orquesta session health: compaction ${count}. Finish the current atomic work unit, then rotate at the next safe boundary.`;
  }
  if (state === "rotation_required") {
    return `Orquesta session health: compaction ${count}. Do not accept new work. Finish only the current atomic work unit and complete the verified session handoff.`;
  }
  return null;
}

function runHook(input, options = {}) {
  const payload = record(input);
  if (!payload || payload.hook_event_name !== "PostCompact") return { tracked: false, output: null };
  const sessionId = safeString(payload.session_id);
  if (!sessionId) return { tracked: false, output: null };
  const projectRoot = findProjectRoot(payload.cwd, options.projectRoot);
  if (!projectRoot) return { tracked: false, output: null };
  const sessionsPath = path.join(projectRoot, ".orquesta", "state", "sessions.json");
  const sessionsState = readJsonFile(sessionsPath, { sessions: [] });
  const sessions = Array.isArray(sessionsState.sessions) ? sessionsState.sessions : [];
  const mapped = sessions.find((session) => (
    safeString(session?.thread_id) === sessionId || safeString(session?.session_id) === sessionId
  ));
  if (!mapped || !safeString(mapped.agent_id)) return { tracked: false, output: null };

  const observedAt = options.now ? options.now() : new Date().toISOString();
  const fingerprint = transcriptFingerprint(payload.transcript_path);
  const registryPath = path.join(projectRoot, ".orquesta", "state", "session-rotation.json");
  let result;
  updateJsonAtomic(registryPath, createSessionRotationRegistry(), (current) => {
    result = recordCompaction(current, {
      event_id: eventId(payload, fingerprint),
      session_id: safeString(mapped.session_id) ?? sessionId,
      thread_id: safeString(mapped.thread_id) ?? sessionId,
      agent_id: safeString(mapped.agent_id),
      session_generation: Number.isInteger(mapped.session_generation) ? mapped.session_generation : 1,
      turn_id: safeString(payload.turn_id),
      trigger: payload.trigger === "manual" ? "manual" : "auto",
      transcript_path: safeString(payload.transcript_path),
      transcript_fingerprint: fingerprint,
      model: safeString(payload.model),
      observed_at: observedAt,
    });
    return result.registry;
  });
  const message = result && !result.duplicate
    ? thresholdMessage(result.threshold_crossed, result.session.compaction_count)
    : null;
  return {
    tracked: true,
    projectRoot,
    registryPath,
    session: result.session,
    duplicate: Boolean(result.duplicate),
    output: message ? { continue: true, systemMessage: message } : null,
  };
}

async function readStdin(stream = process.stdin) {
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
}

async function main() {
  const raw = await readStdin();
  const input = raw.trim() ? JSON.parse(raw) : {};
  const result = runHook(input);
  if (result.output) process.stdout.write(`${JSON.stringify(result.output)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  eventId,
  findProjectRoot,
  runHook,
  thresholdMessage,
  transcriptFingerprint,
};

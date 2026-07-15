"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
function sleep(ms) { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function removeArtifact(filePath, options = {}) {
  const retries = Number.isInteger(options.retries) ? options.retries : 4;
  for (let attempt = 0; ; attempt += 1) {
    try { fs.unlinkSync(filePath); return { removed: true, attempts: attempt + 1 }; }
    catch (error) {
      if (error.code === "ENOENT") return { removed: false, attempts: attempt + 1 };
      if (!TRANSIENT.has(error.code) || attempt >= retries) throw error;
      sleep(Math.min(100, 5 * (2 ** attempt)));
    }
  }
}

function assertProbeRoot(probeRoot, workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const probe = path.resolve(probeRoot);
  const v4Root = path.join(root, ".orquesta", "v4");
  if (!probe.startsWith(`${v4Root}${path.sep}`) || !path.basename(probe).startsWith(".probe-")) {
    throw Object.assign(new Error("Probe root is outside the allowed V4 workspace"), { code: "EVENT_PROBE_PATH_INVALID" });
  }
  if (fs.existsSync(probe) && fs.lstatSync(probe).isSymbolicLink()) {
    throw Object.assign(new Error("Probe root must not be a symlink or junction"), { code: "EVENT_PROBE_UNSAFE_ARTIFACT", path: probe });
  }
  return probe;
}

function removeProbeTree(probeRoot, workspaceRoot) {
  const probe = assertProbeRoot(probeRoot, workspaceRoot);
  const knownDirectories = new Set(["pending", "projections", "quarantine"]);
  function allowedFile(name, relativeDirectory) {
    if (relativeDirectory === "") return new Set(["events.jsonl", "events.jsonl.bak", "events.jsonl.lock"]).has(name) || /^events\.jsonl\.lock\.(transition|release)-[a-f0-9]+$/u.test(name);
    if (relativeDirectory === "pending") return /^[a-f0-9]{64}\.json(?:\.bak)?$/u.test(name) || /^\.[a-f0-9]{64}\.json\.\d+\.[a-f0-9]+\.tmp$/u.test(name);
    if (relativeDirectory === "projections") return new Set(["state.json", "state.json.bak"]).has(name) || /^\.state\.json\.\d+\.[a-f0-9]+\.tmp$/u.test(name);
    if (relativeDirectory === "quarantine") return /^events-[a-f0-9]{64}\.jsonl$/u.test(name) || /^pending-[a-f0-9]{64}\.json$/u.test(name);
    return false;
  }
  function clear(directory, relativeDirectory = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw Object.assign(new Error("Probe contains a symlink"), { code: "EVENT_PROBE_UNSAFE_ARTIFACT", path: target });
      if (entry.isDirectory()) {
        if (relativeDirectory || !knownDirectories.has(entry.name)) throw Object.assign(new Error("Probe contains an unknown directory"), { code: "EVENT_PROBE_UNSAFE_ARTIFACT", path: target });
        clear(target, entry.name); fs.rmdirSync(target);
      } else {
        if (!allowedFile(entry.name, relativeDirectory)) throw Object.assign(new Error("Probe contains an unknown file"), { code: "EVENT_PROBE_UNSAFE_ARTIFACT", path: target });
        removeArtifact(target);
      }
    }
  }
  clear(probe); fs.rmdirSync(probe); return { removed: true, path: probe };
}
module.exports = { removeArtifact, removeProbeTree };

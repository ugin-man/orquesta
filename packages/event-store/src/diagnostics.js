"use strict";
const crypto = require("node:crypto"); const fs = require("node:fs"); const path = require("node:path");
function digest(filePath) { if (!fs.existsSync(filePath)) return null; const stat = fs.statSync(filePath); return { path: filePath, size: stat.size, mtime_ms: stat.mtimeMs, sha256: crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex") }; }
function snapshot(stateRoot, journalPath, projectionPath) {
  const paths = [journalPath, `${journalPath}.bak`, `${journalPath}.lock`, projectionPath];
  for (const dir of ["pending", "quarantine"]) { const full = path.join(stateRoot, dir); if (fs.existsSync(full)) for (const name of fs.readdirSync(full)) paths.push(path.join(full, name)); }
  return paths.map(digest).filter(Boolean).sort((a, b) => a.path.localeCompare(b.path));
}
function recoveryId(snapshot) { return crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"); }
module.exports = { snapshot, recoveryId };

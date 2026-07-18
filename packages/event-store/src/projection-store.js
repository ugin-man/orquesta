"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalJson } = require("@orquesta/contracts");
const { replaceFileAtomic } = require("./atomic-replace");

function hash(value) { return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex"); }
function projectionPath(stateRoot) { return path.join(stateRoot, "projections", "state.json"); }
function replay(readJournal, journalPath, reducers = {}, initialState = {}) {
  const { entries, text } = readJournal(journalPath);
  let state = JSON.parse(canonicalJson(initialState));
  for (const batch of entries) for (const event of batch.events) if (typeof reducers[event.type] === "function") state = reducers[event.type](state, event, batch);
  const watermark = { journal_sequence: entries.length, last_batch_id: entries.at(-1)?.batch_id || null, journal_hash: crypto.createHash("sha256").update(text, "utf8").digest("hex") };
  return { state, watermark, hash: hash(state) };
}
function rebuild(readJournal, stateRoot, journalPath, reducers, initialState) {
  const result = replay(readJournal, journalPath, reducers, initialState);
  const wrapper = { projection_version: 1, ...result.watermark, data: result.state };
  const target = projectionPath(stateRoot); fs.mkdirSync(path.dirname(target), { recursive: true });
  replaceFileAtomic(target, `${canonicalJson(wrapper)}\n`);
  const reread = JSON.parse(fs.readFileSync(target, "utf8"));
  if (canonicalJson(reread) !== canonicalJson(wrapper)) throw Object.assign(new Error("Projection verification failed"), { code: "EVENT_PROJECTION_VERIFY_FAILED" });
  return result;
}
function listProjectionPaths(stateRoot) { const target = projectionPath(stateRoot); return fs.existsSync(target) ? [target] : []; }
module.exports = { replay, rebuild, listProjectionPaths, projectionPath };

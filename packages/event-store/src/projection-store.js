"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { canonicalJson } = require("@orquesta/contracts");
const { replaceFileAtomic } = require("./atomic-replace");

function hash(value) { return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex"); }
function projectionPath(stateRoot) { return path.join(stateRoot, "projections", "state.json"); }
function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}
function reducerFor(reducers, type) {
  return Object.hasOwn(reducers, type) && typeof reducers[type] === "function"
    ? reducers[type]
    : null;
}
function reduceEntries(entries, reducers, initialState) {
  let state = JSON.parse(canonicalJson(initialState));
  for (const batch of entries) {
    for (const event of batch.events) {
      const reducer = reducerFor(reducers, event.type);
      if (reducer) state = reducer(state, event, batch);
    }
  }
  return state;
}
function journalPrefix(text, sequence) {
  if (sequence === 0) return "";
  return `${text.slice(0, -1).split("\n").slice(0, sequence).join("\n")}\n`;
}
function cursorFor(entries, text, state) {
  return {
    journalSequence: entries.length,
    lastBatchId: entries.at(-1)?.batch_id || null,
    journalHash: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
    projectionHash: hash(state),
  };
}
function validateCursor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !Number.isSafeInteger(value.journalSequence) || value.journalSequence < 0
      || (value.lastBatchId !== null && typeof value.lastBatchId !== "string")
      || typeof value.journalHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.journalHash)
      || typeof value.projectionHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.projectionHash)) {
    throw failure("EVENT_CURSOR_INVALID", "The source cursor is malformed");
  }
  return value;
}
function continuityFor(afterCursor, entries, text, reducers, initialState, currentCursor) {
  if (afterCursor === null || afterCursor === undefined) return "initial";
  const previous = validateCursor(afterCursor);
  if (currentCursor.journalSequence < previous.journalSequence) return "rewound";
  if (currentCursor.journalSequence === previous.journalSequence) {
    return canonicalJson(currentCursor) === canonicalJson(previous) ? "unchanged" : "diverged";
  }
  const prefixEntries = entries.slice(0, previous.journalSequence);
  const prefixState = reduceEntries(prefixEntries, reducers, initialState);
  const prefixCursor = cursorFor(
    prefixEntries,
    journalPrefix(text, previous.journalSequence),
    prefixState,
  );
  return canonicalJson(prefixCursor) === canonicalJson(previous) ? "advanced" : "diverged";
}
function replay(readJournal, journalPath, reducers = {}, initialState = {}, options = {}) {
  const { entries, text } = readJournal(journalPath);
  const claimedPrefixes = Array.isArray(options.claimedEventPrefixes)
    ? options.claimedEventPrefixes
    : [];
  for (const batch of entries) for (const event of batch.events) {
    if (!reducerFor(reducers, event.type)
        && claimedPrefixes.some((prefix) => event.type.startsWith(prefix))) {
      throw failure(
        "EVENT_PROJECTION_EVENT_UNSUPPORTED",
        `The projection does not support claimed event type: ${event.type}`,
        { event_type: event.type },
      );
    }
  }
  const state = reduceEntries(entries, reducers, initialState);
  const watermark = { journal_sequence: entries.length, last_batch_id: entries.at(-1)?.batch_id || null, journal_hash: crypto.createHash("sha256").update(text, "utf8").digest("hex") };
  const cursor = cursorFor(entries, text, state);
  return {
    state,
    watermark,
    hash: cursor.projectionHash,
    cursor,
    continuity: continuityFor(options.afterCursor, entries, text, reducers, initialState, cursor),
  };
}
function rebuild(readJournal, stateRoot, journalPath, reducers, initialState, options = {}) {
  const result = replay(readJournal, journalPath, reducers, initialState);
  const wrapper = { projection_version: 1, ...result.watermark, data: result.state };
  const target = projectionPath(stateRoot); fs.mkdirSync(path.dirname(target), { recursive: true });
  replaceFileAtomic(target, `${canonicalJson(wrapper)}\n`, {
    onBeforeRename() {
      if (typeof options.onBeforePublish === "function") options.onBeforePublish(result);
    },
  });
  const reread = JSON.parse(fs.readFileSync(target, "utf8"));
  if (canonicalJson(reread) !== canonicalJson(wrapper)) throw Object.assign(new Error("Projection verification failed"), { code: "EVENT_PROJECTION_VERIFY_FAILED" });
  if (typeof options.onAfterPublish === "function") options.onAfterPublish(result);
  return result;
}
function listProjectionPaths(stateRoot) { const target = projectionPath(stateRoot); return fs.existsSync(target) ? [target] : []; }
module.exports = { replay, rebuild, listProjectionPaths, projectionPath };

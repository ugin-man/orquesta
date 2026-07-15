const crypto = require("node:crypto");

function normalize(value, seen = new Set()) {
  if (value === undefined) throw new TypeError("canonical JSON does not allow undefined");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON requires finite numbers");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, seen));
  if (typeof value !== "object") throw new TypeError(`canonical JSON does not allow ${typeof value}`);
  if (seen.has(value)) throw new TypeError("canonical JSON does not allow circular references");
  seen.add(value);
  const normalized = {};
  for (const key of Object.keys(value).sort()) normalized[key] = normalize(value[key], seen);
  seen.delete(value);
  return normalized;
}

function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

function canonicalHash(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

module.exports = { canonicalJson, canonicalHash };

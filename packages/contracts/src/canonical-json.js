const crypto = require("node:crypto");

function normalize(value, stack = new Set()) {
  if (value === undefined) throw new TypeError("canonical JSON does not allow undefined");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON requires finite numbers");
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`canonical JSON does not allow ${typeof value}`);
  if (stack.has(value)) throw new TypeError("canonical JSON does not allow circular references");
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("canonical JSON does not allow symbol-keyed objects");
  }

  stack.add(value);
  try {
    if (Array.isArray(value)) {
      for (const key of Object.getOwnPropertyNames(value)) {
        if (key === "length") continue;
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
          throw new TypeError("canonical JSON does not allow non-index array properties");
        }
      }
      const normalized = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError("canonical JSON does not allow sparse arrays");
        normalized.push(normalize(value[index], stack));
      }
      return normalized;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON only allows plain objects");
    }
    const normalized = Object.create(null);
    for (const key of Object.keys(value).sort()) normalized[key] = normalize(value[key], stack);
    return normalized;
  } finally {
    stack.delete(value);
  }
}

function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

function canonicalHash(value) {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

module.exports = { canonicalJson, canonicalHash };

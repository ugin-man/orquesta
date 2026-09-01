"use strict";

const path = require("node:path");

function normalizeRef(value) {
  if (typeof value !== "string") throw new TypeError("path reference must be a string");
  const slashed = value.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (!slashed || slashed === ".") return ".";
  const normalized = path.posix.normalize(slashed).replace(/^\/+|\/+$/gu, "");
  if (!normalized || normalized === ".") return ".";
  if (normalized === ".." || normalized.startsWith("../") || /^[A-Za-z]:\//u.test(normalized)) {
    throw new RangeError(`path reference escapes the project: ${value}`);
  }
  return normalized;
}

function escapeRegexCharacter(character) {
  return /[|\\{}()[\]^$+?.]/u.test(character) ? `\\${character}` : character;
}

function globToRegExp(pattern) {
  const source = String(pattern || "").replace(/\\/gu, "/").replace(/^\.\//u, "");
  let output = "^";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "*" && source[index + 1] === "*") {
      if (source[index + 2] === "/") {
        output += "(?:.*/)?";
        index += 2;
      } else {
        output += ".*";
        index += 1;
      }
    } else if (character === "*") {
      output += "[^/]*";
    } else if (character === "?") {
      output += "[^/]";
    } else {
      output += escapeRegexCharacter(character);
    }
  }
  output += "$";
  return new RegExp(output, "u");
}

const cache = new Map();

function matchesGlob(reference, pattern) {
  const ref = normalizeRef(reference);
  const rawPattern = String(pattern || "").replace(/\\/gu, "/").replace(/^\.\//u, "");
  const variants = [rawPattern];
  if (rawPattern.endsWith("/**")) variants.push(rawPattern.slice(0, -3));
  return variants.some((variant) => {
    const key = variant;
    if (!cache.has(key)) cache.set(key, globToRegExp(variant));
    return cache.get(key).test(ref);
  });
}

function matchesAny(reference, patterns) {
  return (Array.isArray(patterns) ? patterns : []).some((pattern) => matchesGlob(reference, pattern));
}

function relativeToRoot(reference, root) {
  const ref = normalizeRef(reference);
  const normalizedRoot = normalizeRef(root);
  if (normalizedRoot === ".") return ref;
  if (ref === normalizedRoot) return ".";
  if (!ref.startsWith(`${normalizedRoot}/`)) return null;
  return ref.slice(normalizedRoot.length + 1);
}

module.exports = {
  globToRegExp,
  matchesAny,
  matchesGlob,
  normalizeRef,
  relativeToRoot,
};

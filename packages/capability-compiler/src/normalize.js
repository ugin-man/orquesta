"use strict";

function normalizeText(value) {
  if (typeof value !== "string") throw new TypeError("Capability compiler text must be a string");
  return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

module.exports = { normalizeText, compareText };

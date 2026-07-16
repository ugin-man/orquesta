"use strict";

function createLiveSourceConnector({ id, trustTier, transport, search } = {}) {
  if (typeof id !== "string" || !id) throw new TypeError("Live source connector requires an id.");
  if (typeof trustTier !== "string" || !trustTier) throw new TypeError("Live source connector requires a trustTier.");
  if (!transport || typeof transport.request !== "function") throw new TypeError("Live source connector requires an injected transport.");
  if (typeof search !== "function") throw new TypeError("Live source connector requires a search function.");
  return Object.freeze({
    id,
    trustTier,
    async search(input) {
      return search({ ...input, transport });
    }
  });
}

module.exports = { createLiveSourceConnector };

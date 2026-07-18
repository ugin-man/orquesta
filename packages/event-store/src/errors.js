"use strict";

function eventStoreError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "EventStoreError";
  error.code = code;
  error.details = details;
  return error;
}

module.exports = { eventStoreError };

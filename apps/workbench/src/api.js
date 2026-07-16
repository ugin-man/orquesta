"use strict";

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${JSON.stringify(value)}\n`);
}

function sendError(response, error) {
  sendJson(response, error.statusCode || 500, { error: error.code || "V4_REQUEST_FAILED", message: error.message || "Request failed." });
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      const error = new Error("POST requests require application/json.");
      error.code = "V4_JSON_REQUIRED";
      error.statusCode = 415;
      fail(error);
      return;
    }
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error("Request body exceeds 1 MiB.");
        error.code = "V4_BODY_TOO_LARGE";
        error.statusCode = 413;
        chunks.length = 0;
        fail(error);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON body must be an object.");
        settled = true;
        resolve(parsed);
      } catch (cause) {
        const error = new Error(cause.message);
        error.code = "V4_JSON_INVALID";
        error.statusCode = 400;
        fail(error);
      }
    });
    request.on("error", fail);
  });
}

function createApiHandler({ service, origin } = {}) {
  return async function handle(request, response) {
    try {
      const url = new URL(request.url, origin());
      if (request.method === "GET" && url.pathname === "/api/v4/state") {
        sendJson(response, 200, service.state());
        return;
      }
      if (request.method === "POST") {
        if (request.headers.origin !== origin()) {
          const error = new Error("Origin does not match this Workbench instance.");
          error.code = "V4_ORIGIN_REJECTED";
          error.statusCode = 403;
          throw error;
        }
        await readJsonBody(request);
        const fixtureMatch = url.pathname.match(/^\/api\/v4\/fixtures\/([a-z0-9-]+)\/load$/u);
        if (fixtureMatch) {
          sendJson(response, 200, service.load(fixtureMatch[1]));
          return;
        }
        if (url.pathname === "/api/v4/replay") {
          sendJson(response, 200, service.replay());
          return;
        }
      }
      sendJson(response, 404, { error: "V4_ROUTE_NOT_FOUND", message: "Route not found." });
    } catch (error) {
      if (!response.headersSent) sendError(response, error);
    }
  };
}

module.exports = { MAX_BODY_BYTES, createApiHandler, readJsonBody };

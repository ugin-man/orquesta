#!/usr/bin/env node
"use strict";

const http = require("node:http");
const path = require("node:path");

const { findAvailableDashboardPort } = require("../../orquesta/scripts/dashboard-port-selection");
const { createApiHandler } = require("./src/api");
const { createWorkbenchService } = require("./src/service");

function workbenchError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function startWorkbench({ feature, stateRoot = path.resolve("output/v4-workbench-state"), port = 4181 } = {}) {
  if (feature !== "v4") throw workbenchError("V4_FEATURE_FLAG_REQUIRED", "Start the Workbench with --feature v4.");
  const host = "127.0.0.1";
  const selectedPort = port === 0
    ? 0
    : (await findAvailableDashboardPort({ host, preferredPort: port, scanStart: 4181, scanEnd: 4281 })).port;
  const service = createWorkbenchService({ stateRoot: path.resolve(stateRoot) });
  let url = null;
  const server = http.createServer(createApiHandler({ service, origin: () => url }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(selectedPort, host, resolve);
  });
  const address = server.address();
  url = `http://${host}:${address.port}`;
  return {
    url,
    port: address.port,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--feature") options.feature = argv[++index];
    else if (flag === "--port") options.port = Number.parseInt(argv[++index], 10);
    else if (flag === "--state-root") options.stateRoot = argv[++index];
    else throw workbenchError("V4_ARGUMENT_UNKNOWN", `Unknown argument: ${flag}`);
  }
  return options;
}

if (require.main === module) {
  startWorkbench(parseArgs(process.argv.slice(2))).then((app) => {
    process.stdout.write(`Orquesta V4 Workbench: ${app.url}/\n`);
  }).catch((error) => {
    process.stderr.write(`${error.code || "V4_WORKBENCH_FAILED"}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, startWorkbench };

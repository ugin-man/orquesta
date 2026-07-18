#!/usr/bin/env node
"use strict";

const path = require("node:path");

const { runBrowserSmoke } = require("./browser-smoke");

const repositoryRoot = path.resolve(__dirname, "../../..");
const outputRoot = path.resolve(process.argv[2] || path.join(repositoryRoot, "output", "v4-phase1-review"));

runBrowserSmoke({
  outputRoot,
  stateRoot: path.join(repositoryRoot, "output", "v4-review-capture-state"),
}).then((evidence) => {
  process.stdout.write(`Orquesta V4 review capture ready: ${evidence.screenshots.desktop.path}, ${evidence.screenshots.mobile.path}\n`);
}).catch((error) => {
  process.stderr.write(`${error.code || "V4_REVIEW_CAPTURE_FAILED"}: ${error.message}\n`);
  process.exitCode = 1;
});

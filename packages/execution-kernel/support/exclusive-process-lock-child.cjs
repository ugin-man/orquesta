"use strict";

const fs = require("node:fs");
const {
  acquireExclusiveProcessLock,
  releaseExclusiveProcessLock,
} = require("../src/exclusive-process-lock-v1");

const [rootPath, lockPath, markerPath, mode = "hold"] = process.argv.slice(2);

try {
  const lock = acquireExclusiveProcessLock({ rootPath, lockPath, codePrefix: "LOCK_PROBE" });
  fs.appendFileSync(markerPath, `${process.pid}\n`, "utf8");
  process.stdout.write(`acquired:${JSON.stringify(fs.readdirSync(require("node:path").dirname(lockPath)).sort())}\n`);
  if (mode === "crash") process.exit(0);
  setTimeout(() => {
    releaseExclusiveProcessLock(lock);
    process.exit(0);
  }, 500);
} catch (error) {
  if (error?.code === "LOCK_PROBE_LOCKED") {
    process.stdout.write("locked\n");
    process.exit(2);
  }
  process.stderr.write(`${error?.code || "ERROR"}:${error?.message || error}\n`);
  process.exit(1);
}

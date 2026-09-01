"use strict";

const { readdirSync } = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const testRoot = __dirname;
const linuxOnlyFiles = new Set([
  "canonical-reactor.test.js",
  "packet-store.test.js",
  "posix-platform-adapters.test.js",
  "presend-failure-recorder.test.js",
  "recorded-fake-provider.test.js",
  "send-authorization.test.js",
]);

const allTests = readdirSync(testRoot)
  .filter((name) => name.endsWith(".test.js"))
  .sort();

for (const name of linuxOnlyFiles) {
  if (!allTests.includes(name)) {
    throw new Error(`Linux-only Business test classification is stale: ${name}`);
  }
}

const linuxRequired = process.argv.includes("--linux-required");
if (linuxRequired && process.platform !== "linux") {
  console.error("Business production-mutation tests require Linux POSIX primitives.");
  process.exitCode = 1;
} else {
  const selectedTests = process.platform === "linux"
    ? allTests
    : allTests.filter((name) => !linuxOnlyFiles.has(name));

  if (process.platform !== "linux") {
    console.error(
      `Business portable suite: ${selectedTests.length} files; ${linuxOnlyFiles.size} Linux-only files remain an explicit external gate.`,
    );
  } else {
    console.error(`Business full Linux suite: ${selectedTests.length} files.`);
  }

  const result = spawnSync(
    process.execPath,
    ["--test", ...selectedTests.map((name) => path.join(testRoot, name))],
    { stdio: "inherit" },
  );

  if (result.error) throw result.error;
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
}

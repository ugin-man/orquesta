"use strict";

const {
  createDispatchPacketStorePosixPlatformAdapter,
} = require("../../src/posix-platform-adapters");

function writeLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const [mode, rootPath, holdText, hashCharacter = "c"] = process.argv.slice(2);
  const holdMs = Number(holdText || 0);
  const adapter = createDispatchPacketStorePosixPlatformAdapter({
    lock_timeout_ms: 5_000,
    lock_poll_interval_ms: 5,
  });
  const session = await adapter.openStore({ root_path: rootPath });
  writeLine({ event: "acquired", monotonic_ms: Math.trunc(performance.now()) });

  if (mode === "crash-with-temp") {
    const target = `dispatch-packet-${hashCharacter.repeat(64)}.json`;
    const temp = `.${target}.${"d".repeat(48)}.tmp`;
    const file = await adapter.openTempExclusive({
      store_handle: session.handle,
      name: temp,
      mode: 0o600,
    });
    await adapter.writeAll({ file_handle: file, bytes: Buffer.from("interrupted", "utf8") });
    await adapter.fsyncFile({ file_handle: file });
    await adapter.closeFile({ file_handle: file });
    writeLine({ event: "temp-fsynced", temp });
    process.exit(23);
  }

  if (mode !== "hold") throw new Error(`unknown child mode: ${mode}`);
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  await adapter.closeStore({ store_handle: session.handle });
  writeLine({ event: "released", monotonic_ms: Math.trunc(performance.now()) });
}

if (["hold", "crash-with-temp"].includes(process.argv[2])) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

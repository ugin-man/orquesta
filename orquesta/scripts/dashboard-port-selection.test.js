#!/usr/bin/env node

const assert = require("assert");
const net = require("net");
const {
  findAvailableDashboardPort,
  normalizePort
} = require("./dashboard-port-selection");

const host = "127.0.0.1";

function canBindLocal(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function findConsecutiveFreePorts(count) {
  for (let start = 32000; start < 52000; start += 10) {
    const candidates = Array.from({ length: count }, (_, index) => start + index);
    const free = await Promise.all(candidates.map((port) => canBindLocal(port)));
    if (free.every(Boolean)) return candidates;
  }
  throw new Error(`Could not find ${count} consecutive free test ports`);
}

function reservePort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function testSkipsOccupiedPreferredPort() {
  const [preferred, fallback] = await findConsecutiveFreePorts(2);
  const occupied = await reservePort(preferred);
  try {
    const result = await findAvailableDashboardPort({
      host,
      preferredPort: preferred,
      scanStart: preferred,
      scanEnd: fallback,
      allowEphemeral: false
    });

    assert.strictEqual(result.port, fallback);
    assert.strictEqual(result.source, "scanned");
    assert.deepStrictEqual(result.conflicts, [preferred]);
    assert.deepStrictEqual(result.checkedPorts, [preferred, fallback]);
  } finally {
    await closeServer(occupied);
  }
}

async function testPrefersPreviousProjectPort() {
  const [preferred, previous] = await findConsecutiveFreePorts(2);
  const result = await findAvailableDashboardPort({
    host,
    preferredPort: preferred,
    previousPort: previous,
    scanStart: preferred,
    scanEnd: preferred + 3,
    allowEphemeral: false
  });

  assert.strictEqual(result.port, previous);
  assert.strictEqual(result.source, "previous");
  assert.deepStrictEqual(result.checkedPorts, [previous]);
}

async function main() {
  assert.strictEqual(normalizePort(null), null);
  assert.strictEqual(normalizePort(""), null);
  assert.strictEqual(normalizePort("0"), null);
  assert.strictEqual(normalizePort("4177"), 4177);
  await testSkipsOccupiedPreferredPort();
  await testPrefersPreviousProjectPort();
  console.log("dashboard port selection tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

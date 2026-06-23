const net = require("net");

const DEFAULT_DASHBOARD_HOST = "127.0.0.1";
const DEFAULT_DASHBOARD_PORT = 4177;
const DEFAULT_SCAN_LIMIT = 100;

function normalizePort(value) {
  if (value === null || value === undefined || value === "") return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function uniquePush(items, item) {
  if (!items.some((existing) => existing.port === item.port)) items.push(item);
}

function canBindPort(port, host = DEFAULT_DASHBOARD_HOST) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

function selectEphemeralPort(host = DEFAULT_DASHBOARD_HOST) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.once("listening", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
    server.listen(0, host);
  });
}

function buildDashboardPortCandidates(options = {}) {
  const preferredPort = normalizePort(options.preferredPort) ?? DEFAULT_DASHBOARD_PORT;
  const previousPort = normalizePort(options.previousPort);
  const scanStart = normalizePort(options.scanStart) ?? preferredPort;
  const scanEnd = normalizePort(options.scanEnd) ?? (scanStart + DEFAULT_SCAN_LIMIT);
  const start = Math.min(scanStart, scanEnd);
  const end = Math.max(scanStart, scanEnd);
  const candidates = [];

  if (previousPort !== null) uniquePush(candidates, { port: previousPort, source: "previous" });
  uniquePush(candidates, { port: preferredPort, source: "preferred" });
  for (let port = start; port <= end && port <= 65535; port += 1) {
    uniquePush(candidates, { port, source: "scanned" });
  }

  return candidates;
}

async function findAvailableDashboardPort(options = {}) {
  const host = options.host || DEFAULT_DASHBOARD_HOST;
  const candidates = buildDashboardPortCandidates(options);
  const checkedPorts = [];
  const conflicts = [];

  for (const candidate of candidates) {
    checkedPorts.push(candidate.port);
    if (await canBindPort(candidate.port, host)) {
      return {
        port: candidate.port,
        host,
        source: candidate.source,
        checkedPorts,
        conflicts
      };
    }
    conflicts.push(candidate.port);
  }

  if (options.allowEphemeral !== false) {
    const port = await selectEphemeralPort(host);
    return {
      port,
      host,
      source: "ephemeral",
      checkedPorts,
      conflicts
    };
  }

  throw new Error(`No available Orquesta dashboard port in ${checkedPorts.join(", ")}`);
}

module.exports = {
  DEFAULT_DASHBOARD_HOST,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_SCAN_LIMIT,
  buildDashboardPortCandidates,
  canBindPort,
  findAvailableDashboardPort,
  normalizePort
};

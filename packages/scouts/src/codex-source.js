"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SKILL_READ_LIMIT = 16 * 1024;
const PLUGIN_READ_LIMIT = 64 * 1024;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRef(value) {
  return value.split(path.sep).join("/");
}

function walkRegularFiles(rootPath, predicate) {
  if (!fs.existsSync(rootPath)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name))) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && predicate(entryPath)) files.push(entryPath);
    }
  };
  visit(rootPath);
  return files;
}

function readFrontmatterPrefix(filePath, limit) {
  const handle = fs.openSync(filePath, "r");
  try {
    const byte = Buffer.alloc(1);
    const bytes = [];
    let currentLine = [];
    let lineNumber = 0;
    while (bytes.length < limit) {
      const bytesRead = fs.readSync(handle, byte, 0, 1, bytes.length);
      if (!bytesRead) break;
      const value = byte[0];
      bytes.push(value);
      if (value !== 0x0a) {
        currentLine.push(value);
        continue;
      }
      const line = Buffer.from(currentLine).toString("utf8").replace(/\r$/, "");
      if (lineNumber === 0 && line !== "---") return null;
      if (lineNumber > 0 && line === "---") return Buffer.from(bytes).toString("utf8");
      currentLine = [];
      lineNumber += 1;
    }
    const finalLine = Buffer.from(currentLine).toString("utf8").replace(/\r$/, "");
    if (lineNumber > 0 && finalLine === "---") return Buffer.from(bytes).toString("utf8");
    return null;
  } finally {
    fs.closeSync(handle);
  }
}

function scalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readSkillFrontmatter(filePath) {
  const prefix = readFrontmatterPrefix(filePath, SKILL_READ_LIMIT);
  if (prefix === null) return null;
  const lines = prefix.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const closingIndex = lines.indexOf("---", 1);
  if (closingIndex < 0) return null;
  const metadata = {};
  for (const line of lines.slice(1, closingIndex)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match && (match[1] === "name" || match[1] === "description")) metadata[match[1]] = scalar(match[2]);
  }
  if (!metadata.name) return null;
  return { name: metadata.name, description: metadata.description || "" };
}

function readBoundedJson(filePath, limit) {
  const stat = fs.statSync(filePath);
  if (stat.size > limit) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function collectSkillMetadata(codexHome) {
  const skillRoot = path.join(codexHome, "skills");
  const files = walkRegularFiles(skillRoot, (filePath) => path.basename(filePath) === "SKILL.md");
  const providers = [];
  for (const filePath of files) {
    const metadata = readSkillFrontmatter(filePath);
    if (!metadata) continue;
    const sourceRef = normalizeRef(path.relative(codexHome, filePath));
    providers.push({
      provider_id: `codex-skill:${metadata.name}`,
      provider_type: "codex_skill",
      source_type: "codex_skill",
      source_ref: sourceRef,
      source_uri: `codex-home:${sourceRef}`,
      name: metadata.name,
      description: metadata.description,
      capabilities: [metadata.description || `Codex skill ${metadata.name}`],
      trust_tier: "local",
      availability: "available",
      version: "local",
      evidence_refs: [`codex-home:${sourceRef}#frontmatter`]
    });
  }
  return {
    source: { source_type: "codex_skill", source_ref: "skills/**/SKILL.md#frontmatter", status: files.length ? "available" : "absent", count: providers.length },
    providers
  };
}

function collectPluginMetadata(codexHome) {
  const pluginRoot = path.join(codexHome, "plugins");
  const files = walkRegularFiles(
    pluginRoot,
    (filePath) => path.basename(filePath) === "plugin.json" && path.basename(path.dirname(filePath)) === ".codex-plugin"
  );
  const providers = [];
  for (const filePath of files) {
    const manifest = readBoundedJson(filePath, PLUGIN_READ_LIMIT);
    if (!manifest || typeof manifest !== "object") continue;
    const id = typeof manifest.id === "string" && manifest.id
      ? manifest.id
      : typeof manifest.name === "string" && manifest.name
        ? manifest.name
        : null;
    if (!id) continue;
    const sourceRef = normalizeRef(path.relative(codexHome, filePath));
    const name = typeof manifest.name === "string" ? manifest.name : id;
    const description = typeof manifest.description === "string" ? manifest.description : "";
    providers.push({
      provider_id: `codex-plugin:${id}`,
      provider_type: "codex_plugin",
      source_type: "codex_plugin",
      source_ref: sourceRef,
      source_uri: `codex-home:${sourceRef}`,
      name,
      description,
      capabilities: [description || `Codex plugin ${name}`],
      trust_tier: "local",
      availability: "available",
      version: typeof manifest.version === "string" && manifest.version ? manifest.version : "local",
      evidence_refs: [`codex-home:${sourceRef}`]
    });
  }
  return {
    source: { source_type: "codex_plugin", source_ref: "plugins/**/.codex-plugin/plugin.json", status: files.length ? "available" : "absent", count: providers.length },
    providers
  };
}

function collectMcpMetadata(codexHome) {
  const configPath = path.join(codexHome, "config.toml");
  if (!fs.existsSync(configPath)) {
    return {
      source: { source_type: "codex_mcp", source_ref: "config.toml#mcp_servers", status: "absent", count: 0 },
      providers: []
    };
  }
  const lines = fs.readFileSync(configPath, "utf8").split(/\r?\n/);
  const servers = [];
  let current = null;
  const flush = () => {
    if (current) servers.push(current);
    current = null;
  };
  for (const line of lines) {
    const section = /^\s*\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$/.exec(line);
    if (section) {
      flush();
      current = { name: section[1], transport: "unknown", redacted: false };
      continue;
    }
    if (/^\s*\[/.test(line)) {
      flush();
      continue;
    }
    if (!current) continue;
    if (/^\s*url\s*=/.test(line)) current.transport = "http";
    else if (/^\s*command\s*=/.test(line) && current.transport === "unknown") current.transport = "stdio";
    if (/^\s*(args|env|token|headers|authorization)\s*=/.test(line) || /\?/.test(line)) current.redacted = true;
  }
  flush();

  const providers = servers
    .sort((left, right) => compareText(left.name, right.name))
    .map((server) => ({
      provider_id: `codex-mcp:${server.name}`,
      provider_type: "codex_mcp",
      source_type: "codex_mcp",
      source_ref: "config.toml",
      source_uri: "codex-home:config.toml#mcp_servers",
      name: server.name,
      transport: server.transport,
      redaction_status: server.redacted ? "redacted" : "not_present",
      capabilities: [`${server.transport} MCP server`],
      trust_tier: "local",
      availability: "available",
      version: "local",
      evidence_refs: [`codex-home:config.toml#mcp_servers.${server.name}`]
    }));
  return {
    source: { source_type: "codex_mcp", source_ref: "config.toml#mcp_servers", status: providers.length ? "available" : "absent", count: providers.length },
    providers
  };
}

function collectCodexSources({ codexHome }) {
  const skill = collectSkillMetadata(codexHome);
  const plugin = collectPluginMetadata(codexHome);
  const mcp = collectMcpMetadata(codexHome);
  return {
    sources: [skill.source, plugin.source, mcp.source],
    providers: [...skill.providers, ...plugin.providers, ...mcp.providers]
  };
}

module.exports = { collectCodexSources };

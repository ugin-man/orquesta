import fs from "node:fs/promises";
import path from "node:path";

const MODES = new Set(["plain", "skills", "orquesta"]);
const PLAIN_DISABLED_FEATURES = [
  "apps",
  "memories",
  "multi_agent",
  "plugins"
];

export function sharedExecutionContract() {
  return {
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    sandbox: "workspace-write",
    approval_policy: "never",
    agent_timeout_sec: 900,
    verifier_timeout_sec: 60
  };
}

function appServerArgs(disabledFeatures) {
  return [
    ...disabledFeatures.flatMap((feature) => ["--disable", feature]),
    "app-server"
  ];
}

function plainConfig(contract, workspaceRoot) {
  const features = PLAIN_DISABLED_FEATURES
    .map((feature) => `${feature} = false`)
    .join("\n");
  const lines = [
    `model = "${contract.model}"`,
    `model_reasoning_effort = "${contract.reasoning_effort}"`,
    `sandbox_mode = "${contract.sandbox}"`,
    `approval_policy = "${contract.approval_policy}"`,
    "",
    "[features]",
    features,
    "",
    "[windows]",
    "sandbox = \"elevated\"",
    ""
  ];
  if (workspaceRoot) {
    const trustedPath = process.platform === "win32"
      ? path.resolve(workspaceRoot).toLowerCase()
      : path.resolve(workspaceRoot);
    lines.push(
      `[projects.${JSON.stringify(trustedPath)}]`,
      "trust_level = \"trusted\"",
      ""
    );
  }
  return lines.join("\n");
}

async function preparePlainHome({
  currentCodexHome,
  tempRoot,
  contract,
  workspaceRoot
}) {
  const sourceAuth = path.join(currentCodexHome, "auth.json");
  const authStat = await fs.stat(sourceAuth).catch(() => null);
  if (!authStat?.isFile()) throw new Error("current Codex auth.json is unavailable");

  const codexHome = path.join(tempRoot, "plain-codex-home");
  for (const directory of [".sandbox", ".sandbox-bin", ".sandbox-secrets"]) {
    const target = path.join(codexHome, directory);
    const stat = await fs.lstat(target).catch(() => null);
    if (stat?.isSymbolicLink()) await fs.unlink(target);
  }
  await fs.rm(codexHome, { recursive: true, force: true });
  await fs.mkdir(codexHome, { recursive: true });
  try {
    await fs.link(sourceAuth, path.join(codexHome, "auth.json"));
  } catch (error) {
    throw new Error(`unable to create a safe auth hard link: ${error.message}`);
  }
  for (const directory of [".sandbox", ".sandbox-bin", ".sandbox-secrets"]) {
    const source = path.join(currentCodexHome, directory);
    const stat = await fs.stat(source).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new Error(`current Codex ${directory} is unavailable`);
    }
    try {
      await fs.symlink(source, path.join(codexHome, directory), "junction");
    } catch (error) {
      throw new Error(`unable to link Codex ${directory}: ${error.message}`);
    }
  }
  const migrationMarker = path.join(currentCodexHome, ".sandbox_migration");
  if (await fs.stat(migrationMarker).then((stat) => stat.isFile(), () => false)) {
    await fs.link(
      migrationMarker,
      path.join(codexHome, ".sandbox_migration")
    );
  }
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    plainConfig(contract, workspaceRoot),
    "utf8"
  );
  return codexHome;
}

export async function prepareRuntimeProfile({
  mode,
  currentCodexHome,
  tempRoot,
  workspaceRoot
}) {
  if (!MODES.has(mode)) throw new Error(`unsupported benchmark mode: ${mode}`);
  const contract = sharedExecutionContract();
  const disabledFeatures = mode === "plain"
    ? [...PLAIN_DISABLED_FEATURES]
    : mode === "skills"
      ? ["multi_agent"]
      : [];
  const codexHome = mode === "plain"
    ? await preparePlainHome({
      currentCodexHome,
      tempRoot,
      contract,
      workspaceRoot
    })
    : currentCodexHome;

  return {
    mode,
    codex_home: codexHome,
    environment: {
      CODEX_HOME: codexHome
    },
    execution: contract,
    disabled_features: disabledFeatures,
    app_server_args: appServerArgs(disabledFeatures),
    multi_agent: mode === "orquesta",
    repo_orquesta_skill: mode === "orquesta" ? "required" : "forbidden"
  };
}

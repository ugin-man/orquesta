"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { writeJsonAtomic } = require("./json-state");

function standaloneHookSource() {
  return `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
function obj(v){return v&&typeof v==="object"&&!Array.isArray(v)?v:null}
function str(v){return typeof v==="string"&&v.trim()?v.trim():null}
function read(p,f){try{return JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){if(e&&e.code==="ENOENT")return JSON.parse(JSON.stringify(f));throw e}}
function write(p,v){fs.mkdirSync(path.dirname(p),{recursive:true});const t=p+"."+process.pid+"."+Date.now()+".tmp";fs.writeFileSync(t,JSON.stringify(v,null,2)+"\\n","utf8");fs.renameSync(t,p)}
function fingerprint(p){try{const s=fs.statSync(p);return s.size+":"+Math.trunc(s.mtimeMs)}catch{return "unavailable:"+Date.now()+":"+process.pid}}
function stateFor(n,p){return n>=p.required_at?"rotation_required":n>=p.pending_at?"rotation_pending":n>=p.prepare_at?"rotation_preparing":"active"}
function message(s,n){if(s==="rotation_preparing")return "Orquesta session health: compaction "+n+". Prepare canonical state and handoff evidence; do not rotate yet.";if(s==="rotation_pending")return "Orquesta session health: compaction "+n+". Finish the current atomic work unit, then rotate at the next safe boundary.";if(s==="rotation_required")return "Orquesta session health: compaction "+n+". Do not accept new work. Finish only the current atomic work unit and complete the verified session handoff.";return null}
async function main(){let raw="";for await(const c of process.stdin)raw+=c;const i=obj(raw.trim()?JSON.parse(raw):{});if(!i||i.hook_event_name!=="PostCompact"||!str(i.session_id))return;const root=path.resolve(__dirname,"..","..");const sessions=read(path.join(root,".orquesta","state","sessions.json"),{sessions:[]}).sessions||[];const mapped=sessions.find(s=>str(s&&s.thread_id)===i.session_id||str(s&&s.session_id)===i.session_id);if(!mapped||!str(mapped.agent_id))return;const registryPath=path.join(root,".orquesta","state","session-rotation.json");const registry=read(registryPath,{schema_version:1,revision:0,policy:{prepare_at:12,pending_at:15,required_at:20},sessions:{},applied_event_ids:[],updated_at:null});const fp=fingerprint(i.transcript_path);const eventId="compact:"+crypto.createHash("sha256").update([i.session_id,i.turn_id,i.trigger,fp].join("\\0")).digest("hex");if((registry.applied_event_ids||[]).includes(eventId))return;const sid=str(mapped.session_id)||i.session_id;const prior=obj(registry.sessions&&registry.sessions[sid])||{};const count=(Number.isInteger(prior.compaction_count)?prior.compaction_count:0)+1;const previous=str(prior.rotation_state)||"active";const protectedState=["draining","checkpointed","successor_warming","successor_verified"].includes(previous);const nextState=protectedState?previous:stateFor(count,registry.policy);const now=new Date().toISOString();const nextSession={session_id:sid,thread_id:str(mapped.thread_id)||i.session_id,agent_id:str(mapped.agent_id),session_generation:Number.isInteger(mapped.session_generation)?mapped.session_generation:1,compaction_count:count,rotation_state:nextState,ownership_status:str(prior.ownership_status)||"owner",accepts_new_work:nextState!=="rotation_required"&&prior.accepts_new_work!==false,replaces_session_id:prior.replaces_session_id||null,replaced_by_session_id:prior.replaced_by_session_id||null,handoff_manifest_path:prior.handoff_manifest_path||null,handoff_manifest_hash:prior.handoff_manifest_hash||null,successor_receipt_path:prior.successor_receipt_path||null,successor_receipt_hash:prior.successor_receipt_hash||null,last_compaction:{event_id:eventId,turn_id:str(i.turn_id),trigger:i.trigger==="manual"?"manual":"auto",transcript_path:str(i.transcript_path),transcript_fingerprint:fp,model:str(i.model),observed_at:now},created_at:prior.created_at||now,updated_at:now};const next={...registry,revision:(Number.isInteger(registry.revision)?registry.revision:0)+1,sessions:{...(registry.sessions||{}),[sid]:nextSession},applied_event_ids:[...(registry.applied_event_ids||[]),eventId].slice(-256),updated_at:now};write(registryPath,next);if(previous!==nextState){const m=message(nextState,count);if(m)process.stdout.write(JSON.stringify({continue:true,systemMessage:m})+"\\n")}}
main().catch(e=>{process.stderr.write((e instanceof Error?e.message:String(e))+"\\n");process.exitCode=1});
`;
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) return { description: "Project lifecycle hooks.", hooks: {} };
  const value = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("hooks.json must contain an object");
  return value;
}

function quoted(value) {
  return String(value).replaceAll('"', '\\"');
}

function hookDefinition(scriptPath) {
  const canonical = path.resolve(scriptPath);
  return {
    type: "command",
    command: `node "${quoted(canonical.replaceAll("\\", "/"))}"`,
    commandWindows: `node "${quoted(canonical)}"`,
    timeout: 5,
    statusMessage: "Updating Orquesta session health",
  };
}

function installSessionRotationHook({ projectRoot, canonicalRoot = projectRoot, scriptPath = null }) {
  const root = path.resolve(projectRoot);
  const canonical = path.resolve(canonicalRoot);
  const runtimePath = scriptPath
    ? path.resolve(scriptPath)
    : path.join(canonical, ".orquesta", "runtime", "session-rotation-hook.cjs");
  if (!scriptPath) {
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
    const source = standaloneHookSource();
    if (!fs.existsSync(runtimePath) || fs.readFileSync(runtimePath, "utf8") !== source) {
      fs.writeFileSync(runtimePath, source, "utf8");
    }
  }
  const configPath = path.join(root, ".codex", "hooks.json");
  const config = readConfig(configPath);
  const hooks = config.hooks && typeof config.hooks === "object" && !Array.isArray(config.hooks) ? config.hooks : {};
  const groups = Array.isArray(hooks.PostCompact) ? hooks.PostCompact : [];
  const expected = hookDefinition(runtimePath);
  const rotationHookPresent = groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some((hook) => (
    typeof hook?.command === "string" && hook.command.includes("session-rotation-hook")
  )));
  const expectedPresent = groups.some((group) => Array.isArray(group?.hooks) && group.hooks.some((hook) => (
    hook?.command === expected.command && hook?.commandWindows === expected.commandWindows
  )));
  if (expectedPresent) return { status: "unchanged", configPath, runtimePath, requiresTrustReview: false };
  const nextGroups = rotationHookPresent
    ? groups.map((group) => ({
        ...group,
        hooks: Array.isArray(group?.hooks)
          ? group.hooks.map((hook) => (
              typeof hook?.command === "string" && hook.command.includes("session-rotation-hook") ? expected : hook
            ))
          : group?.hooks,
      }))
    : [...groups, { matcher: "^(manual|auto)$", hooks: [expected] }];
  const next = {
    ...config,
    hooks: {
      ...hooks,
      PostCompact: nextGroups,
    },
  };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeJsonAtomic(configPath, next);
  return { status: rotationHookPresent ? "updated" : "installed", configPath, runtimePath, requiresTrustReview: true };
}

function parseArgs(argv) {
  const input = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--project-root") input.projectRoot = argv[++index];
    else if (argv[index] === "--canonical-root") input.canonicalRoot = argv[++index];
    else if (argv[index] === "--script") input.scriptPath = argv[++index];
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!input.projectRoot) throw new Error("--project-root is required");
  return input;
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(installSessionRotationHook(parseArgs(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { hookDefinition, installSessionRotationHook, standaloneHookSource };

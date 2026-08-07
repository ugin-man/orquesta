const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const repoRoot = path.resolve(__dirname, "..", "..");
const defaultStateRoot = path.join(repoRoot, ".orquesta");
const targetRoot = path.resolve(process.argv[2] || defaultStateRoot);

const textFileExtensions = new Set([".json", ".jsonl", ".md"]);
const ignoredDirNames = new Set(["archive"]);
const suspiciousQuestionMarks = /\?{3,}/;
const replacementCharacter = /\uFFFD/;
const japaneseMojibake = /(?:[繝繧蜿譁縺][^繝繧蜿譁縺\r\n]{0,8}){3,}/u;
const westernMojibake = /(?:Ã[\u0080-\u00BF]|Â[\u0080-\u00BF]|â€|ðŸ)/u;

function walk(dirPath, files = []) {
  if (!fs.existsSync(dirPath)) return files;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirNames.has(entry.name)) {
        walk(path.join(dirPath, entry.name), files);
      }
      continue;
    }
    if (entry.isFile() && textFileExtensions.has(path.extname(entry.name))) {
      files.push(path.join(dirPath, entry.name));
    }
  }
  return files;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function stripInlineCode(text) {
  return String(text).replace(/`[^`\r\n]*`/g, "");
}

function looksLikeMojibake(text) {
  return japaneseMojibake.test(String(text)) || westernMojibake.test(String(text));
}

function flattenJsonStrings(value, trail = "$", out = []) {
  if (typeof value === "string") {
    out.push([trail, value]);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenJsonStrings(item, `${trail}[${index}]`, out));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      flattenJsonStrings(item, `${trail}.${key}`, out);
    }
  }
  return out;
}

function verifiedHandoffManifest(filePath, parsed) {
  const normalized = path.resolve(filePath).replaceAll("\\", "/");
  if (!/\/\.orquesta\/state\/session-handoffs\/[^/]+\/generation-\d+-to-\d+\.manifest\.json$/i.test(normalized)) {
    return false;
  }
  if (parsed?.kind !== "orquesta_session_handoff_manifest") return false;
  const receiptPath = filePath.replace(/\.manifest\.json$/i, ".receipt.json");
  if (!fs.existsSync(receiptPath)) return false;
  try {
    const receipt = JSON.parse(stripBom(fs.readFileSync(receiptPath, "utf8")));
    const digest = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    return receipt.agent_id === parsed.agent_id
      && receipt.observed_generation === parsed.successor_generation
      && receipt.handoff_manifest_hash === digest;
  } catch {
    return false;
  }
}

function allowQuotedDamageExample(filePath, jsonPath, parsed) {
  return verifiedHandoffManifest(filePath, parsed)
    && /^\$\.conversation_tail\[\d+\]\.text$/.test(jsonPath);
}

function inspectString(filePath, detail, value, warnings, { allowInlineDamageExample = false } = {}) {
  const questionText = allowInlineDamageExample ? stripInlineCode(value) : value;
  if (suspiciousQuestionMarks.test(questionText)) {
    warnings.push({
      file: filePath,
      kind: "literal-question-mark-run",
      detail,
      sample: questionText.slice(0, 120)
    });
  }
  if (replacementCharacter.test(value)) {
    warnings.push({
      file: filePath,
      kind: "unicode-replacement-character",
      detail,
      sample: value.slice(0, 120)
    });
  }
  if (looksLikeMojibake(value)) {
    warnings.push({
      file: filePath,
      kind: "probable-mojibake",
      detail,
      sample: value.slice(0, 120)
    });
  }
}

function inspectJsonValue(filePath, parsed, warnings, pathPrefix = "$") {
  for (const [jsonPath, value] of flattenJsonStrings(parsed, pathPrefix)) {
    inspectString(filePath, jsonPath, value, warnings, {
      allowInlineDamageExample: allowQuotedDamageExample(filePath, jsonPath, parsed)
    });
  }
}

function inspectJson(filePath, text, warnings) {
  try {
    const parsed = JSON.parse(stripBom(text));
    inspectJsonValue(filePath, parsed, warnings);
  } catch (error) {
    warnings.push({
      file: filePath,
      kind: "json-parse-error",
      detail: error.message,
      sample: ""
    });
  }
}

function inspectJsonLines(filePath, text, warnings) {
  stripBom(text).split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      inspectJsonValue(filePath, JSON.parse(line), warnings, `$line[${index + 1}]`);
    } catch (error) {
      warnings.push({
        file: filePath,
        kind: "json-parse-error",
        detail: `line ${index + 1}: ${error.message}`,
        sample: line.slice(0, 120)
      });
    }
  });
}

function inspectText(filePath, text, warnings) {
  inspectString(filePath, "text", text, warnings, { allowInlineDamageExample: true });
}

function validateEncoding(rootPath = targetRoot) {
  const warnings = [];
  for (const filePath of walk(rootPath)) {
    const buffer = fs.readFileSync(filePath);
    const text = buffer.toString("utf8");
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      warnings.push({
        file: filePath,
        kind: "utf8-bom",
        detail: "file starts with UTF-8 BOM",
        sample: ""
      });
    }
    if (path.extname(filePath) === ".json") {
      inspectJson(filePath, text, warnings);
    } else if (path.extname(filePath) === ".jsonl") {
      inspectJsonLines(filePath, text, warnings);
    } else {
      inspectText(filePath, text, warnings);
    }
  }
  return warnings;
}

function relativeFile(filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/g, "/");
}

if (require.main === module) {
  const warnings = validateEncoding(targetRoot);
  if (!warnings.length) {
    console.log(`Orquesta encoding check passed: ${path.relative(repoRoot, targetRoot) || "."}`);
    process.exit(0);
  }

  console.error(`Orquesta encoding check failed: ${warnings.length} issue(s)`);
  for (const warning of warnings) {
    console.error(`- ${warning.kind}: ${relativeFile(warning.file)} ${warning.detail}`);
    if (warning.sample) console.error(`  sample: ${warning.sample}`);
  }
  process.exit(1);
}

module.exports = { looksLikeMojibake, stripInlineCode, validateEncoding };

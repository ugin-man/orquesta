const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..");
const defaultStateRoot = path.join(repoRoot, ".orquesta");
const targetRoot = path.resolve(process.argv[2] || defaultStateRoot);

const textFileExtensions = new Set([".json", ".jsonl", ".md"]);
const ignoredDirNames = new Set(["archive"]);
const suspiciousQuestionMarks = /\?{3,}/;
const replacementCharacter = /\uFFFD/;

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

function inspectJson(filePath, text, warnings) {
  try {
    const parsed = JSON.parse(stripBom(text));
    for (const [jsonPath, value] of flattenJsonStrings(parsed)) {
      if (suspiciousQuestionMarks.test(value)) {
        warnings.push({
          file: filePath,
          kind: "literal-question-mark-run",
          detail: jsonPath,
          sample: value.slice(0, 120)
        });
      }
      if (replacementCharacter.test(value)) {
        warnings.push({
          file: filePath,
          kind: "unicode-replacement-character",
          detail: jsonPath,
          sample: value.slice(0, 120)
        });
      }
    }
  } catch (error) {
    warnings.push({
      file: filePath,
      kind: "json-parse-error",
      detail: error.message,
      sample: ""
    });
  }
}

function inspectText(filePath, text, warnings) {
  if (suspiciousQuestionMarks.test(text)) {
    warnings.push({
      file: filePath,
      kind: "literal-question-mark-run",
      detail: "text",
      sample: text.match(suspiciousQuestionMarks)?.[0] || ""
    });
  }
  if (replacementCharacter.test(text)) {
    warnings.push({
      file: filePath,
      kind: "unicode-replacement-character",
      detail: "text",
      sample: ""
    });
  }
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

module.exports = { validateEncoding };

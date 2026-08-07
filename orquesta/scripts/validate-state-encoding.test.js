const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { afterEach, test } = require("node:test");

const { looksLikeMojibake, stripInlineCode, validateEncoding } = require("./validate-state-encoding");

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(name, extension, text, fileName = `fixture${extension}`) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `orquesta-encoding-${name}-`));
  roots.push(root);
  const filePath = path.join(root, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
  return root;
}

function handoffFixture(name, text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `orquesta-encoding-${name}-`));
  roots.push(root);
  const dir = path.join(root, ".orquesta", "state", "session-handoffs", "orchestrator");
  const manifestPath = path.join(dir, "generation-2-to-3.manifest.json");
  const receiptPath = path.join(dir, "generation-2-to-3.receipt.json");
  fs.mkdirSync(dir, { recursive: true });
  const manifest = JSON.stringify({
    schema_version: 1,
    kind: "orquesta_session_handoff_manifest",
    agent_id: "orchestrator",
    successor_generation: 3,
    conversation_tail: [{ text }],
  });
  fs.writeFileSync(manifestPath, manifest, "utf8");
  fs.writeFileSync(receiptPath, JSON.stringify({
    agent_id: "orchestrator",
    observed_generation: 3,
    handoff_manifest_hash: crypto.createHash("sha256").update(Buffer.from(manifest, "utf8")).digest("hex"),
  }), "utf8");
  return { root, manifestPath };
}

test("strips only single-line inline code spans", () => {
  assert.equal(stripInlineCode("before `???` after"), "before  after");
  assert.equal(stripInlineCode("before ??? after"), "before ??? after");
});

test("allows an intentional question-mark run quoted as inline code", () => {
  const { root: jsonRoot } = handoffFixture("quoted-manifest", "The damaged value was `???`.");
  const markdownRoot = fixture("quoted-markdown", ".md", "The damaged value was `???`.\n");
  assert.deepEqual(validateEncoding(jsonRoot), []);
  assert.deepEqual(validateEncoding(markdownRoot), []);
});

test("does not exempt an arbitrary manifest or a handoff whose receipt hash is stale", () => {
  const arbitrary = fixture("arbitrary-manifest", ".json", JSON.stringify({
    conversation_tail: [{ text: "The damaged value was `???`." }]
  }), "arbitrary.manifest.json");
  assert.equal(validateEncoding(arbitrary).some((warning) => warning.kind === "literal-question-mark-run"), true);

  const stale = handoffFixture("stale-handoff", "The damaged value was `???`.");
  fs.appendFileSync(stale.manifestPath, " ", "utf8");
  assert.equal(validateEncoding(stale.root).some((warning) => warning.kind === "literal-question-mark-run"), true);
});

test("does not exempt quoted question marks in ordinary JSON state", () => {
  const root = fixture("quoted-display-name", ".json", JSON.stringify({ display_name: "`???`" }));
  assert.equal(validateEncoding(root).some((warning) => warning.kind === "literal-question-mark-run"), true);
});

test("still rejects an unquoted question-mark run", () => {
  const root = fixture("unquoted", ".json", JSON.stringify({ text: "The damaged value was ???." }));
  assert.equal(validateEncoding(root).some((warning) => warning.kind === "literal-question-mark-run"), true);
});

test("still rejects the Unicode replacement character inside inline code", () => {
  const root = fixture("replacement", ".md", "The damaged value was `�`.\n");
  assert.equal(validateEncoding(root).some((warning) => warning.kind === "unicode-replacement-character"), true);
});

test("rejects an unquoted question-mark run inside manifest conversation provenance", () => {
  const root = fixture("unquoted-manifest", ".json", JSON.stringify({
    conversation_tail: [{ text: "The damaged value was ???." }]
  }), "handoff.manifest.json");
  assert.equal(validateEncoding(root).some((warning) => warning.kind === "literal-question-mark-run"), true);
});

test("detects strong mojibake signatures without rejecting normal Japanese", () => {
  assert.equal(looksLikeMojibake("繝峨く繝･繝｡繝ｳ繝・"), true);
  assert.equal(looksLikeMojibake("正常な日本語ですか？ はい。"), false);
  assert.equal(looksLikeMojibake("隕石と隕鉄"), false);
  assert.equal(looksLikeMojibake("繧繝彩色"), false);
  const root = fixture("mojibake", ".json", JSON.stringify({ title: "繝峨く繝･繝｡繝ｳ繝・" }));
  assert.equal(validateEncoding(root).some((warning) => warning.kind === "probable-mojibake"), true);
});

test("validates JSONL string values without markdown exemptions", () => {
  const root = fixture("jsonl", ".jsonl", `${JSON.stringify({ summary: "`???`" })}\n`);
  assert.equal(validateEncoding(root).some((warning) => warning.kind === "literal-question-mark-run"), true);
});

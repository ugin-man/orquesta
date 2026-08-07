"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const skillRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(skillRoot, "..");

function text(relativePath) {
  return readFileSync(path.join(skillRoot, relativePath), "utf8");
}

function repositoryText(relativePath) {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

test("startup makes Orquesta Desktop the primary project surface", () => {
  const skill = text("SKILL.md");
  const setup = text(path.join("references", "initial-setup.md"));
  const protocol = text(path.join("references", "orchestration-protocol.md"));

  assert.match(skill, /Orquesta V4 Desktop is the primary operating surface/);
  assert.doesNotMatch(skill, /add no desktop, web, or application shell/i);
  assert.doesNotMatch(skill, /productization requires a separate user decision/i);

  for (const document of [skill, setup, protocol]) {
    assert.match(document, /desktop-launch\.js/);
    assert.match(document, /--orquesta-project/);
  }
});

test("startup delegates diagnostic browser binding without using the default browser", () => {
  const setup = text(path.join("references", "initial-setup.md"));
  const protocol = text(path.join("references", "orchestration-protocol.md"));

  assert.doesNotMatch(setup, /Start-Process\s+<verified-dashboard-url>/);
  assert.doesNotMatch(protocol, /Open the verified dashboard URL in the user's external browser/);
  assert.match(setup, /available browser-control skill/);
  assert.match(setup, /do not hardcode a browser executable/);
  assert.match(protocol, /browser\/tab binding contract/);
  assert.match(`${setup}\n${protocol}`, /project policy/);
  assert.match(`${setup}\n${protocol}`, /forbidden_actions/);
  assert.match(`${setup}\n${protocol}`, /live stop state/);
  assert.match(`${setup}\n${protocol}`, /browser.family.*tab.count\/reuse/i);
  assert.match(`${setup}\n${protocol}`, /more restrictive current authority wins/i);
});

test("visual user confirmation is optional evidence, not a generic setup blocker", () => {
  const setup = text(path.join("references", "initial-setup.md"));

  assert.match(setup, /not a generic setup blocker/i);
  assert.match(setup, /optional UAT evidence/i);
});

test("existing-project startup keeps expensive surfaces conditional", () => {
  const skill = text("SKILL.md");
  const protocol = text(path.join("references", "orchestration-protocol.md"));

  assert.match(skill, /existing-project normal turn/);
  assert.match(skill, /do not launch or relaunch Orquesta Desktop/);
  assert.match(skill, /foundation trigger audit only when/);
  assert.match(skill, /already-scoped specialist task does not require the full protocol/);
  assert.match(protocol, /Do not read or execute this full protocol by default/);
  assert.match(protocol, /run or refresh the foundation trigger audit before first production routing/);
  assert.match(skill, /file-backed canonical state outranks chat/);
  assert.match(skill, /dispatch_accepted.*turn_started/);
  assert.match(skill, /actual_model.*runtime observation evidence/);
  assert.match(skill, /final external send, submission, publication, purchase, contract, or consent/);
});

test("public onboarding documents keep the browser dashboard diagnostic-only", () => {
  const readme = repositoryText("README.md");
  const startHere = repositoryText("START_HERE.md");

  for (const document of [readme, startHere]) {
    assert.match(document, /Orquesta Desktop/);
    assert.match(document, /diagnostic/i);
  }
  assert.doesNotMatch(readme, /opens the verified dashboard URL in your external browser/i);
  assert.doesNotMatch(startHere, /explain the legacy local dashboard/i);
  assert.doesNotMatch(startHere, /## Legacy Browser Dashboard/i);
});

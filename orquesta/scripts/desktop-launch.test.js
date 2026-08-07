"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  buildDesktopLaunch,
  resolveDesktopExecutable,
} = require("./desktop-launch");

test("builds a Desktop launch with an explicit project root and calling Codex thread", () => {
  const projectRoot = String.raw`C:\Users\example\OneDrive\ドキュメント\help`;
  const desktopExe = String.raw`C:\Users\example\AppData\Local\Orquesta\Orquesta.exe`;

  const launch = buildDesktopLaunch({
    projectRoot,
    desktopExe,
    callingThreadId: "018f0000-0000-7000-8000-000000000001",
    platform: "win32"
  });

  assert.equal(launch.command, path.win32.normalize(desktopExe));
  assert.deepEqual(launch.args, [
    "--orquesta-project",
    path.win32.normalize(projectRoot),
    "--orquesta-calling-thread",
    "018f0000-0000-7000-8000-000000000001"
  ]);
  assert.equal(launch.kind, "orquesta-desktop");
  assert.equal(launch.browserUrl, undefined);
});

test("omits the calling thread for a standalone Desktop launch", () => {
  const launch = buildDesktopLaunch({
    projectRoot: String.raw`C:\work\demo`,
    desktopExe: String.raw`C:\Program Files\Orquesta\Orquesta.exe`,
    platform: "win32"
  });
  assert.deepEqual(launch.args, ["--orquesta-project", String.raw`C:\work\demo`]);
});

test("prefers an explicit override and otherwise resolves the installed Windows Desktop", () => {
  const override = String.raw`D:\tools\Orquesta.exe`;
  const installed = String.raw`C:\Users\example\AppData\Local\Orquesta\Orquesta.exe`;
  const existing = new Set([override, installed].map((item) => path.win32.normalize(item).toLowerCase()));
  const existsSync = (candidate) => existing.has(path.win32.normalize(candidate).toLowerCase());

  assert.equal(resolveDesktopExecutable({
    platform: "win32",
    env: {
      ORQUESTA_DESKTOP_EXE: override,
      LOCALAPPDATA: String.raw`C:\Users\example\AppData\Local`,
    },
    existsSync,
  }), path.win32.normalize(override));

  assert.equal(resolveDesktopExecutable({
    platform: "win32",
    env: { LOCALAPPDATA: String.raw`C:\Users\example\AppData\Local` },
    existsSync,
  }), path.win32.normalize(installed));
});

test("fails closed instead of falling back to a browser URL", () => {
  assert.throws(
    () => resolveDesktopExecutable({
      platform: "win32",
      env: { LOCALAPPDATA: String.raw`C:\Users\example\AppData\Local` },
      existsSync: () => false,
    }),
    /Orquesta Desktop executable was not found/,
  );
});

test("rejects a dashboard URL as a project root", () => {
  assert.throws(
    () => buildDesktopLaunch({
      projectRoot: "http://127.0.0.1:4177/",
      desktopExe: String.raw`C:\Program Files\Orquesta\Orquesta.exe`,
      platform: "win32",
    }),
    /filesystem project root/,
  );
});

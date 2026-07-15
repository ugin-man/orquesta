"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { eventStoreError } = require("./errors");

const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function unlinkIfPresent(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function replaceFileAtomic(filePath, text, options = {}) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`);
  const backupPath = `${filePath}.bak`;
  const expectedBytes = Buffer.from(text, "utf8");
  let descriptor;

  try {
    descriptor = fs.openSync(tempPath, "wx");
    fs.writeFileSync(descriptor, expectedBytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (options.onAfterTempFsync) options.onAfterTempFsync({ tempPath, filePath });

    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, backupPath);
    let lastError;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        fs.renameSync(tempPath, filePath);
        let actualBytes;
        try {
          actualBytes = fs.readFileSync(filePath);
        } catch (error) {
          throw eventStoreError("EVENT_ATOMIC_VERIFY_FAILED", "Atomic replacement could not reread its target", {
            file_path: filePath,
            cause_code: error.code || null,
          });
        }
        if (!Buffer.from(actualBytes).equals(expectedBytes)) {
          throw eventStoreError("EVENT_ATOMIC_VERIFY_FAILED", "Atomic replacement target bytes did not match the staged UTF-8 bytes", { file_path: filePath });
        }
        return { filePath, backupPath, tempPath: null };
      } catch (error) {
        lastError = error;
        if (!TRANSIENT_RENAME_CODES.has(error.code) || attempt === 5) throw error;
        sleep(5 * (attempt + 1));
      }
    }
    throw lastError;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(tempPath)) unlinkIfPresent(tempPath);
  }
}

module.exports = { replaceFileAtomic, unlinkIfPresent };

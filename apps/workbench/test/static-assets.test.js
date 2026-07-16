"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { startWorkbench } = require("../server");

test("serves only the fixed Workbench assets with explicit content types", async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orquesta-workbench-assets-"));
  const app = await startWorkbench({ feature: "v4", stateRoot, port: 0 });
  try {
    const expected = new Map([
      ["/", "text/html; charset=utf-8"],
      ["/styles.css", "text/css; charset=utf-8"],
      ["/app.js", "text/javascript; charset=utf-8"],
      ["/view-model.js", "text/javascript; charset=utf-8"],
    ]);
    for (const [route, contentType] of expected) {
      const response = await fetch(`${app.url}${route}`);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get("content-type"), contentType, route);
      assert.ok((await response.text()).length > 0, route);
    }

    for (const route of ["/package.json", "/../package.json", "/%2e%2e/package.json", "/public/../package.json", "/favicon.ico"]) {
      assert.equal((await fetch(`${app.url}${route}`)).status, 404, route);
    }

    const html = await fetch(app.url).then((response) => response.text());
    assert.match(html, /data-testid="fixture-tabs"/u);
    assert.match(html, /src="\/view-model\.js"/u);
    assert.match(html, /src="\/app\.js"/u);
    assert.doesNotMatch(html, /approve|承認する/iu);
  } finally {
    await app.close();
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});

import { readFile } from "node:fs/promises";

const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
const invalid = [];
for (const [name, entry] of Object.entries(lock.packages ?? {})) {
  const resolved = entry?.resolved;
  if (typeof resolved === "string" && !resolved.startsWith("https://registry.npmjs.org/")) {
    invalid.push(`${name || "<root>"}: ${resolved}`);
  }
}

if (invalid.length > 0) {
  console.error("package-lock.json contains non-public registry URLs:");
  console.error(invalid.join("\n"));
  process.exit(1);
}

console.log("package-lock.json uses only registry.npmjs.org tarball URLs.");

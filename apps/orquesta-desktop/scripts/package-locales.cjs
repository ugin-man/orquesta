const { readdir, rm } = require('node:fs/promises');
const path = require('node:path');

const keptLocales = new Set(['en-US.pak', 'ja.pak']);

async function pruneElectronLocales(buildPath) {
  const localesPath = path.join(buildPath, 'locales');
  const entries = await readdir(localesPath, { withFileTypes: true });

  await Promise.all(entries.map(async (entry) => {
    if (entry.isFile() && keptLocales.has(entry.name)) return;
    await rm(path.join(localesPath, entry.name), { force: true, recursive: true });
  }));
}

module.exports = { pruneElectronLocales };

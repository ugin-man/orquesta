const path = require('node:path');

function createPackageIgnore(appRoot) {
  const normalizedRoot = path.resolve(appRoot);

  return (candidatePath) => {
    const resolved = path.resolve(candidatePath);
    if (resolved === normalizedRoot) return false;

    const portablePath = resolved.replaceAll(path.sep, '/');
    if (/\/dist-electron\/core-e2e\.cjs(?:\.map)?$/.test(portablePath)) return true;
    if (portablePath.endsWith('/package.json')) return false;
    if (/\/(?:dist|dist-electron)(?:\/|$)/.test(portablePath)) return false;
    if (/\/schemas(?:\/|$)/.test(portablePath)) return false;
    return true;
  };
}

module.exports = { createPackageIgnore };

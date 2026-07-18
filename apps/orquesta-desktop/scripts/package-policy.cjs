const path = require('node:path');

function createPackageIgnore(appRoot) {
  const normalizedRoot = path.resolve(appRoot);

  return (candidatePath) => {
    const resolved = path.resolve(candidatePath);
    if (resolved === normalizedRoot) return false;

    const portablePath = resolved.replaceAll(path.sep, '/');
    if (portablePath.endsWith('/package.json')) return false;
    if (/\/(?:dist|dist-electron)(?:\/|$)/.test(portablePath)) return false;
    return true;
  };
}

module.exports = { createPackageIgnore };

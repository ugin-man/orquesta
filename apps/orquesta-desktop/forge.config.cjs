const { createPackageIgnore } = require('./scripts/package-policy.cjs');
const { pruneElectronLocales } = require('./scripts/package-locales.cjs');

module.exports = {
  outDir: process.env.ORQUESTA_FORGE_OUT_DIR || 'out',
  packagerConfig: {
    asar: true,
    name: 'Orquesta',
    executableName: 'Orquesta',
    icon: require('node:path').join(__dirname, 'assets', 'orquesta.ico'),
    extraResource: [require('node:path').join(__dirname, '.runtime-staging', 'codex-runtime')],
    ignore: createPackageIgnore(__dirname),
    prune: false,
    afterComplete: [
      (buildPath, _electronVersion, platform, _arch, callback) => {
        if (platform !== 'win32') {
          callback();
          return;
        }
        pruneElectronLocales(buildPath).then(() => callback(), callback);
      }
    ]
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: { name: 'Orquesta', setupExe: 'OrquestaSetup.exe', setupIcon: require('node:path').join(__dirname, 'assets', 'orquesta.ico') }
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32']
    }
  ]
};

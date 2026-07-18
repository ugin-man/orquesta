import path from 'node:path';
import { DesktopCodexService } from './desktop-codex-service';
import { runDesktopCore } from './core-runner';

const electronProcess = process as NodeJS.Process & {
  defaultApp?: boolean;
  resourcesPath?: string;
};
const appRoot = path.resolve(__dirname, '..');
const resourcesPath = electronProcess.resourcesPath ?? appRoot;

runDesktopCore(new DesktopCodexService({
  packaged: appRoot.toLowerCase().includes('.asar') || electronProcess.defaultApp === false,
  appRoot,
  resourcesPath
}));

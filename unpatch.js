import { renameSync, rmSync } from 'fs';
import { join } from 'path';
import { tidalPath, isWindowsPlatform, existsInDefaultPath, getAppDirName } from './utils.js';

function main() {
  console.log('TIDAL Enhanced Patcher - https://github.com/nekusu');
  if (!isWindowsPlatform() || !existsInDefaultPath()) return;

  const appResourcesPath = join(tidalPath, getAppDirName(), 'resources');
  const asarFilePath = join(appResourcesPath, 'app.asar');

  rmSync(asarFilePath);
  renameSync(join(appResourcesPath, 'app_original.asar'), asarFilePath);
  console.log('TIDAL unpatched successfully');
}

main();

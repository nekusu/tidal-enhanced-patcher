import { join } from 'path';
import {
  tidalPath,
  isWindowsPlatform,
  existsInDefaultPath,
  getAppDirName,
  extractSourceFiles,
} from './utils.js';

function main() {
  console.log('TIDAL Enhanced Patcher - https://github.com/nekusu');
  if (!isWindowsPlatform() || !existsInDefaultPath()) return;

  const appResourcesPath = join(tidalPath, getAppDirName(), 'resources');
  const asarFilePath = join(appResourcesPath, 'app.asar');
  const sourcePath = join(appResourcesPath, 'src');

  extractSourceFiles(asarFilePath, sourcePath);
}

main();

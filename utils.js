import asar from 'asar';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';

const DEFAULT_TIDAL_PATH = join(process.env.APPDATA ?? '', '../Local/TIDAL');
let tidalPath = DEFAULT_TIDAL_PATH;

function isWindowsPlatform() {
  const isWindows = process.platform === 'win32';
  if (!isWindows) {
    console.error('Only Windows platforms are supported');
  }
  return isWindows;
}

function existsInDefaultPath() {
  const exists = existsSync(join(tidalPath), 'TIDAL.exe');
  if (exists) {
    console.log(`TIDAL executable found in default path: ${tidalPath}`);
  } else {
    console.error('TIDAL executable not found');
  }
  return exists;
}

function getAppDirName() {
  const appDirName = readdirSync(tidalPath, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .find((dirent) => dirent.name.startsWith('app'))
    .name;
  console.log(`App directory: ${appDirName}`);
  return appDirName;
}

function extractSourceFiles(asarFilePath, sourcePath) {
  asar.extractAll(asarFilePath, sourcePath);
  console.log('Source files extracted successfully');
}

export {
  tidalPath,
  isWindowsPlatform,
  existsInDefaultPath,
  getAppDirName,
  extractSourceFiles,
};

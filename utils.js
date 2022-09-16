import asar from 'asar';
import { exec as _exec } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { promisify } from 'util';
import { join } from 'path';

const exec = (command) => promisify(_exec)(command);

const DEFAULT_TIDAL_PATH = join(process.env.APPDATA ?? '', '../Local/TIDAL');
let tidalPath = DEFAULT_TIDAL_PATH;

function isWindowsPlatform() {
  const isWindows = process.platform === 'win32';
  if (!isWindows) {
    console.error('Only Windows platforms are supported');
  }
  return isWindows;
}

async function isAppRunning() {
  const taskListCommand = 'tasklist /v /fi "IMAGENAME eq tidal.exe"';
  const { stdout } = await exec(taskListCommand);
  const isRunning = !stdout.includes('No tasks');
  if (isRunning) {
    console.error('Close the app before running the patcher!');
  }
  return isRunning;
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
  isAppRunning,
  existsInDefaultPath,
  getAppDirName,
  extractSourceFiles,
};

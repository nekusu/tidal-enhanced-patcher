import asar from 'asar';
import { exec as _exec } from 'child_process';
import { get } from 'https';
import {
  access,
  constants,
  createWriteStream,
  existsSync,
  readdirSync,
  readFileSync,
  unlink,
  writeFileSync,
} from 'fs';
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
    console.log(`Executable found in default path: ${tidalPath}`);
  } else {
    console.error('Executable not found');
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
  console.log('Source files extracted');
}

function injectCode(filePath, modifications) {
  const file = readFileSync(filePath, { encoding: 'utf8' });
  let modifiedFile = file;
  for (const { reference, code, newLine = true, replace = false } of modifications) {
    if (replace) {
      modifiedFile = modifiedFile.replace(reference, code);
      continue;
    }
    if (newLine) {
      const lines = modifiedFile.split(/\r?\n/);
      const lineIndex = lines.findIndex((line) => line.includes(reference));
      lines.splice(lineIndex, 0, code);
      modifiedFile = lines.join('\n');
    } else {
      const charIndex = modifiedFile.search(reference);
      modifiedFile = modifiedFile.substring(0, charIndex) + code + modifiedFile.substring(charIndex);
    }
  }
  writeFileSync(filePath, modifiedFile);
}

// code source: https://stackoverflow.com/a/62786397
function download(url, dest) {
  return new Promise((resolve, reject) => {
    // Check file does not exist yet before hitting network
    access(dest, constants.F_OK, (err) => {
      if (err === null) reject('File already exists');
      const request = get(url, response => {
        if (response.statusCode === 200) {
          const file = createWriteStream(dest, { flags: 'wx' });

          file.on('finish', () => resolve());
          file.on('error', err => {
            file.close();
            if (err.code === 'EEXIST') {
              reject('File already exists');
            } else {
              unlink(dest, () => reject(err.message)); // Delete temp file
            }
          });
          response.pipe(file);
        } else if (response.statusCode === 302 || response.statusCode === 301) {
          //Recursively follow redirects, only a 200 will resolve.
          download(response.headers.location, dest).then(() => resolve());
        } else {
          reject(`Server responded with ${response.statusCode}: ${response.statusMessage}`);
        }
      });
      request.on('error', err => {
        reject(err.message);
      });
    });
  });
}

export {
  tidalPath,
  isWindowsPlatform,
  isAppRunning,
  existsInDefaultPath,
  getAppDirName,
  extractSourceFiles,
  injectCode,
  download,
};

import { createWriteStream } from 'node:fs';
import { exists, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { promisify } from 'node:util';
import { log, spinner } from '@clack/prompts';
import { extractAll } from '@electron/asar';
import AdmZip from 'adm-zip';
import { execa } from 'execa';

const NODEJS_DIST_URL = 'https://nodejs.org/dist';
export const isMacPlatform = process.platform === 'darwin';
const DEFAULT_TIDAL_PATH = isMacPlatform
  ? '/Applications/TIDAL.app'
  : join(import.meta.env.APPDATA ?? '', '../Local/TIDAL');
// path to the main executable, relative to `tidalPath`
const EXECUTABLE_PATH = isMacPlatform ? 'Contents/MacOS/TIDAL' : 'TIDAL.exe';
export const tidalPath = DEFAULT_TIDAL_PATH;

export function isSupportedPlatform() {
  const isSupported = process.platform === 'win32' || isMacPlatform;
  if (!isSupported) log.error('Only Windows and macOS platforms are supported');
  return isSupported;
}

export async function isAppRunning() {
  const s = spinner();
  let isRunning = true;
  s.start('Checking if TIDAL is running...');
  try {
    if (isMacPlatform) {
      const { stdout } = await execa('pgrep', ['-x', 'TIDAL'], { reject: false });
      isRunning = stdout.trim().length > 0;
      if (isRunning) {
        s.stop('TIDAL is currently running', 2);
        s.start('Killing TIDAL process...');
        await execa('pkill', ['-x', 'TIDAL'], { reject: false });
        s.stop('TIDAL process killed');
        isRunning = false;
      } else s.stop('TIDAL is not running');
    } else {
      const { stdout: count } = await execa({
        shell: 'powershell',
      })`(Get-Process -Name TIDAL).Count`;
      isRunning = +count > 0;
      if (isRunning) {
        s.stop('TIDAL is currently running', 2);
        s.start('Killing TIDAL process...');
        await execa({ shell: 'powershell' })`Stop-Process -Name TIDAL`;
        s.stop('TIDAL process killed');
        isRunning = false;
      } else s.stop('TIDAL is not running');
    }
  } catch (error) {
    s.stop('Error checking if TIDAL is running', 2);
    log.error((error as Error).message);
  }
  return isRunning;
}

export async function existsInDefaultPath() {
  const fileExists = await exists(join(tidalPath, EXECUTABLE_PATH));
  if (fileExists) log.info(`Executable found in default path: ${tidalPath}`);
  else log.error('Executable not found');
  return fileExists;
}

async function getAppDirName() {
  let appVersion: string | undefined;
  try {
    const { stdout } = await execa({
      shell: 'powershell',
    })`(Get-Item '${join(tidalPath, EXECUTABLE_PATH)}').VersionInfo | ConvertTo-Json`;
    appVersion = JSON.parse(stdout).FileVersion;
  } catch (error) {
    log.warn(`Error getting app version: ${(error as Error).message}`);
  }
  try {
    let appVersionDirName: string | undefined;
    if (appVersion) appVersionDirName = `app-${appVersion.split('.').slice(0, 3).join('.')}`;
    else {
      const appDirName = await readdir(tidalPath, { withFileTypes: true });
      appVersionDirName = appDirName
        .filter((dirent) => dirent.isDirectory())
        .find((dirent) => dirent.name.startsWith('app'))?.name;
    }
    if (appVersionDirName && (await exists(join(tidalPath, appVersionDirName)))) {
      log.info(`App directory: ${appVersionDirName}`);
      return appVersionDirName;
    }
    log.error('App directory not found');
  } catch (error) {
    log.error(`Error looking for app directory: ${(error as Error).message}`);
  }
}

export async function getAppResourcesPath() {
  if (isMacPlatform) {
    const resourcesPath = join(tidalPath, 'Contents/Resources');
    if (await exists(resourcesPath)) {
      log.info(`App resources directory: ${resourcesPath}`);
      return resourcesPath;
    }
    log.error('App resources directory not found');
    return undefined;
  }
  const appDirName = await getAppDirName();
  if (!appDirName) return undefined;
  return join(tidalPath, appDirName, 'resources');
}

export function waitForTimeout(timeout = 100) {
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

export async function extractSourceFiles(asarFilePath: string, sourcePath: string) {
  const s = spinner();
  s.start('Extracting source files...');
  try {
    await rm(sourcePath, { recursive: true, force: true });
    // ensures that the spinner appears, although it will get stuck because asar.extractAll()
    // is synchronous
    await waitForTimeout();
    extractAll(asarFilePath, sourcePath, false);
    s.stop('Source files extracted');
  } catch (error) {
    s.stop('Error extracting source files', 2);
    throw error;
  }
}

export type Modifications = {
  reference: RegExp;
  code: string;
  type?: 'replace' | 'newLine' | 'exact';
  offset?: number; // only applicable if type is 'newLine'
};

export async function injectCode(filePath: string, modifications: Modifications[]) {
  const fileName = filePath.split(/[/\\]/).at(-1);
  let file: string | undefined;
  try {
    file = await readFile(filePath, { encoding: 'utf8' });
    if (!file) throw new Error(`File ${fileName} not found`);
  } catch (error) {
    log.error((error as Error).message);
    return;
  }
  let modifiedFile = file;
  try {
    for (const { reference, code, type = 'newLine', offset = 0 } of modifications) {
      if (!reference.test(file)) {
        log.warn(
          `Reference \`${reference}\` not found in file ${fileName}. Skipping modification...`,
        );
        continue;
      }
      if (type === 'replace') modifiedFile = modifiedFile.replace(reference, code);
      else if (type === 'newLine') {
        const lines = modifiedFile.split(/\r?\n/);
        const lineIndex = lines.findIndex((line) => line.match(reference));
        lines.splice(lineIndex + 1 + offset, 0, code);
        modifiedFile = lines.join('\n');
      } else if (type === 'exact') {
        const charIndex = modifiedFile.search(reference);
        modifiedFile = modifiedFile.slice(0, charIndex) + code + modifiedFile.slice(charIndex);
      }
    }
    await writeFile(filePath, modifiedFile);
  } catch (error) {
    log.error(`Error while modifying file ${fileName}`);
    throw error;
  }
}

export async function download(url: string, outputPath: string) {
  const response = await fetch(url);
  if (response.ok && response.body) {
    const writeStream = createWriteStream(outputPath);
    // type error: https://github.com/DefinitelyTyped/DefinitelyTyped/discussions/65542#discussioncomment-6071004
    const body = response.body as unknown as ReadableStream<Uint8Array>;
    Readable.fromWeb(body).pipe(writeStream);
    return new Promise((resolve, reject) => {
      writeStream.on('error', reject);
      writeStream.on('close', resolve);
    });
  }
}

export async function downloadNpm(outputPath = 'node') {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const platformDistName = isMacPlatform ? 'darwin' : 'win';
  const archiveExt = isMacPlatform ? 'tar.gz' : 'zip';
  const archiveFile = `node.${archiveExt}`;
  let archiveName: string | undefined;
  const s = spinner();
  s.start('Downloading npm from nodejs.org...');
  try {
    const response = await fetch(`${NODEJS_DIST_URL}/index.json`);
    const versions = await response.json();
    const latestVersion = versions[0].version;
    archiveName = `node-${latestVersion}-${platformDistName}-${arch}`;
    const downloadURL = `${NODEJS_DIST_URL}/${latestVersion}/${archiveName}.${archiveExt}`;
    await rm(archiveFile, { force: true });
    await download(downloadURL, archiveFile);
    s.stop('npm downloaded');
  } catch (error) {
    s.stop('Error downloading npm', 2);
    throw error;
  }
  const s2 = spinner();
  s2.start('Extracting npm...');
  try {
    if (isMacPlatform) await execa('tar', ['-xzf', archiveFile]);
    else {
      const zip = new AdmZip(archiveFile);
      const extractAllTo = promisify(zip.extractAllToAsync.bind(zip));
      await extractAllTo('', true, false);
    }
    await rm(outputPath, { force: true });
    await rename(archiveName as string, outputPath);
    await rm(archiveFile);
    s2.stop('npm extracted');
  } catch (error) {
    s2.stop('Error extracting npm', 2);
    throw error;
  }
}

import { createWriteStream } from 'node:fs';
import { exists, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { promisify } from 'node:util';
import { log, spinner } from '@clack/prompts';
import asar from '@electron/asar';
import AdmZip from 'adm-zip';
import { execa } from 'execa';
import findProcess from 'find-process';

const NODEJS_DIST_URL = 'https://nodejs.org/dist';
const DEFAULT_TIDAL_PATH = join(import.meta.env.APPDATA ?? '', '../Local/TIDAL');
const EXECUTABLE_NAME = 'TIDAL.exe';
export const tidalPath = DEFAULT_TIDAL_PATH;

export function isWindowsPlatform() {
  const isWindows = process.platform === 'win32';
  if (!isWindows) log.error('Only Windows platforms are supported');
  return isWindows;
}

export async function isAppRunning() {
  const s = spinner();
  s.start('Checking if TIDAL is running...');
  const programs = await findProcess('name', EXECUTABLE_NAME);
  const isRunning = !!programs.length;
  if (isRunning) s.stop('Close the app before running the patcher!', 2);
  else s.stop('TIDAL is not running');
  return isRunning;
}

export async function existsInDefaultPath() {
  const fileExists = await exists(join(tidalPath, EXECUTABLE_NAME));
  if (fileExists) log.info(`Executable found in default path: ${tidalPath}`);
  else log.error('Executable not found');
  return exists;
}

export async function getAppDirName() {
  let appVersion: string | undefined;
  try {
    const { stdout } = await execa({
      shell: 'powershell',
    })`(Get-Item '${join(tidalPath, EXECUTABLE_NAME)}').VersionInfo | ConvertTo-Json`;
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

export async function waitForTimeout(timeout = 100) {
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
    asar.extractAll(asarFilePath, sourcePath);
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
  const fileName = filePath.split('\\').at(-1);
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
  let latestVersion: string | undefined;
  const s = spinner();
  s.start('Downloading npm from nodejs.org...');
  try {
    const response = await fetch(`${NODEJS_DIST_URL}/index.json`);
    const versions = await response.json();
    latestVersion = versions[0].version;
    const downloadURL = `${NODEJS_DIST_URL}/${latestVersion}/node-${latestVersion}-win-x64.zip`;
    await rm('node.zip', { force: true });
    await download(downloadURL, 'node.zip');
    s.stop('npm downloaded');
  } catch (error) {
    s.stop('Error downloading npm', 2);
    throw error;
  }
  const s2 = spinner();
  s2.start('Extracting npm...');
  try {
    const zip = new AdmZip('node.zip');
    const extractAllTo = promisify(zip.extractAllToAsync.bind(zip));
    await extractAllTo('', true, false);
    await rm(outputPath, { force: true });
    await rename(`node-${latestVersion}-win-x64`, outputPath);
    await rm('node.zip');
    s2.stop('npm extracted');
  } catch (error) {
    s2.stop('Error extracting npm', 2);
    throw error;
  }
}

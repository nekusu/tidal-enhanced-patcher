import { createWriteStream } from 'node:fs';
import { exists, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { log, spinner } from '@clack/prompts';
import asar from '@electron/asar';
import findProcess from 'find-process';
import versionInfo from 'win-version-info';

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
  let appVersionDirName: string | undefined;
  try {
    const TIDAL_VERSION = versionInfo(join(tidalPath, EXECUTABLE_NAME)).FileVersion;
    if (TIDAL_VERSION) appVersionDirName = `app-${TIDAL_VERSION.split('.').slice(0, 3).join('.')}`;
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
    log.error('Error looking for app directory');
    log.error((error as Error).message);
  }
}

export async function waitForTimoeout(timeout = 100) {
  return new Promise((resolve) => setTimeout(resolve, timeout));
}

export async function extractSourceFiles(asarFilePath: string, sourcePath: string) {
  const s = spinner();
  s.start('Extracting source files...');
  try {
    await rm(sourcePath, { recursive: true, force: true });
    // ensures that the spinner appears, although it will get stuck because asar.extractAll()
    // is synchronous
    await waitForTimoeout(100);
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
    const writer = createWriteStream(outputPath);
    // type error: https://github.com/DefinitelyTyped/DefinitelyTyped/discussions/65542#discussioncomment-6071004
    const body = response.body as unknown as ReadableStream<Uint8Array>;
    Readable.fromWeb(body).pipe(writer);
  }
}

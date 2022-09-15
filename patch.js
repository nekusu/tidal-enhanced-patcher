import asar from 'asar';
import { execSync } from 'child_process';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  tidalPath,
  isWindowsPlatform,
  existsInDefaultPath,
  getAppDirName,
  extractSourceFiles,
} from './utils.js';

function installDiscordRpcLib(sourcePath) {
  execSync('npm i discord-rpc', { cwd: sourcePath });
  console.log('discord-rpc installed succesfully');
}

function copyDiscordActivityFile(mainPath) {
  const discordScriptPath = join(mainPath, 'discord');
  const discordActivityFileName = 'DiscordActivity.js';

  mkdirSync(discordScriptPath);
  copyFileSync(discordActivityFileName, join(discordScriptPath, discordActivityFileName));
  console.log('DiscordActivity.js copied successfully');
}

function modifyMainControllerFile(mainPath) {
  const appPath = join(mainPath, 'app');
  const mainControllerFilePath = join(appPath, 'MainController.js');
  const mainControllerFile = readFileSync(mainControllerFilePath, { encoding: 'utf8' });
  let modifiedFile = mainControllerFile;

  // import DiscordActivity class
  const importLineIndex = modifiedFile.search('var _electron');
  modifiedFile = modifiedFile.substring(0, importLineIndex) +
    'var _DiscordActivity = _interopRequireDefault(require("../discord/DiscordActivity"));\n\n' +
    modifiedFile.substring(importLineIndex);

  // instantiate DiscordActivity
  const propertyDeclarationLineIndex = modifiedFile.search('let autoStartDelegate');
  modifiedFile = modifiedFile.substring(0, propertyDeclarationLineIndex) +
    'this.discordActivity = new _DiscordActivity.default("1004259730526584873", playbackStatusController);\n' +
    modifiedFile.substring(propertyDeclarationLineIndex);

  writeFileSync(mainControllerFilePath, modifiedFile);
  console.log('MainController.js modified successfully');
}

async function createAsarPackage(appResourcesPath, asarFilePath, sourcePath) {
  // renaming the file may cause data loss when an error occurs, copying the file is preferred
  // renameSync(asarFilePath, join(appResourcesPath, 'app_original.asar'));

  // backup original .asar file
  copyFileSync(asarFilePath, join(appResourcesPath, 'app_original.asar'));
  rmSync(asarFilePath);

  // remove osx resources to avoid errors
  rmSync(join(sourcePath, 'resources/osx'), { recursive: true });

  await asar.createPackage(sourcePath, asarFilePath);

  // cleanup source files
  rmSync(sourcePath, { recursive: true });
  console.log('Asar package created successfully');
}

async function main() {
  console.log('TIDAL Enhanced Patcher - https://github.com/nekusu');
  if (!isWindowsPlatform() || !existsInDefaultPath()) return;

  const appResourcesPath = join(tidalPath, getAppDirName(), 'resources');
  const asarFilePath = join(appResourcesPath, 'app.asar');
  const sourcePath = join(appResourcesPath, 'src');
  const mainPath = join(sourcePath, 'app/main');

  extractSourceFiles(asarFilePath, sourcePath);
  installDiscordRpcLib(sourcePath);
  copyDiscordActivityFile(mainPath);
  modifyMainControllerFile(mainPath);
  await createAsarPackage(appResourcesPath, asarFilePath, sourcePath);
  console.log('TIDAL patched successfully');
}

main();

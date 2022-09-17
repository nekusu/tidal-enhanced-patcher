import asar from 'asar';
import { execSync } from 'child_process';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  tidalPath,
  isWindowsPlatform,
  isAppRunning,
  existsInDefaultPath,
  getAppDirName,
  extractSourceFiles,
} from './utils.js';

function installDiscordRpcLib(sourcePath) {
  execSync('npm i discord-rpc', { cwd: sourcePath });
  console.log('discord-rpc library installed succesfully');
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

function createDiscordActivity(mainPath) {
  const discordScriptPath = join(mainPath, 'discord');
  const discordActivityFileName = 'DiscordActivity.js';
  const mainControllerFilePath = join(mainPath, 'app/MainController.js');

  mkdirSync(discordScriptPath);
  copyFileSync(discordActivityFileName, join(discordScriptPath, discordActivityFileName));
  injectCode(mainControllerFilePath, [
    {
      reference: 'var _electron',
      code: 'var _DiscordActivity = _interopRequireDefault(require("../discord/DiscordActivity"));',
    }, {
      reference: 'let autoStartDelegate',
      code: `this.discordActivity = new _DiscordActivity.default(
        '1004259730526584873',
        this.userSettingsController,
        playbackStatusController,
      );`,
    }
  ]);
  console.log('DiscordActivity created successfully');
}

function createDiscordRpcSetting(mainPath) {
  const userPath = join(mainPath, 'user');
  const userSettingsKeysEnumFilePath = join(userPath, 'UserSettingsKeysEnum.js');
  const userSettingsControllerFilePath = join(userPath, 'UserSettingsController.js');

  injectCode(userSettingsKeysEnumFilePath, [
    {
      reference: 'UserSettingsKeys["CLOSE_TO_TRAY"]',
      code: 'UserSettingsKeys["DISCORD_RPC_DISABLED"] = "discord.rpc.disabled";',
    }
  ]);
  injectCode(userSettingsControllerFilePath, [
    {
      reference: '[_UserSettingsKeysEnum.default.CLOSE_TO_TRAY]',
      code: '[_UserSettingsKeysEnum.default.DISCORD_RPC_DISABLED]: false,',
    }, {
      reference: 'closeToTray:',
      code: 'discordRpcDisabled: _UserSettingsKeysEnum.default.DISCORD_RPC_DISABLED,',
    }
  ]);
  console.log('Discord RPC setting created successfully');
}

function createDiscordRpcToggle(mainPath) {
  const mainControllerFilePath = join(mainPath, 'app/MainController.js');
  const windowControllerFilePath = join(mainPath, 'window/WindowController.js');

  injectCode(mainControllerFilePath, [
    {
      reference: 'applicationDelegate, menuController',
      code: 'this.userSettingsController, ',
      newLine: false,
    }
  ]);
  injectCode(windowControllerFilePath, [
    {
      reference: 'var _electron',
      code: `var _UserSettingsController = _interopRequireDefault(require("../user/UserSettingsController"));
        var _UserSettingsKeysEnum = _interopRequireDefault(require("../user/UserSettingsKeysEnum"));`,
    }, {
      reference: 'applicationDelegate, menuController',
      code: 'userSettingsController, ',
      newLine: false,
    }, {
      reference: 'this.applicationDelegate =',
      code: 'this.userSettingsController = userSettingsController;',
    }, {
      reference: `type: 'separator'`,
      code: `label: 'Discord Rich Presence',
        type: 'checkbox',
        checked: !this.userSettingsController.get(_UserSettingsKeysEnum.default.DISCORD_RPC_DISABLED),
        click: () => {
          const discordRpcDisabledEnum = _UserSettingsKeysEnum.default.DISCORD_RPC_DISABLED;
          const discordRpcDisabled = this.userSettingsController.get(discordRpcDisabledEnum);
          this.userSettingsController.set(discordRpcDisabledEnum, !discordRpcDisabled);
        }
      }, {`,
    }
  ]);
  console.log('Discord RPC toggle created successfully');
}

function enableDevMenu(mainPath) {
  const menuControllerFilePath = join(mainPath, 'menu/MenuController.js');

  injectCode(menuControllerFilePath, [
    {
      reference: /process.env.NODE_ENV === 'development'/g,
      code: 'true',
      replace: true,
    }
  ]);
  console.log('Dev menu enabled successfully');
}

function addGithubToHelpMenu(mainPath) {
  const menuPath = join(mainPath, 'menu');
  const menuEventEnumFilePath = join(menuPath, 'MenuEventEnum.js');
  const helpMenuFilePath = join(menuPath, 'helpMenu.js');
  const menuControllerFilePath = join(menuPath, 'MenuController.js');

  injectCode(menuEventEnumFilePath, [
    {
      reference: 'MenuEvent["SUPPORT"]',
      code: 'MenuEvent["TEP_GITHUB"] = "tep.github";',
    }
  ]);
  injectCode(helpMenuFilePath, [
    {
      reference: `label: settings.locale.data['t-support']`,
      code: `label: 'TIDAL Enhanced Github',
        id: _MenuEventEnum.default.TEP_GITHUB,
        enabled: true,
        type: 'normal',
        click: delegate.menuClick.bind(delegate)
      }, {`
    }
  ]);
  injectCode(menuControllerFilePath, [
    {
      reference: 'case _MenuEventEnum.default.SUPPORT:',
      code: `case _MenuEventEnum.default.TEP_GITHUB:
        _electron.shell.openExternal('https://github.com/nekusu/tidal-enhanced-patcher');
        break;`
    }
  ]);
  console.log('TEP Github link added to help menu successfully');
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
  if (!isWindowsPlatform() || await isAppRunning() || !existsInDefaultPath()) return;

  const appResourcesPath = join(tidalPath, getAppDirName(), 'resources');
  const asarFilePath = join(appResourcesPath, 'app.asar');
  const sourcePath = join(appResourcesPath, 'src');
  const mainPath = join(sourcePath, 'app/main');

  extractSourceFiles(asarFilePath, sourcePath);
  installDiscordRpcLib(sourcePath);
  createDiscordActivity(mainPath);
  createDiscordRpcSetting(mainPath);
  createDiscordRpcToggle(mainPath);
  enableDevMenu(mainPath);
  addGithubToHelpMenu(mainPath);
  await createAsarPackage(appResourcesPath, asarFilePath, sourcePath);
  console.log('TIDAL patched successfully');
}

main();

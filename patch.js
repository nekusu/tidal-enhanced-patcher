import asar from 'asar';
import { execSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  tidalPath,
  isWindowsPlatform,
  isAppRunning,
  existsInDefaultPath,
  getAppDirName,
  extractSourceFiles,
  injectCode,
  download,
} from './utils.js';

const DISCORD_CLIENT_ID = '1004259730526584873';
const TIDAL_DL_EXE_URL = 'https://github.com/yaronzz/Tidal-Media-Downloader/raw/master/TIDALDL-PY/exe/tidal-dl.exe';

function installDiscordRpcLib(sourcePath) {
  execSync('npm i discord-rpc', { cwd: sourcePath });
  console.log('discord-rpc library installed');
}

async function downloadTidalDl() {
  const homePath = process.env.USERPROFILE;
  const tidalDlExePath = join(tidalPath, 'tidal-dl.exe');
  if (!existsSync(tidalDlExePath)) {
    await download(TIDAL_DL_EXE_URL, tidalDlExePath);
  }
  const config = {
    albumFolderFormat: '{ArtistName}/{Flag} {AlbumTitle} [{AlbumID}] [{AlbumYear}]',
    apiKeyIndex: 4,
    audioQuality: 'Master',
    checkExist: true,
    downloadPath: join(homePath, 'Music'),
    includeEP: true,
    language: 0,
    lyricFile: false,
    multiThread: true,
    saveAlbumInfo: false,
    saveCovers: true,
    showProgress: true,
    showTrackInfo: true,
    trackFileFormat: '{TrackNumber} - {ArtistName} - {TrackTitle}{ExplicitFlag}',
    usePlaylistFolder: true,
    videoFileFormat: '{VideoNumber} - {ArtistName} - {VideoTitle}{ExplicitFlag}',
    videoQuality: 'P1080',
  };
  const configJson = JSON.stringify(config);
  writeFileSync(join(homePath, '.tidal-dl.json'), configJson);
  console.log('TIDAL Media Downloader installed');
}

function createDiscordActivity(mainPath) {
  const discordScriptPath = join(mainPath, 'discord');
  const discordActivityFileName = 'DiscordActivity.js';
  const mainControllerFilePath = join(mainPath, 'app/MainController.js');

  mkdirSync(discordScriptPath);
  copyFileSync(discordActivityFileName, join(discordScriptPath, discordActivityFileName));
  injectCode(mainControllerFilePath, [{
    reference: 'var _electron',
    code: 'var _DiscordActivity = _interopRequireDefault(require("../discord/DiscordActivity"));',
  }, {
    reference: 'let autoStartDelegate',
    code: `this.discordActivity = new _DiscordActivity.default(
      '${DISCORD_CLIENT_ID}',
      this.userSettingsController,
      playbackStatusController,
    );`,
  }]);
  console.log('DiscordActivity created');
}

function createDiscordRpcSetting(mainPath) {
  const userPath = join(mainPath, 'user');
  const userSettingsKeysEnumFilePath = join(userPath, 'UserSettingsKeysEnum.js');
  const userSettingsControllerFilePath = join(userPath, 'UserSettingsController.js');

  injectCode(userSettingsKeysEnumFilePath, [{
    reference: 'UserSettingsKeys["CLOSE_TO_TRAY"]',
    code: 'UserSettingsKeys["DISCORD_RPC_DISABLED"] = "discord.rpc.disabled";',
  }]);
  injectCode(userSettingsControllerFilePath, [{
    reference: '[_UserSettingsKeysEnum.default.CLOSE_TO_TRAY]',
    code: '[_UserSettingsKeysEnum.default.DISCORD_RPC_DISABLED]: false,',
  }, {
    reference: 'closeToTray:',
    code: 'discordRpcDisabled: _UserSettingsKeysEnum.default.DISCORD_RPC_DISABLED,',
  }]);
  console.log('Discord RPC setting created');
}

function createDiscordRpcToggle(mainPath) {
  const mainControllerFilePath = join(mainPath, 'app/MainController.js');
  const windowControllerFilePath = join(mainPath, 'window/WindowController.js');

  injectCode(mainControllerFilePath, [{
    reference: 'applicationDelegate, menuController',
    code: 'this.userSettingsController, ',
    newLine: false,
  }]);
  injectCode(windowControllerFilePath, [{
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
  }]);
  console.log('Discord RPC toggle created');
}

function enableDevMenu(mainPath) {
  const menuPath = join(mainPath, 'menu');
  const developerMenuFilePath = join(menuPath, 'developerMenu.js');
  const menuControllerFilePath = join(menuPath, 'MenuController.js');

  injectCode(developerMenuFilePath, [{
    reference: 'id: _MenuEventEnum.default.SHOW_RENDERER_DEVTOOLS',
    code: `accelerator: 'Ctrl+Shift+I',`,
  }]);
  injectCode(menuControllerFilePath, [{
    reference: /process.env.NODE_ENV === 'development'/g,
    code: 'true',
    replace: true,
  }]);
  console.log('Dev menu enabled');
}

function addDownloadMenu(mainPath) {
  const menuPath = join(mainPath, 'menu');
  const menuEventEnumFilePath = join(menuPath, 'MenuEventEnum.js');
  const menuControllerFilePath = join(menuPath, 'MenuController.js');
  const downloadMenuFileName = 'downloadMenu.js';

  injectCode(menuEventEnumFilePath, [{
    reference: 'MenuEvent["NAVIGATION"]',
    code: `MenuEvent["DOWNLOAD"] = "download";
      MenuEvent["OPEN_DL_GUI"] = "open.dl.gui";
      MenuEvent["OPEN_DL_CLI"] = "open.dl.cli";`,
  }]);
  injectCode(menuControllerFilePath, [{
    reference: 'var _electron',
    code: `var _path = require("path");
      var _child_process = require("child_process");
      var _config = require("../../shared/config/configuration");
      var _downloadMenu = _interopRequireDefault(require("./downloadMenu"));`,
  }, {
    reference: 'const menu',
    code: 'template.splice(1, 0, (0, _downloadMenu.default)(this));',
  }, {
    reference: 'case _MenuEventEnum.default.NAVIGATE_ABOUT:',
    code: `case _MenuEventEnum.default.OPEN_DL_GUI:
      _child_process.execFile(_path.join(_config.default.machineUUIDPath, 'tidal-dl.exe'), ['-g']);
      break;
    case _MenuEventEnum.default.OPEN_DL_CLI:
      _child_process.exec(\`start cmd /c \${_path.join(_config.default.machineUUIDPath, 'tidal-dl.exe')}\`);
      break;`,
  }]);
  copyFileSync(downloadMenuFileName, join(menuPath, downloadMenuFileName));
  console.log('Download menu added');
}

function addLinksToHelpMenu(mainPath) {
  const menuPath = join(mainPath, 'menu');
  const menuEventEnumFilePath = join(menuPath, 'MenuEventEnum.js');
  const helpMenuFilePath = join(menuPath, 'helpMenu.js');
  const menuControllerFilePath = join(menuPath, 'MenuController.js');

  injectCode(menuEventEnumFilePath, [{
    reference: 'MenuEvent["SUPPORT"]',
    code: `MenuEvent["GITHUB_TEP"] = "github.tep";
      MenuEvent["GITHUB_TDL"] = "github.tdl";`,
  }]);
  injectCode(helpMenuFilePath, [{
    reference: `label: settings.locale.data['t-support']`,
    code: `label: 'About TIDAL Enhanced',
      id: _MenuEventEnum.default.GITHUB_TEP,
      enabled: true,
      type: 'normal',
      click: delegate.menuClick.bind(delegate)
    }, {
      label: 'About TIDAL Downloader',
      id: _MenuEventEnum.default.GITHUB_TDL,
      enabled: true,
      type: 'normal',
      click: delegate.menuClick.bind(delegate)
    }, {`,
  }]);
  injectCode(menuControllerFilePath, [{
    reference: 'case _MenuEventEnum.default.SUPPORT:',
    code: `case _MenuEventEnum.default.GITHUB_TEP:
      _electron.shell.openExternal('https://github.com/nekusu/tidal-enhanced-patcher');
      break;
    case _MenuEventEnum.default.GITHUB_TDL:
      _electron.shell.openExternal('https://github.com/yaronzz/Tidal-Media-Downloader');
      break;`,
  }]);
  console.log('Github links added to Help menu');
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
  console.log('Asar package created');
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
  await downloadTidalDl();
  addDownloadMenu(mainPath);
  addLinksToHelpMenu(mainPath);
  await createAsarPackage(appResourcesPath, asarFilePath, sourcePath);
  console.log('TIDAL patched successfully');
}

main();

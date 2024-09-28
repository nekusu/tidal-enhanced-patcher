import { copyFile, exists, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cancel, confirm, isCancel, log, spinner } from '@clack/prompts';
import asar from '@electron/asar';
import spawn from 'nano-spawn';
import { download, extractSourceFiles, injectCode, tidalPath } from '../utils';
import { unpatch } from './unpatch';

// alternative way of writing the files to the filesystem
// import DiscordActivity from '../files/DiscordActivity.js' with { type: 'text' };
// import downloadMenu from '../files/downloadMenu.js' with { type: 'text' };

const DISCORD_CLIENT_ID = '1004259730526584873';
const TIDAL_DL_EXE_URL =
  'https://github.com/yaronzz/Tidal-Media-Downloader/raw/master/TIDALDL-PY/exe/tidal-dl.exe';

async function checkNPM() {
  const s = spinner();
  s.start('Checking if npm is installed...');
  try {
    const { stdout, stderr } = await spawn('npm', ['--version']);
    if (stderr) throw new Error(stderr);
    s.stop(`npm installed: v${stdout}`);
  } catch (error) {
    s.stop('npm is not installed', 2);
    throw error;
  }
}

async function installDiscordRpcPackage(sourcePath: string) {
  const s = spinner();
  s.start('Installing discord-rpc package...');
  try {
    const { stderr } = await spawn('npm', ['i', '@xhayper/discord-rpc'], { cwd: sourcePath });
    if (stderr.includes('error')) throw new Error(stderr);
    s.stop('discord-rpc package installed');
    if (stderr.includes('warn')) log.warn(stderr);
  } catch (error) {
    s.stop('Error installing discord-rpc package', 2);
    throw error;
  }
}

async function downloadTidalDl() {
  const homePath = import.meta.env.USERPROFILE ?? `C:\\Users\\${import.meta.env.USERNAME}`;
  const tidalDlExePath = join(tidalPath, 'tidal-dl.exe');

  if (await exists(tidalDlExePath))
    log.info('Tidal Media Downloader already exists. Skipping download...');
  else {
    const s = spinner();
    s.start('Downloading Tidal Media Downloader...');
    try {
      await download(TIDAL_DL_EXE_URL, tidalDlExePath);
      s.stop('Tidal Media Downloader installed');
    } catch (error) {
      s.stop('Error downloading Tidal Media Downloader', 2);
      throw error;
    }
  }

  const configFilePath = join(homePath, '.tidal-dl.json');
  if (!(await exists(configFilePath))) {
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
    await writeFile(join(homePath, '.tidal-dl.json'), JSON.stringify(config));
    log.success('TIDAL Media Downloader config file created');
  }
}

async function createDiscordActivity(mainPath: string) {
  const discordScriptPath = join(mainPath, 'discord');
  const discordActivityFileName = './files/DiscordActivity.js';
  const mainControllerFilePath = join(mainPath, 'app/MainController.js');

  await mkdir(discordScriptPath);
  // await writeFile(
  //   join(discordScriptPath, discordActivityFileName),
  //   DiscordActivity as unknown as string,
  // );
  await copyFile(discordActivityFileName, join(discordScriptPath, 'DiscordActivity.js'));
  await injectCode(mainControllerFilePath, [
    {
      reference: /var _electron/,
      code: 'var _DiscordActivity = _interopRequireDefault(require("../discord/DiscordActivity"));',
    },
    {
      reference: /let autoStartDelegate/,
      code: `this.discordActivity = new _DiscordActivity.default(
        '${DISCORD_CLIENT_ID}',
        this.userSettingsController,
        playbackStatusController,
      );`,
    },
  ]);
  log.success('DiscordActivity created');
}

async function createDiscordRpcSetting(mainPath: string) {
  const userPath = join(mainPath, 'user');
  const userSettingsKeysEnumFilePath = join(userPath, 'UserSettingsKeysEnum.js');
  const userSettingsControllerFilePath = join(userPath, 'UserSettingsController.js');

  await injectCode(userSettingsKeysEnumFilePath, [
    {
      reference: /UserSettingsKeys\["CLOSE_TO_TRAY"\]/,
      code: 'UserSettingsKeys["DISCORD_RPC_DISABLED"] = "discord.rpc.disabled";',
    },
  ]);
  await injectCode(userSettingsControllerFilePath, [
    {
      reference: /\[_UserSettingsKeysEnum\.default\.CLOSE_TO_TRAY\]/,
      code: '[_UserSettingsKeysEnum.default.DISCORD_RPC_DISABLED]: false,',
    },
    {
      reference: /closeToTray:/,
      code: 'discordRpcDisabled: _UserSettingsKeysEnum.default.DISCORD_RPC_DISABLED,',
    },
  ]);
  log.success('Discord RPC setting created');
}

async function modifyTrayMenu(mainPath: string) {
  const mainControllerFilePath = join(mainPath, 'app/MainController.js');
  const windowControllerFilePath = join(mainPath, 'window/WindowController.js');

  await injectCode(mainControllerFilePath, [
    {
      reference: /applicationDelegate, menuController/,
      code: 'this.userSettingsController, ',
      type: 'exact',
    },
  ]);
  await injectCode(windowControllerFilePath, [
    {
      reference: /var _electron/,
      code: 'var _UserSettingsKeysEnum = _interopRequireDefault(require("../user/UserSettingsKeysEnum"));',
    },
    {
      reference: /applicationDelegate, menuController/,
      code: 'userSettingsController, ',
      type: 'exact',
    },
    {
      reference: /this\.applicationDelegate =/,
      code: 'this.userSettingsController = userSettingsController;',
    },
    {
      reference: /this\.setThumbBarButtons\(!!isPlaying\);/,
      code: 'this.buildTrayMenu(!!isPlaying);',
    },
    {
      reference: /this\.buildTrayMenu\(\);/g,
      code: 'this.buildTrayMenu(false);',
      type: 'replace',
    },
    {
      reference: /buildTrayMenu\(\) {/,
      code: 'buildTrayMenu(isPlaying) {',
      type: 'replace',
    },
    {
      reference: /const contextMenu = _electron\.Menu\.buildFromTemplate/,
      code: `label: isPlaying ? bundle.data['t-pause'] : bundle.data['t-play'],
        click: () => {
          if (isPlaying) {
            playbackActions.pause();
          } else {
            playbackActions.resume();
          }
        },
      }, {
        label: bundle.data['t-previous'],
        click: () => playbackActions.playPrevious(),
      }, {
        label: bundle.data['t-next'],
        click: () => playbackActions.playNext(),
      }, {
        type: 'separator',
      }, {
        label: 'Discord Rich Presence',
        type: 'checkbox',
        checked: !this.userSettingsController.get(_UserSettingsKeysEnum.default.DISCORD_RPC_DISABLED),
        click: () => {
          const discordRpcDisabledEnum = _UserSettingsKeysEnum.default.DISCORD_RPC_DISABLED;
          const discordRpcDisabled = this.userSettingsController.get(discordRpcDisabledEnum);
          this.userSettingsController.set(discordRpcDisabledEnum, !discordRpcDisabled);
        }
      }, {`,
    },
  ]);
  log.success('Tray menu modified');
}

async function enableDevMenu(mainPath: string) {
  const menuPath = join(mainPath, 'menu');
  const developerMenuFilePath = join(menuPath, 'developerMenu.js');
  const menuControllerFilePath = join(menuPath, 'MenuController.js');

  await injectCode(developerMenuFilePath, [
    {
      reference: /id: _MenuEventEnum\.default\.SHOW_RENDERER_DEVTOOLS/,
      code: `accelerator: 'Ctrl+Shift+I',`,
    },
  ]);
  await injectCode(menuControllerFilePath, [
    {
      reference: /process\.env\.NODE_ENV === 'development'/g,
      code: 'true',
      type: 'replace',
    },
  ]);
  log.success('Dev menu enabled');
}

async function addLinksToHelpMenu(mainPath: string) {
  const menuPath = join(mainPath, 'menu');
  const menuEventEnumFilePath = join(menuPath, 'MenuEventEnum.js');
  const helpMenuFilePath = join(menuPath, 'helpMenu.js');
  const menuControllerFilePath = join(menuPath, 'MenuController.js');

  await injectCode(menuEventEnumFilePath, [
    {
      reference: /MenuEvent\["SUPPORT"\]/,
      code: `MenuEvent["GITHUB_TEP"] = "github.tep";
        MenuEvent["GITHUB_TDL"] = "github.tdl";`,
    },
  ]);
  await injectCode(helpMenuFilePath, [
    {
      reference: /label: settings\.locale\.data\['t-about'\]/,
      code: `label: 'About TIDAL Enhanced',
        id: _MenuEventEnum.default.GITHUB_TEP,
        enabled: true,
        type: 'normal',
        click: delegate.menuClick.bind(delegate)
      }, {
        label: 'About TIDAL Media Downloader',
        id: _MenuEventEnum.default.GITHUB_TDL,
        enabled: true,
        type: 'normal',
        click: delegate.menuClick.bind(delegate)
      }, {`,
      offset: 2,
    },
  ]);
  await injectCode(menuControllerFilePath, [
    {
      reference: /case _MenuEventEnum\.default\.SUPPORT:/,
      code: `case _MenuEventEnum.default.GITHUB_TEP:
        _electron.shell.openExternal('https://github.com/nekusu/tidal-enhanced-patcher');
        break;
      case _MenuEventEnum.default.GITHUB_TDL:
        _electron.shell.openExternal('https://github.com/yaronzz/Tidal-Media-Downloader');
        break;`,
      offset: -1,
    },
  ]);
  log.success('GitHub links added to Help menu');
}

async function addDownloadMenu(mainPath: string) {
  const menuPath = join(mainPath, 'menu');
  const menuEventEnumFilePath = join(menuPath, 'MenuEventEnum.js');
  const menuControllerFilePath = join(menuPath, 'MenuController.js');
  const downloadMenuFileName = './files/downloadMenu.js';

  // await writeFile(join(menuPath, downloadMenuFileName), downloadMenu as unknown as string);
  await copyFile(downloadMenuFileName, join(menuPath, 'downloadMenu.js'));
  await injectCode(menuEventEnumFilePath, [
    {
      reference: /MenuEvent\["NAVIGATION"\]/,
      code: `MenuEvent["DOWNLOAD"] = "download";
        MenuEvent["OPEN_DL_GUI"] = "open.dl.gui";
        MenuEvent["OPEN_DL_CLI"] = "open.dl.cli";`,
    },
  ]);
  await injectCode(menuControllerFilePath, [
    {
      reference: /var _electron/,
      code: `var child_process = _interopRequireWildcard(require("child_process"));
        var _config = _interopRequireDefault(require("../config/windowsConfiguration"));
        var _downloadMenu = _interopRequireDefault(require("./downloadMenu"));`,
    },
    {
      reference: /const menu/,
      code: 'template.splice(1, 0, (0, _downloadMenu.default)(this));',
      offset: -1,
    },
    {
      reference: /case _MenuEventEnum\.default\.NAVIGATE_ABOUT:/,
      code: `case _MenuEventEnum.default.OPEN_DL_GUI:
        child_process.execFile(path.join(_config.default.machineUUIDPath, 'tidal-dl.exe'), ['-g']);
        break;
      case _MenuEventEnum.default.OPEN_DL_CLI:
        child_process.exec(\`start cmd /c \${path.join(_config.default.machineUUIDPath, 'tidal-dl.exe')}\`);
        break;`,
      offset: -2,
    },
  ]);
  log.success('Download menu created');
}

async function bundleAsarPackage(
  appResourcesPath: string,
  asarFilePath: string,
  sourcePath: string,
) {
  // renaming the file may cause data loss when an error occurs, copying the file is preferred
  // renameSync(asarFilePath, join(appResourcesPath, 'app_original.asar'));

  const originalAsarFilePath = join(appResourcesPath, 'app_original.asar');
  await copyFile(asarFilePath, originalAsarFilePath);
  await rm(asarFilePath);
  log.info(`Original asar file backed up in ${appResourcesPath}`);

  const s = spinner();
  s.start('Bundling asar package...');
  try {
    await asar.createPackage(sourcePath, asarFilePath);
    s.stop('Asar package bundled');
  } catch (error) {
    await copyFile(originalAsarFilePath, asarFilePath);
    s.stop('Error bundling asar package. Original asar file restored', 2);
    throw error;
  } finally {
    const shouldRemove = await confirm({ message: 'Remove source files? (recommended)' });
    if (isCancel(shouldRemove)) cancel('Operation cancelled');
    else if (shouldRemove) {
      const s = spinner();
      s.start('Removing source files...');
      await rm(sourcePath, { recursive: true });
      s.stop('Source files removed');
    }
  }
}

export async function patch(appResourcesPath: string) {
  const asarFilePath = join(appResourcesPath, 'app.asar');
  const originalAsarFilePath = join(appResourcesPath, 'app_original.asar');
  const sourcePath = join(appResourcesPath, 'src');
  const mainPath = join(sourcePath, 'app/main');

  try {
    if (await exists(originalAsarFilePath)) {
      log.info('TIDAL is already patched. Unpatching...');
      await unpatch(appResourcesPath);
    }
    await extractSourceFiles(asarFilePath, sourcePath);
    await checkNPM();
    await installDiscordRpcPackage(sourcePath);
    await createDiscordActivity(mainPath);
    await createDiscordRpcSetting(mainPath);
    await modifyTrayMenu(mainPath);
    await addLinksToHelpMenu(mainPath);
    const shouldEnableDevMenu = await confirm({ message: 'Enable dev menu?' });
    if (isCancel(shouldEnableDevMenu)) cancel('Operation cancelled');
    else if (shouldEnableDevMenu) await enableDevMenu(mainPath);
    const shouldDownload = await confirm({ message: 'Download TIDAL Media Downloader?' });
    if (isCancel(shouldDownload)) cancel('Operation cancelled');
    else if (shouldDownload) {
      await downloadTidalDl();
      await addDownloadMenu(mainPath);
    }
    await bundleAsarPackage(appResourcesPath, asarFilePath, sourcePath);
    log.success('TIDAL patched successfully');
  } catch (error) {
    log.error((error as Error).message);
    log.info('TIDAL could not be patched. Check the logs above for more information');
  }
}

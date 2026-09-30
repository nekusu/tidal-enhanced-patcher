import { copyFile, exists, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { confirm, isCancel, log, select, spinner, text } from '@clack/prompts';
import { createPackageWithOptions } from '@electron/asar';
import { execa } from 'execa';
import DiscordActivity from '../files/DiscordActivity.js' with { type: 'text' };
import { downloadNpm, extractSourceFiles, injectCode, isMacPlatform } from '../utils';
import { addNativeDownloads } from './downloads';
import { unpatch } from './unpatch';

const DISCORD_CLIENT_ID = '1004259730526584873';

async function checkNpmInstallation() {
  let npmPath: string | undefined;
  try {
    const { stdout } = await execa(isMacPlatform ? 'which' : 'where.exe', ['npm'], {
      reject: false,
    });
    npmPath = stdout.split('\n')[0]?.trim();
    if (!npmPath) {
      const downloadedNpmPath = join(
        process.cwd(),
        isMacPlatform ? 'node/bin/npm' : 'node/npm.cmd',
      );
      if (await exists(downloadedNpmPath)) npmPath = downloadedNpmPath;
      else throw new Error('npm could not be found in PATH');
    }
    log.info(`Using npm from: ${npmPath}`);
  } catch (error) {
    log.error(`npm could not be found: ${(error as Error).message}`);
    const option = await select({
      message: 'Select an option:',
      options: [
        {
          value: 'download',
          label: 'Download npm',
          hint: 'Select if you do not have npm installed',
        },
        {
          value: 'path',
          label: 'Enter npm path manually',
          hint: 'Select if you have npm installed but it was not found',
        },
      ],
    });
    if (isCancel(option)) throw new Error('Cancelled');
    if (option === 'download') {
      await downloadNpm();
      return await checkNpmInstallation();
    }
    const manualNpmPath = await text({
      message: 'Enter path',
      placeholder: isMacPlatform
        ? '/usr/local/bin/npm'
        : `C:\\Users\\${import.meta.env.USERNAME}\\AppData\\Roaming\\npm\\npm.cmd`,
    });
    if (isCancel(manualNpmPath)) throw new Error('Cancelled');
    npmPath = manualNpmPath;
  }
  try {
    const { stdout: npmVersion } = await execa`${npmPath} -v`;
    log.info(`npm version: ${npmVersion}`);
  } catch (error) {
    log.error('Error checking npm version');
    throw error;
  }
  return npmPath;
}

async function installRuntimePackages(sourcePath: string, npmPath: string) {
  const s = spinner();
  s.start('Installing Discord RPC and native download helpers...');
  try {
    const { stderr } = await execa(
      npmPath,
      ['install', '@xhayper/discord-rpc', 'fast-xml-parser@5.11.2', 'ffmpeg-static@5.3.0'],
      {
        cwd: sourcePath,
      },
    );
    s.stop('Discord RPC and native download helpers installed');
    if (stderr.includes('npm warn')) log.warn(stderr);
  } catch (error) {
    s.stop('Error installing runtime packages', 2);
    throw error;
  }
}

async function createDiscordActivity(mainPath: string) {
  const discordScriptPath = join(mainPath, 'discord');
  const discordActivityFileName = 'DiscordActivity.js';
  const mainControllerFilePath = join(mainPath, 'app/MainController.js');

  await mkdir(discordScriptPath);
  await writeFile(
    join(discordScriptPath, discordActivityFileName),
    DiscordActivity as unknown as string,
  );
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
    ...(isMacPlatform
      ? [
          {
            reference: /if \(!this\.tray \|\| process\.platform !== 'win32'\) {/,
            code: `if (!this.tray || (process.platform !== 'win32' && process.platform !== 'darwin')) {`,
            type: 'replace' as const,
          },
          {
            reference:
              /if \(process\.platform !== 'win32' \|\| !this\.closeToTray \|\| this\.tray instanceof _electron\.Tray\) {/,
            code: `if ((process.platform !== 'win32' && process.platform !== 'darwin') || !this.closeToTray || this.tray instanceof _electron.Tray) {`,
            type: 'replace' as const,
          },
          {
            reference:
              /this\.tray = new _electron\.Tray\(_electron\.nativeImage\.createFromPath\(path\.resolve\(`\$\{__dirname\}\/\.\.\/\.\.\/assets\/icons\/icon\.png`\)\)\);/,
            code: `this.tray = new _electron.Tray(_electron.nativeImage.createFromPath(path.resolve(\`\${__dirname}/../../assets/icons/icon.png\`)).resize({ width: 18, height: 18 }));`,
            type: 'replace' as const,
          },
        ]
      : []),
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
      code: 'MenuEvent["GITHUB_TEP"] = "github.tep";',
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
      `,
      offset: -1,
    },
  ]);
  log.success('GitHub links added to Help menu');
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
    await createPackageWithOptions(sourcePath, asarFilePath, { unpackDir: '**/ffmpeg-static' });
    s.stop('Asar package bundled');
  } catch (error) {
    await copyFile(originalAsarFilePath, asarFilePath);
    s.stop('Error bundling asar package. Original asar file restored', 2);
    throw error;
  } finally {
    const shouldRemove = await confirm({ message: 'Remove source files? (recommended)' });
    if (isCancel(shouldRemove)) log.error('Cancelled');
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
      log.warn('TIDAL is already patched');
      await unpatch(appResourcesPath);
    }
    const npmPath = await checkNpmInstallation();
    await extractSourceFiles(asarFilePath, sourcePath);
    await addNativeDownloads(sourcePath);
    log.success('Native download menus and queue installed');
    await installRuntimePackages(sourcePath, npmPath);
    await createDiscordActivity(mainPath);
    await createDiscordRpcSetting(mainPath);
    await modifyTrayMenu(mainPath);
    await addLinksToHelpMenu(mainPath);
    const shouldEnableDevMenu = await confirm({ message: 'Enable dev menu?' });
    if (isCancel(shouldEnableDevMenu)) log.error('Cancelled');
    else if (shouldEnableDevMenu) await enableDevMenu(mainPath);
    await bundleAsarPackage(appResourcesPath, asarFilePath, sourcePath);
    log.success('TIDAL patched successfully');
  } catch (error) {
    log.error((error as Error).message);
    log.info('TIDAL could not be patched. Check the logs above for more information');
  }
}

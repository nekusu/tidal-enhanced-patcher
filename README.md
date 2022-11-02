<h1 align="center">TIDAL Enhanced Patcher</h1>

<p align="center">
  <img src="./assets/tidal-enhanced-icon.png" width="220" />
</p>

TIDAL Enhanced Patcher is a simple script that allows you to extend the functionality of the TIDAL desktop app by modifying the [ASAR archive](https://www.electronjs.org/docs/latest/tutorial/asar-archives).

## Features

### Discord Rich Presence integration

<img src="./assets/discord-rpc.png" width="310" />

Unlike many other [awesome repositories](https://github.com/search?q=tidal+discord) trying to address the lack of official Discord RPC integration, TEP directly modifies the source code so there is no need to run scripts in the background, reverse engineer the TIDAL API, or use third-party APIs. A native-like experience!

### Download your favorite music

<img src="./assets/download-menu.png" width="310" />

TIDAL Enhanced allows you to download music and videos in the highest quality directly from TIDAL thanks to the [Media Downloader](https://github.com/yaronzz/Tidal-Media-Downloader) app, just paste the track/album/artist link in the downloader and enjoy your offline music!

### Improved system tray menu

<img src="./assets/system-tray.png" width="310" />

Playback controls and a Discord RPC switch can be quickly accessed from the system tray menu.

### Developer menu enabled

<img src="./assets/dev-menu.png" width="310" />

You can now access various development tools disabled by default in the production build.

## Usage

**Only Windows platforms are supported.** [Node.js](https://github.com/coreybutler/nvm-windows) required.

```sh
git clone https://github.com/nekusu/tidal-enhanced-patcher.git
cd tidal-enhanced-patcher
npm i
node patch
```

The script will automatically find the app path, extract the source code, patch it, and create the asar package. A backup of the original file will be created.

**App updates will sometimes require running the patcher again.**

You can undo the changes by running the following command:

```sh
node unpatch
```

Alternatively, you can go to `C:\Users\[user]\AppData\Local\TIDAL\app-[version]\resources`, remove the `app.asar` file, and rename the `app_original.asar` file to `app.asar`.

To manually extract the source code files use:

```sh
node extract
```

## Roadmap

- [x] Discord RPC toggle in system tray menu.
- [x] Integration with [Tidal-Media-Downloader](https://github.com/yaronzz/Tidal-Media-Downloader).
- [ ] Auto-patch source code after an app update.
- [ ] MacOS support (?).

## Disclaimer

- [TIDAL Media Downloader disclaimer](https://github.com/yaronzz/Tidal-Media-Downloader#-disclaimer).
- This repository does not distribute any original or modified source code of the TIDAL desktop app.
- I am in no way responsible for account bans for using a modified client. Use the patcher at your own risk.

## Acknowledgments

[Debugtron](https://github.com/bytedance/debugtron) made this project possible, check it out!

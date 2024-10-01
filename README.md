<h1 align="center">TIDAL Enhanced Patcher</h1>

<p align="center">
  <img src="./assets/tidal-enhanced-icon.png" width="220" />
</p>

**TIDAL Enhanced Patcher** is a tool designed to easily extend the functionality of the TIDAL desktop app by modifying its [ASAR archive](https://www.electronjs.org/docs/latest/tutorial/asar-archives).

## Features

### Discord Rich Presence integration

<img src="./assets/discord-rpc.png" width="400" />

Unlike many other [awesome repositories](https://github.com/search?q=tidal+discord) trying to address the lack of official Discord RPC integration, TEP directly modifies the source code so there is no need to run scripts in the background, reverse engineer the TIDAL API, or use third-party APIs. A native-like experience!

### Download your favorite music

<img src="./assets/download-menu.png" width="300" />

TIDAL Enhanced allows you to download music and videos in the highest quality directly from TIDAL thanks to the [Media Downloader](https://github.com/yaronzz/Tidal-Media-Downloader) app, just paste the track/album/artist link in the downloader and enjoy your offline music!

### Improved system tray menu

<img src="./assets/system-tray.png" width="300" />

Playback controls and a Discord RPC switch can be quickly accessed from the system tray menu.

### Developer menu enabled

<img src="./assets/dev-menu.png" width="300" />

You can now access various development tools disabled by default in the production build.

## Usage

**Only Windows platforms are supported.**

**Note:** App updates may require running the patcher again.

### Using the Precompiled Executable

For users who prefer to download and run the patcher without setting up the development environment.

1. Download the executable:
   - Go to the [Releases](https://github.com/nekusu/tidal-enhanced-patcher/releases) page and download the `TIDALEnhancedPatcher.exe` file.

2. Run the patcher:
   - Double-click the downloaded file to launch the interactive CLI.

### Running from Source Code

For developers or users who want to run it directly from the source.

**Requirements:** You need to have [Bun](https://github.com/oven-sh/bun#install) installed on your system.

#### Installation

1. Clone the repository:
    ```sh
    git clone https://github.com/nekusu/tidal-enhanced-patcher.git
    cd tidal-enhanced-patcher
    ```

2. Install dependencies using Bun:
    ```sh
    bun i
    ```

3. Run the interactive CLI:
    ```sh
    bun main.ts
    ```
    **Alternatively, you can also build and run the executable** by running:
    ```sh
    bun run build
    .\TIDALEnhancedPatcher.exe
    ```

### CLI Features

The interactive CLI provides three main options: **patching**, **unpatching**, and **extracting source files**.

#### 1. Patching TIDAL

- The patcher will automatically detect whether TIDAL is running and find the executable.
- If the app is already patched, it will first **unpatch** the existing modifications and proceed with patching again.
- A backup of the original asar file is saved, and the app is re-bundled.

#### 2. Unpatching TIDAL

- The patcher will revert all changes made to the app, restoring the original asar file.
- Alternatively, you can go to `C:\Users\[user]\AppData\Local\TIDAL\app-[version]\resources`, remove the `app.asar` file, and rename the `app_original.asar` file to `app.asar`.

#### 3. Extracting Source Files

- The patcher will extract the source files from the asar archive.

## Disclaimer

- [TIDAL Media Downloader disclaimer](https://github.com/yaronzz/Tidal-Media-Downloader#-disclaimer).
- This repository does not distribute any original or modified source code of the TIDAL desktop app.
- I am in no way responsible for account bans for using a modified client. Use the patcher at your own risk.

## Acknowledgments

[Debugtron](https://github.com/bytedance/debugtron) made this project possible, check it out!

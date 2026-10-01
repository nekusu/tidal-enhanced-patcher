const { app, dialog, ipcMain, net, shell } = require('electron');
const fs = require('node:fs/promises');
const { homedir } = require('node:os');
const path = require('node:path');
const { DownloadEngine } = require('./engine.cjs');
const { ClientSession } = require('./session.cjs');
const { SettingsStore } = require('./settings.cjs');

class DownloadController {
  constructor(delegate) {
    this.delegate = delegate;
    this.settings = new SettingsStore(
      path.join(app.getPath('userData'), 'tep-downloads.json'),
      path.join(homedir(), '.tidal-dl.json'),
      app.getPath('music'),
    );
    const clientSession = new ClientSession(delegate);
    this.engine = new DownloadEngine({
      settings: this.settings,
      getSession: (apiSubStatus, signal) => clientSession.get(apiSubStatus, signal),
      fetch: (...args) => net.fetch(...args),
      ffmpegPath: require('ffmpeg-static').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'),
    });
    this.engine.on('change', () => {
      this.send('tep-downloads:state', this.state());
    });
    ipcMain.handle('tep-downloads:request', async (event, command, payload) => {
      if (!this.isTrusted(event))
        return { ok: false, error: 'Downloads are only available in the TIDAL window.' };
      try {
        return { ok: true, value: await this.handle(command, payload) };
      } catch (error) {
        return { ok: false, error: error.message || 'Download request failed.' };
      }
    });
    app.on('before-quit', () => this.engine.stop());
    delegate.userSessionController.getModel().on('userLoggedIn', (loggedIn) => {
      if (!loggedIn) for (const job of this.engine.jobs) this.engine.cancel(job.id);
    });
  }

  isTrusted(event) {
    const contents = this.delegate.mainWindow?.webContents;
    if (!contents || event.sender !== contents || event.senderFrame !== contents.mainFrame)
      return false;
    try {
      return new URL(event.senderFrame.url).origin === 'https://desktop.tidal.com';
    } catch {
      return false;
    }
  }

  state() {
    return {
      ...this.engine.snapshot(),
      settings: { ...this.settings.value },
      warning: this.settings.warning,
    };
  }

  send(channel, value) {
    const contents = this.delegate.mainWindow?.webContents;
    if (contents && !contents.isDestroyed()) contents.send(channel, value);
  }

  open(view = 'queue') {
    this.send('tep-downloads:open', { view, state: this.state() });
  }

  async handle(command, payload) {
    switch (command) {
      case 'state':
        return this.state();
      case 'enqueue':
        return this.engine.enqueue(payload);
      case 'cancel':
        this.engine.cancel(payload);
        return this.state();
      case 'pause':
        this.engine.setPaused(payload === true);
        return this.state();
      case 'clear':
        this.engine.clearFinished();
        return this.state();
      case 'retry': {
        const job = this.engine.jobs.find((item) => item.id === payload);
        if (!job || !['failed', 'cancelled'].includes(job.status))
          throw new Error('This download cannot be retried.');
        return this.engine.enqueue(job.reference);
      }
      case 'settings':
        this.settings.save(payload);
        return this.state();
      case 'choose-folder': {
        const result = await dialog.showOpenDialog(this.delegate.mainWindow, {
          title: 'Choose download folder',
          defaultPath: this.settings.value.downloadPath,
          properties: ['openDirectory', 'createDirectory'],
        });
        return result.canceled ? null : result.filePaths[0];
      }
      case 'open-folder': {
        await fs.mkdir(this.settings.value.downloadPath, { recursive: true });
        const error = await shell.openPath(this.settings.value.downloadPath);
        if (error) throw new Error(error);
        return null;
      }
      default:
        throw new Error('Unknown download action.');
    }
  }
}

module.exports = DownloadController;

Object.defineProperty(exports, '__esModule', { value: true });
exports.default = void 0;
const _electron = require('electron');
const _DiscordRPC = require('@xhayper/discord-rpc');
const _ = require('lodash');
const _AppEventEnum = _interopRequireDefault(require('../../shared/AppEventEnum'));
const _UserSettingsKeysEnum = _interopRequireDefault(require('../user/UserSettingsKeysEnum'));

function _interopRequireDefault(obj) {
  return obj?.__esModule ? obj : { default: obj };
}

class DiscordActivity {
  constructor(clientId, userSettingsController, playbackStatusController) {
    this.client = new _DiscordRPC.Client({ clientId });
    this.userSettingsController = userSettingsController;
    this.playbackStatusController = playbackStatusController;
    this.discordRpcDisabled = this.userSettingsController.get(
      _UserSettingsKeysEnum.default.DISCORD_RPC_DISABLED,
    );
    this.mediaItem = null;
    this.songTime = 0;
    this.isPlaying = false;
    this.activityTimeout = null;

    this.client.on('ready', () => {
      console.log('Discord RPC: Client ready');
    });

    console.log('Discord RPC: Logging into client');
    this.client.login().catch((error) => {
      console.error('Discord RPC: Login failed ->', error);
      console.log('Discord RPC: Retrying login in 5 seconds...');
      setTimeout(() => {
        this.client.login().catch((error) => console.error('Discord RPC: Login failed ->', error));
      }, 5000).unref();
    });

    // Check every second if Discord RPC has been disabled from the system tray
    // Possible improvement: integrate discordRpcDisabled value with redux store and
    // remove this unnecessary interval
    setInterval(() => {
      const disabled = this.userSettingsController.get(
        _UserSettingsKeysEnum.default.DISCORD_RPC_DISABLED,
      );
      if (this.discordRpcDisabled === disabled) return;
      if (disabled) this.client.user?.clearActivity();
      else this.debouncedUpdateActivity();
      console.log(`Discord RPC: ${disabled ? 'Disabled' : 'Enabled'} from system tray`);
      this.discordRpcDisabled = disabled;
    }, 1000);

    // Listen for media info
    _electron.ipcMain.on(_AppEventEnum.default.PLAYBACK_CURRENT_MEDIAITEM, (_, mediaItem) => {
      console.log('Discord RPC: Received media item ->', mediaItem);
      this.mediaItem = mediaItem;
      this.debouncedUpdateActivity();
    });

    // Listen for elapsed time
    _electron.ipcMain.on(_AppEventEnum.default.PLAYBACK_CURRENT_TIME, (_, time) => {
      const timeDifference = Math.abs(time - this.songTime);
      this.songTime = time;
      if (this.isPlaying && timeDifference > 1) {
        console.log('Discord RPC: Playback time difference ->', timeDifference);
        this.debouncedUpdateActivity();
      }
    });

    // Listen for isPlaying status
    this.playbackStatusController.getModel().on('playing', (isPlaying) => {
      console.log('Discord RPC: Playback status changed ->', isPlaying);
      this.isPlaying = isPlaying;
      this.debouncedUpdateActivity();
    });

    // Function debounced to prevent multiple calls when jumping to another song
    // due to multiple `PLAYBACK_CURRENT_TIME` events
    this.debouncedUpdateActivity = _.debounce(() => {
      this.updateActivity();
    }, 200);
  }

  updateActivity() {
    if (this.discordRpcDisabled) return;
    console.log('Discord RPC: Updating activity');
    clearTimeout(this.activityTimeout);

    const activity = {
      type: 2,
      details: this.mediaItem?.title,
      state: this.mediaItem?.artist,
      largeImageKey: this.mediaItem?.imageUrl,
      largeImageText: this.mediaItem?.album,
      smallImageKey: 'tidal',
      smallImageText: 'TIDAL Enhanced',
      buttons: this.mediaItem?.url
        ? [{ label: 'Play on TIDAL', url: this.mediaItem?.url }]
        : undefined,
      instance: true,
    };

    if (this.isPlaying) {
      const startTimestamp = Date.now() - this.songTime * 1000;
      activity.startTimestamp = startTimestamp;
      activity.endTimestamp = startTimestamp + this.mediaItem.duration * 1000;
    } else
      this.activityTimeout = setTimeout(() => {
        console.log('Discord RPC: Activity cleared due to inactivity');
        this.client.user?.clearActivity();
      }, 10000);

    this.client.user?.setActivity(activity).catch(console.error);
  }
}

exports.default = DiscordActivity;
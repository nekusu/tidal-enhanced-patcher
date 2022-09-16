"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _electron = require("electron");

var _DiscordRPC = require("discord-rpc");

var _ = require("lodash");

var _AppEventEnum = _interopRequireDefault(require("../../shared/AppEventEnum"));

var _UserSettingsKeysEnum = _interopRequireDefault(require("../user/UserSettingsKeysEnum"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

class DiscordActivity {
  constructor(clientId, userSettingsController, playbackStatusController) {
    this.rpc = new _DiscordRPC.Client({ transport: 'ipc' });
    this.userSettingsController = userSettingsController;
    this.playbackStatusController = playbackStatusController;

    this.rpc.login({ clientId });
    this.handleActivity();
  }

  handleActivity() {
    let _discordRpcDisabled = this.userSettingsController
      .get(_UserSettingsKeysEnum.default.DISCORD_RPC_DISABLED);
    let _mediaItem = null;
    let _time = 0;
    let _isPlaying = false;
    let activityTimeout;

    // function debounced to prevent multiple calls when jumping to another song
    // due to multiple `PLAYBACK_CURRENT_TIME` events
    const updateActivity = _.debounce(() => {
      if (_discordRpcDisabled) return;
      const activity = {
        largeImageKey: _mediaItem.imageUrl,
        largeImageText: _mediaItem.album,
        smallImageKey: 'tidal',
        details: _mediaItem.title,
        state: `by ${_mediaItem.artist}`,
        buttons: [{
          label: 'Listen along',
          url: _mediaItem.url
        }],
        instance: false,
      };
      if (_isPlaying) {
        const startTimestamp = Math.round(new Date().getTime() / 1000);
        const endTimestamp = startTimestamp + (_mediaItem.duration - _time);
        activity.startTimestamp = startTimestamp;
        activity.endTimestamp = endTimestamp;
        clearTimeout(activityTimeout);
      } else {
        activityTimeout = setTimeout(() => {
          this.rpc.clearActivity();
        }, 60000); // timeout in ms for clearing activity when playback is paused
      }
      this.rpc.setActivity(activity);
    }, 100);

    // check every second if Discord RPC has been disabled from the system tray
    // possible improvement: integrate discordRpcDisabled value with redux store and
    // remove this unnecessary interval
    setInterval(() => {
      const discordRpcDisabled = this.userSettingsController
        .get(_UserSettingsKeysEnum.default.DISCORD_RPC_DISABLED);
      if (discordRpcDisabled === _discordRpcDisabled) return;
      if (discordRpcDisabled) {
        this.rpc.clearActivity();
      }
      _discordRpcDisabled = discordRpcDisabled;
      updateActivity();
    }, 1000);

    // get media info
    _electron.ipcMain.on(_AppEventEnum.default.PLAYBACK_CURRENT_MEDIAITEM, (_, mediaItem) => {
      _mediaItem = mediaItem;
      updateActivity();
    });

    // get elapsed time
    _electron.ipcMain.on(_AppEventEnum.default.PLAYBACK_CURRENT_TIME, (_, time) => {
      const timeDifference = time - _time;
      const isNewTimeGreater = time > _time;
      _time = time;
      // only update the timestamps when the following conditions are met
      if (_isPlaying && (timeDifference > 1 || !isNewTimeGreater)) {
        updateActivity();
      }
    });

    // get isPlaying status
    this.playbackStatusController.getModel().on('playing', (isPlaying) => {
      _isPlaying = isPlaying;
      updateActivity();
    });
  }
}

exports.default = DiscordActivity;

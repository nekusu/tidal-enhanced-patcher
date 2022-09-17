"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = downloadMenu;

var _MenuEventEnum = _interopRequireDefault(require("./MenuEventEnum"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

function downloadMenu(delegate) {
  const submenu = [{
    label: 'Open GUI',
    id: _MenuEventEnum.default.OPEN_DL_GUI,
    accelerator: 'Ctrl+D',
    enabled: true,
    type: 'normal',
    click: delegate.menuClick.bind(delegate)
  }, {
    label: 'Open CLI',
    id: _MenuEventEnum.default.OPEN_DL_CLI,
    enabled: true,
    type: 'normal',
    click: delegate.menuClick.bind(delegate)
  }];

  return {
    label: 'Download',
    id: _MenuEventEnum.default.DOWNLOAD,
    submenu
  };
}

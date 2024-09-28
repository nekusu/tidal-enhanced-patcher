Object.defineProperty(exports, '__esModule', { value: true });
exports.default = downloadMenu;
const _MenuEventEnum = _interopRequireDefault(require('./MenuEventEnum'));

function _interopRequireDefault(obj) {
  return obj?.__esModule ? obj : { default: obj };
}

function downloadMenu(delegate) {
  const submenu = [
    {
      label: 'Open GUI',
      id: _MenuEventEnum.default.OPEN_DL_GUI,
      accelerator: 'Ctrl+D',
      type: 'normal',
      click: delegate.menuClick.bind(delegate),
    },
    {
      label: 'Open CLI',
      id: _MenuEventEnum.default.OPEN_DL_CLI,
      type: 'normal',
      click: delegate.menuClick.bind(delegate),
    },
  ];
  return {
    id: _MenuEventEnum.default.DOWNLOAD,
    label: 'Download',
    submenu,
  };
}

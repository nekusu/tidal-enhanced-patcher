Object.defineProperty(exports, '__esModule', { value: true });
exports.default = downloadMenu;
function downloadMenu(delegate) {
  const submenu = [
    {
      label: 'Download queue…',
      accelerator: 'CmdOrCtrl+D',
      click: () => delegate.downloadController.open('queue'),
    },
    {
      label: 'Download settings…',
      click: () => delegate.downloadController.open('settings'),
    },
  ];
  return {
    id: 'tep.download',
    label: 'Download',
    submenu,
  };
}

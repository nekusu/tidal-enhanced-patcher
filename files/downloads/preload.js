// Appended to TIDAL's existing sandboxed preload by scripts/downloads.ts.
// resolveTarget is supplied by context.cjs in the enclosing patch scope.
if (window.top === window && location.origin === 'https://desktop.tidal.com') {
  const { ipcRenderer, webFrame } = require('electron');
  let state;
  let dialog;
  let queue;
  let form;
  let message;
  let target;
  let captureTimer;
  let toastTimer;
  let previousFocus;

  async function request(command, payload) {
    const result = await ipcRenderer.invoke('tep-downloads:request', command, payload);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  }

  function button(text, action) {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = text;
    node.addEventListener('click', () =>
      Promise.resolve()
        .then(action)
        .catch((error) => notify(error.message, true)),
    );
    return node;
  }

  function notify(text, error = false) {
    if (dialog?.open) {
      message.textContent = text;
      message.setAttribute('role', error ? 'alert' : 'status');
      return;
    }
    let toast = document.getElementById('tep-download-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'tep-download-toast';
      document.body.append(toast);
    }
    toast.setAttribute('role', error ? 'alert' : 'status');
    toast.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.remove(), 6000);
  }

  async function enqueue(item) {
    await request('enqueue', item);
    notify('Added to downloads. Open Download → Download queue to see progress.');
  }

  const fields = [
    [
      'audioQuality',
      'Audio quality',
      [
        ['HI_RES_LOSSLESS', 'Max — high resolution lossless'],
        ['LOSSLESS', 'High — CD lossless'],
        ['HIGH', 'AAC 320 kbps'],
        ['LOW', 'AAC 96 kbps'],
      ],
    ],
    [
      'videoQuality',
      'Maximum video resolution',
      [
        ['P1080', '1080p'],
        ['P720', '720p'],
        ['P480', '480p'],
        ['P360', '360p'],
      ],
    ],
    ['albumFolderFormat', 'Album folder format'],
    ['playlistFolderFormat', 'Playlist folder format'],
    ['trackFileFormat', 'Track file format'],
    ['videoFileFormat', 'Video file format'],
    ['checkExist', 'Skip existing files', 'check'],
    ['usePlaylistFolder', 'Keep playlists in their own folders', 'check'],
    ['includeEP', 'Include EPs and singles in artist downloads', 'check'],
    ['downloadVideos', 'Include videos', 'check'],
    ['multiThread', 'Download up to three items at once', 'check'],
    ['saveCovers', 'Save and embed cover artwork', 'check'],
    ['lyricFile', 'Save lyrics when available', 'check'],
    ['saveAlbumInfo', 'Save album information as JSON', 'check'],
  ];

  function createDialog() {
    dialog = document.createElement('dialog');
    dialog.id = 'tep-download-dialog';
    dialog.setAttribute('aria-labelledby', 'tep-download-title');
    const header = document.createElement('header');
    const title = document.createElement('h2');
    title.id = 'tep-download-title';
    title.textContent = 'Downloads';
    header.append(
      title,
      button('Close', () => dialog.close()),
    );
    const nav = document.createElement('nav');
    nav.setAttribute('aria-label', 'Downloads');
    nav.append(
      button('Queue', () => showView('queue')),
      button('Settings', () => showView('settings')),
    );
    message = document.createElement('p');
    message.setAttribute('role', 'status');
    queue = document.createElement('section');
    queue.dataset.view = 'queue';
    const linkForm = document.createElement('form');
    const link = document.createElement('input');
    link.name = 'link';
    link.placeholder = 'Paste a TIDAL track, album, playlist, artist, or video link';
    link.setAttribute('aria-label', 'TIDAL link to download');
    link.required = true;
    const add = document.createElement('button');
    add.type = 'submit';
    add.textContent = 'Download';
    linkForm.append(link, add);
    linkForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await enqueue(link.value.trim());
        link.value = '';
      } catch (error) {
        notify(error.message, true);
      }
    });
    const controls = document.createElement('div');
    controls.className = 'tep-actions';
    const pause = button('Pause queue after current download', async () => {
      state = await request('pause', !state.paused);
      renderQueue();
    });
    pause.dataset.action = 'pause';
    controls.append(
      pause,
      button('Clear finished', async () => {
        state = await request('clear');
        renderQueue();
      }),
      button('Open folder', () => request('open-folder')),
    );
    const jobs = document.createElement('div');
    jobs.id = 'tep-download-jobs';
    queue.append(linkForm, controls, jobs);
    form = document.createElement('form');
    form.dataset.view = 'settings';
    form.hidden = true;
    const folderLabel = document.createElement('label');
    folderLabel.textContent = 'Download folder';
    const folder = document.createElement('input');
    folder.name = 'downloadPath';
    folder.readOnly = true;
    folder.required = true;
    folderLabel.append(folder);
    form.append(
      folderLabel,
      button('Choose folder…', async () => {
        const selected = await request('choose-folder');
        if (selected) folder.value = selected;
      }),
    );
    for (const [name, label, options] of fields) {
      const fieldLabel = document.createElement('label');
      fieldLabel.textContent = label;
      const input = document.createElement(Array.isArray(options) ? 'select' : 'input');
      input.name = name;
      if (Array.isArray(options))
        for (const [value, text] of options) input.add(new Option(text, value));
      else input.type = options === 'check' ? 'checkbox' : 'text';
      if (input.type === 'checkbox') fieldLabel.className = 'tep-checkbox';
      else input.required = true;
      fieldLabel.append(input);
      form.append(fieldLabel);
    }
    const hint = document.createElement('p');
    hint.className = 'tep-hint';
    hint.textContent =
      'Naming: {ArtistName}, {AlbumArtistName}, {AlbumTitle}, {AlbumID}, {AlbumYear}, {TrackNumber}, {TrackTitle}, {TrackID}, {ExplicitFlag}, {AudioQuality}, {VolumeNumber}, {PlaylistName}, {PlaylistUUID}, {VideoNumber}, {VideoTitle}. Use / to separate album or playlist folders. Quality depends on availability. Settings apply to the next queued download.';
    const save = document.createElement('button');
    save.type = 'submit';
    save.textContent = 'Save settings';
    form.append(hint, save);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const next = {};
      for (const input of form.querySelectorAll('[name]'))
        next[input.name] = input.type === 'checkbox' ? input.checked : input.value;
      try {
        state = await request('settings', next);
        notify('Download settings saved.');
      } catch (error) {
        notify(error.message, true);
      }
    });
    dialog.append(header, nav, message, queue, form);
    dialog.addEventListener('close', () => previousFocus?.focus());
    document.body.append(dialog);
  }

  function showView(view) {
    queue.hidden = view !== 'queue';
    form.hidden = view !== 'settings';
    message.textContent = state.warning || '';
    dialog.querySelector('h2').textContent =
      view === 'settings' ? 'Download settings' : 'Downloads';
    for (const tab of dialog.querySelectorAll('nav button'))
      tab.setAttribute(
        'aria-pressed',
        String(tab.textContent.toLowerCase() === (view === 'queue' ? 'queue' : 'settings')),
      );
    if (view === 'settings') {
      for (const input of form.querySelectorAll('[name]')) {
        if (input.type === 'checkbox') input.checked = state.settings[input.name];
        else input.value = state.settings[input.name];
      }
    } else renderQueue();
  }

  function renderQueue() {
    if (!dialog?.open || !state) return;
    queue.querySelector('[data-action="pause"]').textContent = state.paused
      ? 'Resume queue'
      : 'Pause queue after current download';
    const container = queue.querySelector('#tep-download-jobs');
    const ids = new Set(state.jobs.map((job) => job.id));
    for (const child of [...container.children]) if (!ids.has(child.dataset.job)) child.remove();
    if (!state.jobs.length) {
      if (!container.firstChild) {
        const empty = document.createElement('p');
        empty.textContent =
          'Right-click a song, album, playlist, artist, or video and choose Download.';
        container.append(empty);
      }
      return;
    }
    for (const job of state.jobs) {
      let row = [...container.children].find((child) => child.dataset.job === job.id);
      if (!row) {
        row = document.createElement('article');
        row.dataset.job = job.id;
        const title = document.createElement('strong');
        const detail = document.createElement('p');
        const progress = document.createElement('progress');
        progress.setAttribute('aria-label', 'Download progress');
        const errors = document.createElement('p');
        errors.className = 'tep-errors';
        const actions = document.createElement('div');
        row.append(title, detail, progress, errors, actions);
        container.append(row);
      }
      const [title, detail, progress, errors, actions] = row.children;
      title.textContent = job.title;
      detail.textContent = `${job.status} · ${job.completed + job.skipped + job.failed}/${job.total} items · ${(job.bytes / 1048576).toFixed(1)} MB${job.skipped ? ` · ${job.skipped} skipped` : ''}${job.current ? ` · ${job.current}` : ''}`;
      progress.max = Math.max(1, job.total);
      progress.value = job.completed + job.skipped + job.failed;
      errors.textContent = [...job.errors, ...job.warnings].join('\n');
      if (row.dataset.status !== job.status) {
        row.dataset.status = job.status;
        actions.replaceChildren();
        if (['queued', 'resolving', 'downloading'].includes(job.status))
          actions.append(button('Cancel', () => request('cancel', job.id)));
        else if (['failed', 'cancelled'].includes(job.status))
          actions.append(button('Retry', () => request('retry', job.id)));
      }
    }
  }

  function open(view, nextState) {
    state = nextState;
    if (!dialog) createDialog();
    if (!dialog.open) {
      previousFocus = document.activeElement;
      dialog.showModal();
    }
    showView(view);
  }

  function closeContext() {
    resetTarget();
    document.querySelector('[data-test="context-menu-close-button"]')?.click();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }),
    );
  }

  function addMenuItem(menu, item) {
    if (menu.querySelector('[data-tep-download]')) return;
    // Copy TIDAL's CSS classes and element hierarchy, without its event handlers,
    // telemetry, disabled state, or submenu controls.
    const native = [...menu.querySelectorAll('[role="menuitem"] > button')].find(
      (node) =>
        node.closest('[data-type="list-container__context-menu"]') === menu &&
        node.getAttribute('aria-disabled') !== 'true' &&
        !node.closest('li[aria-haspopup]') &&
        node.querySelector('[class*="actionTextInner"]'),
    );
    if (!native) return;
    const li = document.createElement('li');
    li.dataset.tepDownload = 'true';
    const wrapper = document.createElement('div');
    wrapper.className = native.parentElement.className;
    wrapper.setAttribute('role', 'menuitem');
    const download = button('', async () => {
      closeContext();
      await enqueue(item);
    });
    download.className = native.className;
    download.tabIndex = 0;
    const nativeIcon = native.querySelector('[class*="extraLeftIconContainer"]');
    const spacer = native.querySelector('[class*="whiteSpaceIconReplacement"]');
    if (nativeIcon) {
      const iconContainer = document.createElement('span');
      iconContainer.className = nativeIcon.className;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '24');
      svg.setAttribute('height', '24');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '1.5');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5');
      svg.append(path);
      iconContainer.append(svg);
      download.append(iconContainer);
    } else if (spacer) {
      const space = document.createElement('div');
      space.className = spacer.className;
      download.append(space);
    }
    const label = document.createElement('span');
    label.className = native.querySelector('[class*="actionTextInner"]').className;
    label.textContent = 'Download';
    download.append(label);
    wrapper.append(download);
    li.append(wrapper);
    menu.append(li);
  }

  function enhanceMenu() {
    if (!target) return;
    if (target.menu && !target.menu.isConnected) {
      resetTarget();
      return;
    }
    if (!target.menu && Date.now() - target.time > 2000) return;
    const root = document.querySelector('[data-test="contextmenu"][role="menu"]');
    const menu = root?.querySelector('[data-type="list-container__context-menu"]');
    if (!menu) return;
    target.menu = root;
    addMenuItem(menu, target.item);
  }

  function resetTarget() {
    target = null;
    clearTimeout(captureTimer);
    for (const old of document.querySelectorAll('[data-tep-download]')) old.remove();
  }

  function capture(event) {
    if (event.target.closest?.('#tep-download-dialog, [role="menu"], [data-tep-download]')) return;
    resetTarget();
    const opener = event.target.closest?.(
      '[data-type="contextmenu-open"], button[aria-haspopup="menu"], [data-test="context-menu-button"], [data-test="show-context-menu-button"], [data-test="nmt-context-menu-button"]',
    );
    if (event.type !== 'contextmenu' && !opener) return;
    const item = resolveTarget(event.target, location.href, Boolean(opener));
    target = item ? { item, time: Date.now() } : null;
    if (!item) return;
    captureTimer = setTimeout(enhanceMenu, 0);
  }

  function init() {
    webFrame.insertCSS(`
      #tep-download-dialog { color-scheme: dark; background: #17181b; color: #fff; border: 1px solid #444; border-radius: 12px; width: min(760px, 90vw); max-height: 85vh; padding: 24px; font: 14px system-ui, sans-serif; box-shadow: 0 20px 80px #0009; }
      #tep-download-dialog::backdrop { background: #0009; }
      #tep-download-dialog [hidden] { display: none !important; }
      #tep-download-dialog header, #tep-download-dialog nav, #tep-download-dialog .tep-actions, #tep-download-dialog section > form { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
      #tep-download-dialog header { justify-content: space-between; }
      #tep-download-dialog h2 { font-size: 24px; margin: 0; }
      #tep-download-dialog button { cursor: pointer; border: 1px solid #555; border-radius: 6px; padding: 9px 14px; color: #fff; background: #303238; font: inherit; }
      #tep-download-dialog button:hover, #tep-download-dialog button[aria-pressed="true"] { background: #4a4d55; }
      #tep-download-dialog :focus-visible { outline: 2px solid #5de2d4; outline-offset: 3px; }
      #tep-download-dialog label { display: block; margin: 14px 0; }
      #tep-download-dialog input:not([type="checkbox"]), #tep-download-dialog select { display: block; box-sizing: border-box; width: 100%; margin-top: 6px; padding: 9px; border: 1px solid #555; border-radius: 5px; color: #fff; background: #24262b; font: inherit; }
      #tep-download-dialog section > form input { flex: 1; min-width: 200px; }
      #tep-download-dialog .tep-checkbox { display: flex; flex-direction: row-reverse; justify-content: flex-end; gap: 10px; align-items: center; }
      #tep-download-dialog .tep-hint, #tep-download-dialog article p { color: #c6c7cb; line-height: 1.5; overflow-wrap: anywhere; }
      #tep-download-dialog article { border-top: 1px solid #444; padding: 16px 0; }
      #tep-download-dialog progress { width: 100%; accent-color: #5de2d4; }
      #tep-download-dialog .tep-errors { white-space: pre-line; color: #ffb9aa; }
      #tep-download-toast { position: fixed; bottom: 110px; right: 24px; z-index: 2147483647; max-width: 440px; padding: 16px; background: #303238; color: #fff; border-radius: 8px; box-shadow: 0 4px 20px #0008; font: 14px system-ui, sans-serif; }
    `);
    document.addEventListener('contextmenu', capture, true);
    document.addEventListener('click', capture, true);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') resetTarget();
    });
    new MutationObserver(enhanceMenu).observe(document.body, { childList: true, subtree: true });
    ipcRenderer.on('tep-downloads:open', (_, data) => open(data.view, data.state));
    ipcRenderer.on('tep-downloads:state', (_, data) => {
      state = data;
      renderQueue();
    });
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
}

import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';

const context = readFileSync(new URL('../files/downloads/context.cjs', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../files/downloads/preload.js', import.meta.url), 'utf8');

const playlistId = '12345678-1234-1234-1234-123456789abc';
// Match TIDAL's current tracklist and menu DOM, including the nested CSS wrappers.
const trackRow = `
  <div role="row" data-test="tracklist-row" data-type="media-table__row" data-track-id="42">
    <div role="cell" data-test="table-row-title"><span id="track" data-test="table-cell-title" data-id="42">Song</span></div>
    <div role="cell" data-test="track-row-artist"><a id="artist" href="/artist/8">Artist</a></div>
    <div role="cell" data-test="track-row-album"><a href="/album/20">Album</a></div>
    <div role="cell" id="duration" data-test="duration">3:14</div>
    <div role="cell"><button id="track-more" data-type="contextmenu-open" data-test="context-menu-button" data-id="42"><svg><path id="track-more-icon" /></svg></button></div>
  </div>`;
const nativeMenu = `
  <div role="menu" data-test="contextmenu">
    <ul class="_actionList_123" data-type="list-container__context-menu">
      <li data-type="contextmenu-item"><div class="_actionItem_123" role="menuitem" data-type="contextmenu-item">
        <button type="button" class="_actionText_123" data-test="play-next">
          <span class="_extraLeftIconContainer_123 _extraIcon_123"><svg width="24" height="24"></svg></span><span class="_actionTextInner_123">Play next</span>
        </button>
      </div></li>
    </ul>
    <button data-test="context-menu-close-button">Close</button>
  </div>`;

function mount({ row = trackRow, withMenu = true } = {}) {
  const { window, document } = parseHTML(
    `<html><body>
      <div data-test="header-controls"><button id="playlist-more" data-test="show-context-menu-button">More</button></div>
      <div data-type="cell" data-track--content-type="playlist" data-track--content-id="${playlistId}">
        <a id="username" href="/user/123">Username</a>
        <div data-track--content-type="user" data-track--content-id="123"><button id="username-more" data-type="contextmenu-open">User options</button></div>
      </div>
      <button id="unrelated" aria-haspopup="menu">Other menu</button>
      ${row}${withMenu ? nativeMenu : ''}
    </body></html>`,
  );
  window.top = window;
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  const ipc = new EventEmitter();
  const initial = {
    paused: false,
    jobs: [],
    settings: {
      downloadPath: 'C:\\Music',
      audioQuality: 'LOSSLESS',
      videoQuality: 'P720',
      trackFileFormat: '{TrackTitle}',
      checkExist: true,
    },
  };
  ipc.invoke = (channel, command, payload) => {
    calls.push({ channel, command, payload });
    return Promise.resolve({
      ok: true,
      value: command === 'settings' ? { ...initial, settings: payload } : 'job-1',
    });
  };
  // linkedom has no dialog top layer or select.add; these are standard DOM APIs.
  const create = document.createElement.bind(document);
  document.createElement = (tag) => {
    const node = create(tag);
    if (tag === 'dialog') {
      node.showModal = () => {
        node.open = true;
      };
      node.close = () => {
        node.open = false;
        node.dispatchEvent(new window.Event('close'));
      };
    }
    if (tag === 'select') {
      node.add = (option) => node.append(option);
      Object.defineProperty(node, 'value', { value: '', writable: true });
    }
    return node;
  };
  function Option(text, value) {
    const option = create('option');
    option.value = value;
    option.textContent = text;
    return option;
  }
  const parameters = {
    window,
    document,
    location: {
      origin: 'https://desktop.tidal.com',
      href: `https://desktop.tidal.com/playlist/${playlistId}`,
    },
    MutationObserver: window.MutationObserver,
    KeyboardEvent: window.Event,
    Option,
    setTimeout: (callback) => {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    require: () => ({ ipcRenderer: ipc, webFrame: { insertCSS: () => 'stylesheet-key' } }),
  };
  new Function(
    ...Object.keys(parameters),
    `const module = {exports:{}}; ((module) => {${context}\n})(module);\nconst {resolveTarget} = module.exports;\n${preload}`,
  )(...Object.values(parameters));
  function flushTimer() {
    const entry = timers.entries().next().value;
    if (entry) {
      timers.delete(entry[0]);
      entry[1]();
    }
  }
  function trigger(id, type = 'contextmenu') {
    document.getElementById(id).dispatchEvent(new window.Event(type, { bubbles: true }));
    flushTimer();
  }
  return { window, document, ipc, calls, initial, flushTimer, trigger };
}

describe('download UI bridge', () => {
  test.each([
    ['track', 'contextmenu'],
    ['duration', 'contextmenu'],
    ['artist', 'contextmenu'],
    ['track-more-icon', 'click'],
  ])('queues the playlist song from %s (%s) with native menu styling', async (id, event) => {
    const { document, calls, trigger } = mount();
    trigger(id, event);
    expect(document.querySelectorAll('[data-tep-download]')).toHaveLength(1);
    const menu = document.querySelector('[data-type="list-container__context-menu"]');
    expect(menu.firstElementChild.textContent.trim()).toBe('Play next');
    const action = menu.querySelector('[data-tep-download] > div[role="menuitem"] > button');
    expect(action.parentElement.className).toBe('_actionItem_123');
    expect(action.className).toBe('_actionText_123');
    expect(action.querySelector('span._actionTextInner_123').textContent).toBe('Download');
    expect(action.querySelector('span._extraLeftIconContainer_123 > svg')).not.toBeNull();
    expect(action.getAttribute('data-test')).toBeNull();
    action.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.filter((call) => call.command === 'enqueue')).toEqual([
      {
        channel: 'tep-downloads:request',
        command: 'enqueue',
        payload: { type: 'track', id: '42' },
      },
    ]);
  });

  test('uses title and More button IDs when the row has no track ID attribute', async () => {
    const { document, calls, trigger } = mount({ row: trackRow.replace('data-track-id="42"', '') });
    trigger('duration');
    document.querySelector('[data-tep-download] button').click();
    await Promise.resolve();
    expect(calls.find((call) => call.command === 'enqueue').payload).toEqual({
      type: 'track',
      id: '42',
    });
  });

  test('does not substitute a song’s album or playlist when its ID is unavailable', () => {
    const { document, trigger } = mount({
      row: trackRow.replace('data-track-id="42"', '').replaceAll('data-id="42"', ''),
    });
    trigger('track');
    expect(document.querySelector('[data-tep-download]')).toBeNull();
  });

  test('queues a video row as a video', async () => {
    const { document, calls, trigger } = mount({
      row: trackRow.replace(
        'Song</span>',
        'Video</span><span data-test="video-badge">Video</span>',
      ),
    });
    trigger('track');
    document.querySelector('[data-tep-download] button').click();
    await Promise.resolve();
    expect(calls.find((call) => call.command === 'enqueue').payload).toEqual({
      type: 'video',
      id: '42',
    });
  });

  test('still offers a playlist download from its header More button', async () => {
    const { document, calls, trigger } = mount();
    trigger('playlist-more', 'click');
    document.querySelector('[data-tep-download] button').click();
    await Promise.resolve();
    expect(calls.find((call) => call.command === 'enqueue').payload).toEqual({
      type: 'playlist',
      id: playlistId,
    });
  });

  test.each([
    ['username', 'click'],
    ['username', 'contextmenu'],
    ['username-more', 'click'],
    ['unrelated', 'click'],
  ])('does not add Download to %s (%s), even after a song menu', async (id, event) => {
    const { document, trigger, calls } = mount();
    trigger('track');
    expect(document.querySelector('[data-tep-download]')).not.toBeNull();
    trigger(id, event);
    await Promise.resolve();
    expect(document.querySelector('[data-tep-download]')).toBeNull();
    expect(calls).toEqual([]);
  });

  test('waits for TIDAL’s menu instead of creating a separate popup', async () => {
    const { document, trigger } = mount({ withMenu: false });
    trigger('track');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    document.body.insertAdjacentHTML('beforeend', nativeMenu);
    await Promise.resolve();
    expect(document.querySelectorAll('[data-tep-download]')).toHaveLength(1);
  });

  test('updates the download target when TIDAL reuses its menu', async () => {
    const { document, trigger, calls } = mount();
    trigger('track');
    document.querySelector('[data-track-id]').setAttribute('data-track-id', '99');
    trigger('track');
    expect(document.querySelectorAll('[data-tep-download]')).toHaveLength(1);
    document.querySelector('[data-tep-download] button').click();
    await Promise.resolve();
    expect(calls.find((call) => call.command === 'enqueue').payload).toEqual({
      type: 'track',
      id: '99',
    });
  });

  test('clears the target when a native menu closes', async () => {
    const { document, trigger } = mount();
    trigger('track');
    document.querySelector('[role="menu"]').remove();
    await Promise.resolve();
    document.body.insertAdjacentHTML('beforeend', nativeMenu);
    await Promise.resolve();
    expect(document.querySelector('[data-tep-download]')).toBeNull();
  });

  test('opens settings from the hamburger action and submits edited preferences', async () => {
    const { window, document, ipc, calls, initial } = mount();
    ipc.emit('tep-downloads:open', {}, { view: 'settings', state: initial });
    const dialog = document.getElementById('tep-download-dialog');
    expect(dialog.open).toBe(true);
    const form = dialog.querySelector('[data-view="settings"]');
    expect(form.hidden).toBe(false);
    expect(form.querySelector('[name="audioQuality"]').value).toBe('LOSSLESS');
    form.querySelector('[name="trackFileFormat"]').value = '{TrackID} - {TrackTitle}';
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    expect(calls.find((call) => call.command === 'settings').payload.trackFileFormat).toBe(
      '{TrackID} - {TrackTitle}',
    );
    expect(calls.find((call) => call.command === 'settings').payload.checkExist).toBe(true);
  });

  test('shows progress and API errors as text without overwriting unsaved settings', () => {
    const { document, ipc, initial } = mount();
    ipc.emit('tep-downloads:open', {}, { view: 'settings', state: initial });
    const input = document.querySelector('[name="trackFileFormat"]');
    input.value = 'Unsaved {TrackTitle}';
    const job = {
      id: '1',
      title: '<script>unsafe</script>',
      status: 'failed',
      total: 2,
      completed: 1,
      failed: 1,
      skipped: 0,
      bytes: 1024,
      errors: ['Session expired'],
      warnings: [],
    };
    ipc.emit('tep-downloads:state', {}, { ...initial, jobs: [job] });
    expect(input.value).toBe('Unsaved {TrackTitle}');
    ipc.emit('tep-downloads:open', {}, { view: 'queue', state: { ...initial, jobs: [job] } });
    const row = document.querySelector('[data-job="1"]');
    expect(row.querySelector('script')).toBeNull();
    expect(row.textContent).toContain('Session expired');
    expect(row.querySelector('progress').value).toBe(2);
  });
});

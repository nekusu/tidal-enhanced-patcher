import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { createCipheriv } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Script } from 'node:vm';
import { createPackageWithOptions, extractFile, statFile } from '@electron/asar';
import { parseHTML } from 'linkedom';
import { addNativeDownloads } from '../scripts/downloads';

const require = createRequire(import.meta.url);
// The patcher imports these as text. Evaluate the injected CommonJS modules in a
// separate cache so Bun's text loader cannot shadow executable module imports.
const runtimeCache = new Map();
function loadRuntime(name) {
  if (runtimeCache.has(name)) return runtimeCache.get(name);
  const module = { exports: {} };
  const localRequire = (specifier) =>
    specifier.startsWith('./') ? loadRuntime(specifier.slice(2)) : require(specifier);
  const source = readFileSync(new URL(`../files/downloads/${name}`, import.meta.url), 'utf8');
  new Function('require', 'module', 'exports', source)(localRequire, module, module.exports);
  runtimeCache.set(name, module.exports);
  return module.exports;
}
const { defaults, validateSettings, SettingsStore, outputPath } = loadRuntime('settings.cjs');
const { parseReference, mediaUrl, parseDash, parseManifest, parseHls } =
  loadRuntime('manifests.cjs');
const { resolveTarget } = loadRuntime('context.cjs');
const { DownloadEngine } = loadRuntime('engine.cjs');
const { createLegacyDecipher } = loadRuntime('decryption.cjs');
const ffmpeg = require('ffmpeg-static');
const execute = promisify(execFile);
let root;
let audio;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'tep-download-test-'));
  const sample = path.join(root, 'sample.flac');
  await execute(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=44100:cl=stereo',
      '-t',
      '0.15',
      '-c:a',
      'flac',
      sample,
    ],
    { windowsHide: true },
  );
  audio = await readFile(sample);
});

afterAll(async () => {
  if (
    !root ||
    !path.basename(root).startsWith('tep-download-test-') ||
    path.dirname(root) !== path.resolve(tmpdir())
  )
    throw new Error('Unexpected test directory.');
  await rm(root, { recursive: true, force: true });
});

const album = {
  id: 20,
  title: 'An Album',
  artist: { name: 'An Artist' },
  releaseDate: '2026-01-01',
  numberOfVolumes: 1,
};
const track = (id) => ({
  id,
  title: `Track ${id}`,
  trackNumber: id,
  volumeNumber: 1,
  artists: [{ name: 'An Artist' }],
  album: { id: album.id },
  duration: 1,
});
const playlistId = '01234567-89ab-cdef-0123-456789abcdef';
const manifest = (data) => ({
  assetPresentation: 'FULL',
  audioQuality: 'LOSSLESS',
  manifestMimeType: 'application/vnd.tidal.bts',
  manifest: Buffer.from(JSON.stringify(data)).toString('base64'),
});
const playback = () =>
  manifest({
    mimeType: 'audio/flac',
    codecs: 'flac',
    encryptionType: 'NONE',
    urls: ['https://audio.tidal.com/file.flac'],
  });

// Fixed legacy-protocol fixture, independent of the production token decoder.
const legacyToken = '/+7dzLuqmYh3ZlVEMyIRANxKH35Ru8rYjfqAhgebQpdqRAW39cP7QB1vC9XgSM7H';
const legacyPlayback = () =>
  manifest({
    mimeType: 'audio/flac',
    codecs: 'flac',
    encryptionType: 'OLD_AES',
    keyId: legacyToken,
    urls: ['https://audio.tidal.com/file.flac'],
  });

function encryptedAudio() {
  const cipher = createCipheriv(
    'aes-128-ctr',
    Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
    Buffer.from('10203040506070800000000000000000', 'hex'),
  );
  return Buffer.concat([cipher.update(audio), cipher.final()]);
}

function createEngine(folder, override = {}) {
  const calls = [];
  const engine = new DownloadEngine({
    settings: {
      value: { ...defaults(folder), downloadPath: folder, saveCovers: false, multiThread: false },
    },
    getSession: () => ({ sessionId: 'test-session', countryCode: 'US' }),
    ffmpegPath: ffmpeg,
    fetch: (value, options) => {
      const url = new URL(value);
      calls.push({ url, options });
      const resource = url.pathname.replace('/v1/', '');
      if (url.hostname === 'audio.tidal.com') return Promise.resolve(new Response(audio));
      if (resource === 'albums/20') return Promise.resolve(Response.json(album));
      if (/tracks\/\d+\/playbackinfopostpaywall/.test(resource))
        return Promise.resolve(Response.json(playback()));
      if (/^tracks\/\d+$/.test(resource))
        return Promise.resolve(Response.json(track(Number(resource.split('/')[1]))));
      if (resource === 'albums/20/items') {
        const offset = Number(url.searchParams.get('offset'));
        return Promise.resolve(
          Response.json({
            totalNumberOfItems: 2,
            items:
              offset === 0
                ? [{ type: 'track', item: track(1) }]
                : [{ type: 'track', item: track(2) }],
          }),
        );
      }
      return Promise.resolve(new Response('', { status: 404 }));
    },
    ...override,
  });
  return { engine, calls };
}

async function finished(engine) {
  while (engine.running) await once(engine, 'change');
  return engine.jobs.at(-1);
}

// Wait for terminal state and cleanup without relying on an arbitrary timeout.
async function download(engine, reference) {
  const id = engine.enqueue(reference);
  while (true) {
    const job = engine.jobs.find((entry) => entry.id === id);
    if (['completed', 'failed', 'cancelled'].includes(job.status) && !engine.running) return job;
    await once(engine, 'change');
  }
}

describe('settings and file names', () => {
  test('imports legacy quality and preferences without downloader credentials', async () => {
    const legacy = path.join(root, 'legacy.json');
    const file = path.join(root, 'settings.json');
    await writeFile(
      legacy,
      JSON.stringify({
        audioQuality: 'Master',
        saveCovers: false,
        apiKeyIndex: 4,
        accessToken: 'must-not-be-copied',
      }),
    );
    const store = new SettingsStore(file, legacy, root);
    expect(store.value.audioQuality).toBe('HI_RES_LOSSLESS');
    expect(store.value.saveCovers).toBe(false);
    const content = await readFile(file, 'utf8');
    expect(content).not.toContain('must-not-be-copied');
    expect(content).not.toContain('apiKeyIndex');
    await writeFile(legacy, JSON.stringify({ audioQuality: 'Normal' }));
    expect(new SettingsStore(file, legacy, root).value.audioQuality).toBe('HI_RES_LOSSLESS');
  });

  test('rejects invalid settings and path traversal', () => {
    const config = defaults(root);
    for (const albumFolderFormat of ['../escape', '..\\escape', '/root', 'C:\\escape', '{Typo}'])
      expect(() => validateSettings({ albumFolderFormat }, config)).toThrow();
    expect(() => validateSettings({ multiThread: 'yes' }, config)).toThrow();
    expect(() => validateSettings({ audioQuality: 'garbage' }, config)).toThrow();
    expect(() => validateSettings({ downloadPath: 'relative' }, config)).toThrow();
  });

  test('sanitizes metadata, preserves playlist order and separates album discs', () => {
    const config = { ...defaults(root), downloadPath: root };
    const media = { ...track(1), title: '../../bad:*?title', volumeNumber: 2 };
    const destination = outputPath(
      config,
      media,
      { ...album, numberOfVolumes: 2 },
      null,
      1,
      'flac',
      'LOSSLESS',
    );
    expect(path.relative(root, destination).startsWith('..')).toBe(false);
    expect(destination).toContain('Disc 2');
    expect(path.basename(destination)).not.toMatch(/[:*?]/);
    const playlistFile = outputPath(
      config,
      media,
      album,
      { title: 'My Playlist', uuid: playlistId },
      7,
      'flac',
      'LOSSLESS',
    );
    expect(playlistFile).toContain('Playlists');
    expect(path.basename(playlistFile)).toStartWith('07 - ');
  });
});

describe('media manifests', () => {
  test('recognizes supported links and rejects other hosts and invalid IDs', () => {
    expect(parseReference('https://tidal.com/browse/album/20?u=123')).toEqual({
      type: 'album',
      id: '20',
    });
    expect(parseReference({ type: 'PLAYLIST', id: playlistId })).toEqual({
      type: 'playlist',
      id: playlistId,
    });
    expect(() => parseReference('https://evil.test/track/1')).toThrow();
    expect(() => parseReference({ type: 'track', id: '../1' })).toThrow();
    expect(() => mediaUrl('file:///secret')).toThrow();
    expect(() => mediaUrl('https://tidal.com.evil.test/file')).toThrow();
    expect(() => mediaUrl('https://user:password@audio.tidal.com/file')).toThrow();
  });

  test('handles direct stream mirrors, previews and encrypted streams', () => {
    expect(parseManifest(playback(), 'track').extension).toBe('flac');
    const mirrors = playback();
    mirrors.manifest = Buffer.from(
      JSON.stringify({
        urls: ['https://audio.tidal.com/a', 'https://audio.tidal.com/b'],
        codecs: 'mp4a',
      }),
    ).toString('base64');
    expect(parseManifest(mirrors, 'track').urls).toHaveLength(1);
    expect(() => parseManifest({ ...playback(), assetPresentation: 'PREVIEW' }, 'track')).toThrow(
      'preview',
    );
    expect(() =>
      parseManifest(
        manifest({ encryptionType: 'AES', urls: ['https://audio.tidal.com/a'] }),
        'track',
      ),
    ).toThrow('encryption format (AES)');
  });

  test('recognizes legacy BTS encryption without treating every key ID as unsupported', () => {
    expect(parseManifest(legacyPlayback(), 'track').encryption).toEqual({
      type: 'OLD_AES',
      keyId: legacyToken,
    });
    expect(
      parseManifest(manifest({ keyId: legacyToken, urls: ['https://audio.tidal.com/a'] }), 'track')
        .encryption,
    ).toEqual({ type: 'OLD_AES', keyId: legacyToken });
    expect(() =>
      parseManifest(
        manifest({ encryptionType: 'OLD_AES', urls: ['https://audio.tidal.com/a'] }),
        'track',
      ),
    ).toThrow('without its decryption token');
    expect(() =>
      parseManifest(manifest({ encryptionType: 'WIDEVINE', keyId: legacyToken }), 'track'),
    ).toThrow('encryption format (WIDEVINE)');
  });

  test('decrypts a known legacy fixture across uneven chunks without resetting the counter', () => {
    const encrypted = Buffer.from(
      'RSQVz+Y8n3Q4AaNxArG+qyjWdsLnSy6Y9sTU18yCEEGQ8AlNjRrVHdb9hnVQDlPt++HZgC9ZFZOMN5VDPJgzkAx8fILWno2bCLh2yjWOrA==',
      'base64',
    );
    const decipher = createLegacyDecipher(legacyToken);
    const decoded = Buffer.concat([
      decipher.update(encrypted.subarray(0, 7)),
      decipher.update(encrypted.subarray(7, 19)),
      decipher.update(encrypted.subarray(19)),
      decipher.final(),
    ]);
    expect(decoded.toString()).toBe(
      'Legacy audio fixture: streaming must preserve the counter across uneven chunks.',
    );
  });

  test.each([
    '',
    'not-base64!',
    'AAAA',
    `${legacyToken}A`,
    legacyToken.slice(0, -4),
  ])('rejects malformed legacy tokens without including them in errors (%s)', (token) => {
    expect(() => createLegacyDecipher(token)).toThrow('invalid legacy audio decryption token');
  });

  test('expands inherited DASH timelines, signed URLs, number and time templates', () => {
    const xml =
      '<MPD type="static"><Period><AdaptationSet contentType="audio"><SegmentTemplate startNumber="5" initialization="https://audio.tidal.com/init?a=1&amp;b=2" media="https://audio.tidal.com/$RepresentationID$/$Number%03d$/$Time$"><SegmentTimeline><S t="12" d="4" r="1"/><S d="2"/></SegmentTimeline></SegmentTemplate><Representation id="a" codecs="flac" bandwidth="900"/></AdaptationSet></Period></MPD>';
    expect(parseDash(xml)).toEqual({
      extension: 'flac',
      urls: [
        'https://audio.tidal.com/init?a=1&b=2',
        'https://audio.tidal.com/a/005/12',
        'https://audio.tidal.com/a/006/16',
        'https://audio.tidal.com/a/007/20',
      ],
    });
    expect(() =>
      parseDash(xml.replace('<Representation', '<ContentProtection/><Representation')),
    ).toThrow('DRM');
    expect(() => parseDash(xml.replace('r="1"', 'r="-1"'))).toThrow('timeline');
    expect(() => parseDash(`<!DOCTYPE MPD>${xml}`)).toThrow();
  });

  test('selects video resolution and rejects encrypted, live, or unsupported HLS', () => {
    const master =
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200,RESOLUTION=1920x1080\n1080.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1280x720\n720.m3u8';
    expect(parseHls(master, 'https://video.tidal.com/master.m3u8', 'P720').variant).toBe(
      'https://video.tidal.com/720.m3u8',
    );
    const media = '#EXTM3U\n#EXTINF:1,\nseg.ts\n#EXT-X-ENDLIST';
    expect(parseHls(media, 'https://video.tidal.com/720.m3u8', 'P720').urls).toEqual([
      'https://video.tidal.com/seg.ts',
    ]);
    expect(() =>
      parseHls(
        media.replace('#EXTINF:', '#EXT-X-KEY:METHOD=AES-128\n#EXTINF:'),
        'https://video.tidal.com/a',
        'P720',
      ),
    ).toThrow('encrypted');
    expect(() =>
      parseHls(media.replace('#EXT-X-ENDLIST', ''), 'https://video.tidal.com/a', 'P720'),
    ).toThrow('Live');
  });
});

describe('native download engine', () => {
  test('downloads legacy encrypted audio, preserves its samples, and keeps tokens out of the queue', async () => {
    const folder = path.join(root, 'legacy-encrypted');
    const { engine } = createEngine(folder);
    const fetch = engine.fetch;
    const ciphertext = encryptedAudio();
    engine.fetch = (url, options) => {
      if (url.includes('/playbackinfopostpaywall'))
        return Promise.resolve(Response.json(legacyPlayback()));
      if (url.startsWith('https://audio.tidal.com/'))
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                for (let offset = 0; offset < ciphertext.length; offset += 37)
                  controller.enqueue(ciphertext.subarray(offset, offset + 37));
                controller.close();
              },
            }),
          ),
        );
      return fetch(url, options);
    };
    const job = await download(engine, { type: 'track', id: '569249' });
    expect(job.status).toBe('completed');
    expect(job.bytes).toBe(ciphertext.length);
    const files = await readdir(folder, { recursive: true });
    const output = path.join(
      folder,
      files.find((file) => file.endsWith('.flac')),
    );
    const audioHash = (file) =>
      execute(
        ffmpeg,
        ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'hash', '-hash', 'sha256', '-'],
        { windowsHide: true },
      );
    const [original, downloaded] = await Promise.all([
      audioHash(path.join(root, 'sample.flac')),
      audioHash(output),
    ]);
    expect(downloaded.stdout).toBe(original.stdout);
    expect(JSON.stringify(engine.snapshot())).not.toContain(legacyToken);
    expect(files.some((file) => file.includes('.tep-'))).toBe(false);
  });

  test('rejects malformed encryption tokens before requesting media and cleans temporary files', async () => {
    const folder = path.join(root, 'invalid-encryption');
    const { engine, calls } = createEngine(folder);
    const fetch = engine.fetch;
    engine.fetch = (url, options) =>
      url.includes('/playbackinfopostpaywall')
        ? Promise.resolve(
            Response.json(
              manifest({
                encryptionType: 'OLD_AES',
                keyId: 'invalid-token',
                urls: ['https://audio.tidal.com/a'],
              }),
            ),
          )
        : fetch(url, options);
    const job = await download(engine, { type: 'track', id: '569249' });
    expect(job.status).toBe('failed');
    expect(job.errors[0]).toContain('invalid legacy audio decryption token');
    expect(calls.some((call) => call.url.hostname === 'audio.tidal.com')).toBe(false);
    expect(
      (await readdir(folder, { recursive: true })).some(
        (file) => file.includes('.tep-') || file.endsWith('.flac'),
      ),
    ).toBe(false);
  });

  test('downloads with the existing OAuth session and keeps credentials off media requests', async () => {
    const { engine, calls } = createEngine(path.join(root, 'oauth-download'), {
      getSession: () => Promise.resolve({ accessToken: 'client-token', countryCode: 'US' }),
    });
    const job = await download(engine, { type: 'track', id: '569249' });
    expect(job.status).toBe('completed');
    const apiCalls = calls.filter((call) => call.url.hostname === 'api.tidal.com');
    expect(apiCalls.length).toBeGreaterThan(0);
    for (const call of apiCalls) {
      expect(call.options.headers.Authorization).toBe('Bearer client-token');
      expect(call.options.headers['X-Tidal-SessionId']).toBeUndefined();
      expect(call.url.searchParams.get('countryCode')).toBe('US');
    }
    expect(
      calls.find((call) => call.url.hostname === 'audio.tidal.com').options.headers,
    ).toBeUndefined();
    expect(JSON.stringify(engine.snapshot())).not.toContain('client-token');
  });

  test('asks the client to refresh a rejected token and retries with the new credentials', async () => {
    const statuses = [];
    const headers = [];
    const { engine } = createEngine(path.join(root, 'oauth-refresh'), {
      getSession: (subStatus) => {
        statuses.push(subStatus);
        return Promise.resolve({
          accessToken: subStatus ? 'new-token' : 'old-token',
          countryCode: 'US',
        });
      },
      fetch: (_url, options) => {
        headers.push(options.headers.Authorization);
        return Promise.resolve(
          headers.length === 1
            ? Response.json({ subStatus: 11003 }, { status: 401 })
            : Response.json(track(569249)),
        );
      },
    });
    expect((await engine.api('tracks/569249', {}, new AbortController().signal)).id).toBe(569249);
    expect(statuses).toEqual([undefined, '11003']);
    expect(headers).toEqual(['Bearer old-token', 'Bearer new-token']);
  });

  test('paginates albums, writes tagged playable audio, and skips existing files', async () => {
    const folder = path.join(root, 'album-download');
    const { engine, calls } = createEngine(folder);
    const job = await download(engine, { type: 'album', id: '20' });
    expect(job.status).toBe('completed');
    expect(job.completed).toBe(2);
    const files = (await readdir(folder, { recursive: true })).filter((file) =>
      file.endsWith('.flac'),
    );
    expect(files).toHaveLength(2);
    const downloaded = path.join(folder, files[0]);
    expect((await readFile(downloaded)).subarray(0, 4).toString()).toBe('fLaC');
    const metadata = await execute(
      ffmpeg,
      ['-hide_banner', '-i', downloaded, '-f', 'ffmetadata', '-'],
      { windowsHide: true },
    );
    expect(metadata.stdout).toContain('album=An Album');
    expect(metadata.stdout).toContain('artist=An Artist');
    expect(calls.filter((call) => call.url.pathname.endsWith('/items'))).toHaveLength(2);
    expect(
      calls.find((call) => call.url.hostname === 'api.tidal.com').options.headers[
        'X-Tidal-SessionId'
      ],
    ).toBe('test-session');
    expect(
      calls.find((call) => call.url.hostname === 'audio.tidal.com').options.headers,
    ).toBeUndefined();
    const again = await download(engine, { type: 'album', id: '20' });
    expect(again.skipped).toBe(2);
    expect(
      (await readdir(folder, { recursive: true })).some((file) => file.includes('.tep-')),
    ).toBe(false);
  });

  test('keeps processing other tracks after a per-track error', async () => {
    const { engine } = createEngine(path.join(root, 'partial'));
    const fetch = engine.fetch;
    engine.fetch = (url, options) =>
      url.includes('tracks/1/playback')
        ? Promise.resolve(new Response('', { status: 403 }))
        : fetch(url, options);
    const job = await download(engine, { type: 'album', id: '20' });
    expect(job.status).toBe('failed');
    expect(job.failed).toBe(1);
    expect(job.completed).toBe(1);
    expect(job.errors[0]).toContain('not available');
  });

  test.each([
    false,
    true,
  ])('cancels an active stream and removes temporary files (encrypted: %s)', async (encrypted) => {
    const folder = path.join(root, encrypted ? 'cancel-encrypted' : 'cancel');
    const { engine } = createEngine(folder);
    const fetch = engine.fetch;
    let started;
    const streaming = new Promise((resolve) => {
      started = resolve;
    });
    engine.fetch = (url, options) => {
      if (encrypted && url.includes('/playbackinfopostpaywall'))
        return Promise.resolve(Response.json(legacyPlayback()));
      if (!url.startsWith('https://audio.tidal.com/')) return fetch(url, options);
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue((encrypted ? encryptedAudio() : audio).subarray(0, 16));
              options.signal.addEventListener(
                'abort',
                () => controller.error(new Error('Cancelled')),
                { once: true },
              );
              started();
            },
          }),
        ),
      );
    };
    const id = engine.enqueue({ type: 'track', id: '1' });
    await streaming;
    engine.cancel(id);
    await finished(engine);
    expect(engine.jobs[0].status).toBe('cancelled');
    const files = await readdir(folder, { recursive: true });
    expect(files.some((file) => file.includes('.tep-') || file.endsWith('.flac'))).toBe(false);
  });

  test('reports expired sessions and refuses redirects outside TIDAL', async () => {
    const { engine } = createEngine(path.join(root, 'expired'), {
      fetch: () => Promise.resolve(new Response('', { status: 401 })),
    });
    const job = await download(engine, { type: 'track', id: '1' });
    expect(job.errors[0]).toContain('session expired');
    engine.fetch = () =>
      Promise.resolve(
        new Response('', { status: 302, headers: { location: 'https://evil.test/track' } }),
      );
    await expect(engine.request('https://audio.tidal.com/a', {}, true)).rejects.toThrow(
      'Unsupported media host',
    );
  });

  test('pauses, de-duplicates queued selections, and allows cancelling a queued job', () => {
    const { engine, calls } = createEngine(path.join(root, 'pause'));
    engine.setPaused(true);
    const id = engine.enqueue({ type: 'track', id: '1' });
    expect(engine.enqueue({ type: 'track', id: '1' })).toBe(id);
    expect(calls).toHaveLength(0);
    engine.cancel(id);
    engine.clearFinished();
    expect(engine.jobs).toHaveLength(0);
  });
});

describe('menu targets and patch integration', () => {
  test('restricts IPC to the TIDAL main frame and cancels downloads on logout', async () => {
    const handlers = new Map();
    const user = new EventEmitter();
    user.get = (key) => ({ userLoggedIn: true, userId: 123, countryCode: 'US' })[key];
    const app = new EventEmitter();
    app.getPath = () => path.join(root, 'controller');
    const frame = { url: 'https://desktop.tidal.com/album/20' };
    const contents = {
      mainFrame: frame,
      isDestroyed: () => false,
      send: () => undefined,
      executeJavaScript: (code) => {
        new Script(code);
        return Promise.resolve({ accessToken: 'private-session', userId: '123' });
      },
    };
    const electron = {
      app,
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      net: {
        fetch: (_url, options) => {
          expect(options.headers.Authorization).toBe('Bearer private-session');
          return Promise.resolve(Response.json(track(569249)));
        },
      },
    };
    const module = { exports: {} };
    const localRequire = (specifier) => {
      if (specifier === 'electron') return electron;
      if (specifier === 'node:os') return { homedir: () => path.join(root, 'no-legacy-settings') };
      return specifier.startsWith('./') ? loadRuntime(specifier.slice(2)) : require(specifier);
    };
    new Function(
      'require',
      'module',
      'exports',
      readFileSync(new URL('../files/downloads/DownloadController.cjs', import.meta.url), 'utf8'),
    )(localRequire, module, module.exports);
    const controller = new module.exports({
      mainWindow: { webContents: contents },
      userSessionController: { getModel: () => user },
    });
    const handler = handlers.get('tep-downloads:request');
    const event = { sender: contents, senderFrame: frame };
    expect(
      (await controller.engine.api('tracks/569249', {}, new AbortController().signal)).id,
    ).toBe(569249);
    const result = await handler(event, 'state');
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-session');
    expect((await handler({ ...event, sender: {} }, 'state')).ok).toBe(false);
    expect((await handler({ ...event, senderFrame: { url: frame.url } }, 'state')).ok).toBe(false);
    frame.url = 'https://evil.test/';
    expect((await handler(event, 'state')).ok).toBe(false);
    frame.url = 'https://desktop.tidal.com/';
    controller.engine.setPaused(true);
    await handler(event, 'enqueue', { type: 'track', id: '1' });
    user.emit('userLoggedIn', false);
    expect(controller.engine.jobs[0].status).toBe('cancelled');
  });

  test('targets tracks rather than their artist links, plus album cards and playlists', () => {
    const { document } = parseHTML(
      `<html><body><div data-type="media-table__row"><div data-type="mediaItem" data-track--content-id="1" data-track--content-type="track"><a id="artist" href="/artist/8">Artist</a></div></div><div data-type="cell" data-track--content-id="20" data-track--content-type="album"><button id="album">Menu</button></div><a id="playlist" data-type="sidebar__playlist" data-track--content-id="${playlistId}" data-track--content-type="playlist">Playlist</a><div data-test="header-controls"><button id="header" data-test="show-context-menu-button">More</button></div><button id="unrelated" data-type="contextmenu-open">Menu</button><a id="artist-card" href="/artist/8">Artist</a></body></html>`,
    );
    expect(resolveTarget(document.getElementById('artist'), '/album/20')).toEqual({
      type: 'track',
      id: '1',
    });
    expect(resolveTarget(document.getElementById('album'), '/')).toEqual({
      type: 'album',
      id: '20',
    });
    expect(resolveTarget(document.getElementById('playlist'), '/')).toEqual({
      type: 'playlist',
      id: playlistId,
    });
    expect(
      resolveTarget(document.getElementById('header'), 'https://desktop.tidal.com/album/20', true),
    ).toEqual({ type: 'album', id: '20' });
    expect(
      resolveTarget(
        document.getElementById('unrelated'),
        'https://desktop.tidal.com/album/20',
        true,
      ),
    ).toBeNull();
    expect(resolveTarget(document.getElementById('artist-card'), '/')).toEqual({
      type: 'artist',
      id: '8',
    });
    expect(resolveTarget(document.body, 'https://desktop.tidal.com/album/20')).toBeNull();
  });

  test('patches validated hooks and creates syntactically valid main/preload code', async () => {
    const source = path.join(root, 'patch');
    const menuPath = path.join(source, 'app/main/menu/MenuController.js');
    const preloadPath = path.join(source, 'app/clientInterface/index.js');
    await mkdir(path.dirname(menuPath), { recursive: true });
    await mkdir(path.dirname(preloadPath), { recursive: true });
    await writeFile(
      menuPath,
      'class MenuController { constructor(userSessionController) { this.userSessionController = userSessionController; } buildMenu() { let template = []; const menu = _electron.Menu.buildFromTemplate(template); } }',
    );
    await writeFile(
      preloadPath,
      'require("electron").contextBridge.exposeInMainWorld("nativeInterface", {});',
    );
    await addNativeDownloads(source);
    new Script(await readFile(menuPath, 'utf8'));
    new Script(await readFile(preloadPath, 'utf8'));
    new Function(await readFile(preloadPath, 'utf8'));
    expect(existsSync(path.join(source, 'app/main/downloads/engine.cjs'))).toBe(true);
    expect(existsSync(path.join(source, 'app/main/downloads/session.cjs'))).toBe(true);
    expect(existsSync(path.join(source, 'app/main/downloads/decryption.cjs'))).toBe(true);
    await expect(addNativeDownloads(source)).rejects.toThrow('already installed');
    const unsupported = path.join(root, 'unsupported');
    await mkdir(path.join(unsupported, 'app/main/menu'), { recursive: true });
    await mkdir(path.join(unsupported, 'app/clientInterface'), { recursive: true });
    await writeFile(path.join(unsupported, 'app/main/menu/MenuController.js'), 'changed layout');
    await writeFile(path.join(unsupported, 'app/clientInterface/index.js'), 'exposeInMainWorld');
    await expect(addNativeDownloads(unsupported)).rejects.toThrow('incompatible');
    expect(existsSync(path.join(unsupported, 'app/main/downloads'))).toBe(false);
  });

  test('keeps the FFmpeg executable outside the ASAR archive', async () => {
    const source = path.join(root, 'asar-source');
    const relative = path.join('node_modules', 'ffmpeg-static', 'ffmpeg.exe');
    await mkdir(path.join(source, path.dirname(relative)), { recursive: true });
    await writeFile(path.join(source, relative), 'fixture executable');
    const archive = path.join(root, 'app.asar');
    await createPackageWithOptions(source, archive, { unpackDir: '**/ffmpeg-static' });
    expect(statFile(archive, relative).unpacked).toBe(true);
    expect(extractFile(archive, relative).toString()).toBe('fixture executable');
    expect(existsSync(path.join(`${archive}.unpacked`, relative))).toBe(true);
  });
});

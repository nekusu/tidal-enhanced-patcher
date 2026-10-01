const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { createLegacyDecipher } = require('./decryption.cjs');
const { mediaUrl, parseReference, parseManifest, parseHls } = require('./manifests.cjs');
const { outputPath } = require('./settings.cjs');

const execute = promisify(execFile);
const MAX_ITEMS = 20000;

class DownloadEngine extends EventEmitter {
  constructor({ settings, getSession, fetch, ffmpegPath }) {
    super();
    this.settings = settings;
    this.getSession = getSession;
    this.fetch = fetch;
    this.ffmpegPath = ffmpegPath;
    this.jobs = [];
    this.paused = false;
    this.running = false;
    this.stopped = false;
    this.pathLocks = new Map();
  }

  snapshot() {
    return { paused: this.paused, jobs: this.jobs.map(({ abort, ...job }) => ({ ...job })) };
  }

  publish() {
    this.emit('change', this.snapshot());
  }

  enqueue(input) {
    const reference = parseReference(input);
    const existing = this.jobs.find(
      (job) =>
        ['queued', 'resolving', 'downloading'].includes(job.status) &&
        job.reference.type === reference.type &&
        job.reference.id === reference.id,
    );
    if (existing) return existing.id;
    if (reference.type === 'video' && !this.settings.value.downloadVideos)
      throw new Error('Enable videos in Download settings first.');
    if (
      this.jobs.filter((job) => ['queued', 'resolving', 'downloading'].includes(job.status))
        .length >= 100
    )
      throw new Error('The download queue is full.');
    const job = {
      id: randomUUID(),
      reference,
      title: `${reference.type} ${reference.id}`,
      status: 'queued',
      total: 0,
      completed: 0,
      skipped: 0,
      failed: 0,
      bytes: 0,
      current: '',
      errors: [],
      warnings: [],
      abort: new AbortController(),
    };
    this.jobs.push(job);
    this.publish();
    void this.run();
    return job.id;
  }

  cancel(id) {
    const job = this.jobs.find((job) => job.id === id);
    if (!job || !['queued', 'resolving', 'downloading'].includes(job.status)) return;
    job.abort.abort();
    job.status = 'cancelled';
    this.publish();
  }

  stop() {
    this.stopped = true;
    for (const job of this.jobs) this.cancel(job.id);
  }

  clearFinished() {
    this.jobs = this.jobs.filter((job) =>
      ['queued', 'resolving', 'downloading'].includes(job.status),
    );
    this.publish();
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    this.publish();
    if (!this.paused) void this.run();
  }

  async request(url, options, media = false) {
    let target = media ? mediaUrl(url) : url;
    for (let redirects = 0; redirects < 5; redirects++) {
      const response = await this.fetch(target, { ...options, redirect: 'manual' });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (!media) throw new Error('Unexpected TIDAL API redirect.');
        target = mediaUrl(response.headers.get('location'), target);
      } else return response;
    }
    throw new Error('Too many media redirects.');
  }

  async api(resource, params, signal) {
    let apiSubStatus;
    let rejectedAuthorization;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      const session = await this.getSession(apiSubStatus, signal);
      apiSubStatus = undefined;
      signal.throwIfAborted();
      if (!(session?.accessToken || session?.sessionId) || !session.countryCode)
        throw new Error('Sign in to TIDAL before downloading.');
      const authentication = session.accessToken
        ? { Authorization: `Bearer ${session.accessToken}` }
        : { 'X-Tidal-SessionId': session.sessionId };
      const authorization = Object.values(authentication)[0];
      if (authorization === rejectedAuthorization)
        throw new Error('Your TIDAL session expired. Sign in again and retry.');
      const url = new URL(`https://api.tidal.com/v1/${resource}`);
      url.search = new URLSearchParams({ countryCode: session.countryCode, ...params }).toString();
      const response = await this.request(url.href, {
        headers: { ...authentication, Accept: 'application/json' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      });
      if (response.status === 401 && !rejectedAuthorization && attempt < 2) {
        // Follow the client's refresh flow: pass the API substatus back to its
        // credential provider and retry only if the provider gives a new token.
        const error = await response.json().catch(() => ({}));
        if (typeof error?.subStatus === 'number' || typeof error?.subStatus === 'string')
          apiSubStatus = String(error.subStatus);
        rejectedAuthorization = authorization;
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const wait = Math.min(
          30,
          Math.max(1, Number(response.headers.get('retry-after')) || (attempt + 1) * 2),
        );
        await response.body?.cancel();
        await delay(wait * 1000, undefined, { signal });
        continue;
      }
      if (response.status === 401) {
        await response.body?.cancel();
        throw new Error('Your TIDAL session expired. Sign in again and retry.');
      }
      if (response.status === 403)
        throw new Error('This item or quality is not available to your TIDAL account.');
      if (!response.ok) throw new Error(`TIDAL request failed (${response.status}).`);
      return response.json();
    }
  }

  async list(resource, params, signal) {
    const items = [];
    for (let offset = 0; offset < MAX_ITEMS; ) {
      const page = await this.api(
        resource,
        { ...params, limit: '100', offset: String(offset) },
        signal,
      );
      if (!Array.isArray(page.items)) throw new Error('TIDAL returned an invalid collection.');
      items.push(...page.items);
      offset += page.items.length;
      if (
        !page.items.length ||
        (Number.isFinite(page.totalNumberOfItems)
          ? offset >= page.totalNumberOfItems
          : page.items.length < 100)
      )
        return items;
    }
    throw new Error(`Collections larger than ${MAX_ITEMS} items are not supported.`);
  }

  async resolve(job, settings) {
    const { type, id } = job.reference;
    const signal = job.abort.signal;
    const item = await this.api(`${type}s/${id}`, {}, signal);
    job.title = item.title || item.name || job.title;
    this.publish();
    if (type === 'track' || type === 'video') return [{ type, item, index: item.trackNumber || 1 }];
    if (type === 'artist') {
      const albums = await this.list(`artists/${id}/albums`, {}, signal);
      if (settings.includeEP)
        albums.push(
          ...(await this.list(`artists/${id}/albums`, { filter: 'EPSANDSINGLES' }, signal)),
        );
      const tracks = [];
      for (const album of new Map(albums.map((a) => [a.id, a])).values()) {
        const entries = await this.list(`albums/${album.id}/items`, {}, signal);
        tracks.push(...entries.map((entry, index) => ({ ...entry, album, index: index + 1 })));
        if (tracks.length > MAX_ITEMS)
          throw new Error('This artist collection is too large. Download individual albums.');
      }
      return tracks;
    }
    const entries = await this.list(`${type}s/${id}/items`, {}, signal);
    return entries.map((entry, index) => ({
      ...entry,
      index: index + 1,
      ...(type === 'album' ? { album: item } : { playlist: item }),
    }));
  }

  async run() {
    if (this.running || this.paused || this.stopped) return;
    this.running = true;
    try {
      while (!this.paused && !this.stopped) {
        const job = this.jobs.find((item) => item.status === 'queued');
        if (!job) break;
        const settings = { ...this.settings.value };
        const signal = job.abort.signal;
        job.status = 'resolving';
        this.publish();
        try {
          const entries = (await this.resolve(job, settings)).filter(
            (entry) =>
              entry.type === 'track' || (entry.type === 'video' && settings.downloadVideos),
          );
          if (!entries.length) throw new Error('No downloadable items in this selection.');
          job.total = entries.length;
          job.status = 'downloading';
          this.publish();
          let cursor = 0;
          const albums = new Map();
          const work = async () => {
            while (cursor < entries.length && !signal.aborted) {
              const entry = entries[cursor++];
              job.current = entry.item.title;
              this.publish();
              try {
                const skipped = await this.downloadItem(entry, settings, job, albums);
                if (skipped) job.skipped++;
                else job.completed++;
              } catch (error) {
                if (signal.aborted) break;
                job.failed++;
                if (job.errors.length < 100)
                  job.errors.push(`${entry.item.title}: ${error.message}`);
              }
              this.publish();
            }
          };
          await Promise.all(Array.from({ length: settings.multiThread ? 3 : 1 }, work));
          job.status = signal.aborted ? 'cancelled' : job.failed ? 'failed' : 'completed';
        } catch (error) {
          job.status = signal.aborted ? 'cancelled' : 'failed';
          if (!signal.aborted) job.errors.push(error.message);
        }
        job.current = '';
        this.publish();
      }
    } finally {
      this.running = false;
    }
  }

  async stream(urls, destination, job, encryption) {
    const engine = this;
    const signal = job.abort.signal;
    let lastUpdate = 0;
    async function* chunks() {
      for (const url of urls) {
        signal.throwIfAborted();
        const response = await engine.request(
          url,
          { signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) },
          true,
        );
        if (!response.ok || !response.body)
          throw new Error(`Media download failed (${response.status}). Retry the download.`);
        for await (const chunk of response.body) {
          signal.throwIfAborted();
          job.bytes += chunk.byteLength;
          if (Date.now() - lastUpdate > 250) {
            lastUpdate = Date.now();
            engine.publish();
          }
          yield chunk;
        }
      }
    }
    const transforms = encryption ? [createLegacyDecipher(encryption.keyId)] : [];
    await pipeline(chunks(), ...transforms, fs.createWriteStream(destination, { flags: 'wx' }), {
      signal,
    });
    if (!(await fsp.stat(destination)).size) throw new Error('TIDAL returned an empty media file.');
  }

  async downloadItem(entry, settings, job, albums) {
    const signal = job.abort.signal;
    const { item, type, playlist, index } = entry;
    if (item.streamReady === false || item.allowStreaming === false)
      throw new Error('This item is unavailable.');
    let album = entry.album || item.album || {};
    if (type === 'track' && !entry.album && album.id) {
      if (!albums.has(album.id)) albums.set(album.id, this.api(`albums/${album.id}`, {}, signal));
      album = await albums.get(album.id);
    }
    const playback = await this.api(
      `${type}s/${item.id}/playbackinfopostpaywall`,
      {
        [type === 'video' ? 'videoquality' : 'audioquality']:
          type === 'video' ? 'HIGH' : settings.audioQuality,
        playbackmode: 'STREAM',
        assetpresentation: 'FULL',
      },
      signal,
    );
    let manifest = parseManifest(playback, type);
    for (let depth = 0; manifest.hls || manifest.variant; depth++) {
      if (depth >= 3) throw new Error('Too many nested video playlists.');
      const url = manifest.hls || manifest.variant;
      const response = await this.request(
        url,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) },
        true,
      );
      if (!response.ok) throw new Error(`Video manifest request failed (${response.status}).`);
      manifest = parseHls(await response.text(), url, settings.videoQuality);
    }
    const destination = outputPath(
      settings,
      item,
      album,
      playlist,
      index,
      manifest.extension,
      playback.audioQuality || settings.audioQuality,
    );
    // A playlist can contain the same track more than once, and custom templates can collide.
    const previous = this.pathLocks.get(destination) || Promise.resolve();
    let unlock;
    const lock = new Promise((resolve) => {
      unlock = resolve;
    });
    this.pathLocks.set(destination, lock);
    await previous;
    let temp;
    try {
      signal.throwIfAborted();
      if (settings.checkExist && (await fileExists(destination))) return true;
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      temp = await fsp.mkdtemp(path.join(path.dirname(destination), '.tep-'));
      const raw = path.join(temp, 'media');
      await this.stream(manifest.urls, raw, job, manifest.encryption);
      const coverId = album.cover || item.imageId || item.image;
      let cover;
      if (settings.saveCovers && /^[a-f\d-]+$/i.test(coverId || '')) {
        try {
          cover = path.join(temp, 'cover.jpg');
          await this.stream(
            [`https://resources.tidal.com/images/${coverId.replace(/-/g, '/')}/1280x1280.jpg`],
            cover,
            job,
          );
        } catch (error) {
          if (signal.aborted) throw error;
          cover = undefined;
          this.warn(job, `${item.title}: cover artwork could not be saved.`);
        }
      }
      const output = path.join(temp, `tagged.${manifest.extension}`);
      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-y',
        '-protocol_whitelist',
        'file,pipe',
        '-i',
        raw,
      ];
      if (cover && type === 'track') args.push('-i', cover);
      args.push('-map', '0:a:0');
      if (type === 'video') args.push('-map', '0:v:0');
      else if (cover) args.push('-map', '1:v:0', '-disposition:v:0', 'attached_pic');
      args.push('-c', 'copy');
      for (const [key, value] of Object.entries({
        title: item.version ? `${item.title} (${item.version})` : item.title,
        artist: item.artists?.map((a) => a.name).join('; ') || item.artist?.name,
        album: album.title,
        album_artist: album.artist?.name,
        date: album.releaseDate,
        track: item.trackNumber || index,
        disc: item.volumeNumber || 1,
        copyright: item.copyright || album.copyright,
        isrc: item.isrc,
      })) {
        if (value != null)
          args.push('-metadata', `${key}=${String(value).replace(/[\r\n\0]/g, ' ')}`);
      }
      if (manifest.extension !== 'flac') args.push('-movflags', '+faststart');
      args.push(output);
      try {
        await execute(this.ffmpegPath, args, {
          windowsHide: true,
          signal,
          timeout: 300000,
          maxBuffer: 1024 * 1024,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new Error(
          'Could not finalize the media file. Check that the bundled FFmpeg helper is available and retry.',
        );
      }
      signal.throwIfAborted();
      if (!(await fsp.stat(output)).size) throw new Error('The finalized media file is empty.');
      if (settings.checkExist) {
        try {
          await fsp.copyFile(output, destination, fs.constants.COPYFILE_EXCL);
        } catch (error) {
          if (error.code === 'EEXIST') return true;
          throw error;
        }
      } else await fsp.rename(output, destination);
      try {
        if (cover) await fsp.copyFile(cover, path.join(path.dirname(destination), 'cover.jpg'));
        if (settings.saveAlbumInfo)
          await fsp.writeFile(
            path.join(path.dirname(destination), `album-${album.id || item.id}.json`),
            JSON.stringify(album, null, 2),
          );
        if (settings.lyricFile && type === 'track') {
          const lyrics = await this.api(`tracks/${item.id}/lyrics`, {}, signal);
          const contents = lyrics.subtitles || lyrics.lyrics;
          if (contents)
            await fsp.writeFile(
              destination.replace(/\.[^.]+$/, lyrics.subtitles ? '.lrc' : '.txt'),
              contents,
            );
        }
      } catch {
        if (!signal.aborted)
          this.warn(
            job,
            `${item.title}: an optional artwork, lyrics, or album information file could not be saved.`,
          );
      }
      return false;
    } finally {
      if (temp)
        await fsp
          .rm(temp, { recursive: true, force: true })
          .catch(() => this.warn(job, 'A temporary download folder could not be removed.'));
      unlock();
      if (this.pathLocks.get(destination) === lock) this.pathLocks.delete(destination);
    }
  }

  warn(job, message) {
    if (job.warnings.length < 100) job.warnings.push(message);
  }
}

async function fileExists(file) {
  try {
    return (await fsp.stat(file)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

module.exports = { DownloadEngine };

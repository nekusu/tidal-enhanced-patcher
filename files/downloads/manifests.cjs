const { XMLParser, XMLValidator } = require('fast-xml-parser');

const array = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);
const MAX_SEGMENTS = 100000;

function mediaUrl(value, base) {
  const url = new URL(value, base);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !['tidal.com', 'tidalhifi.com'].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    )
  )
    throw new Error('Unsupported media host.');
  return url.href;
}

function parseReference(value) {
  if (value && typeof value === 'object') {
    const type = String(value.type).toLowerCase();
    const id = String(value.id);
    if (!['track', 'album', 'playlist', 'artist', 'video'].includes(type))
      throw new Error('Unsupported TIDAL item.');
    if (
      type === 'playlist'
        ? !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(id)
        : !/^\d{1,20}$/.test(id)
    )
      throw new Error('Invalid TIDAL item ID.');
    return { type, id };
  }
  const url = new URL(String(value), 'https://tidal.com');
  if (
    !['https:', 'tidal:'].includes(url.protocol) ||
    !['tidal.com', 'www.tidal.com', 'listen.tidal.com', 'desktop.tidal.com', 'browse'].includes(
      url.hostname,
    )
  )
    throw new Error('Use a TIDAL track, album, playlist, artist, or video link.');
  const match = url.pathname.match(
    /^\/(?:browse\/)?(track|album|playlist|artist|video)\/([^/]+)\/?$/,
  );
  if (!match) throw new Error('Use a TIDAL track, album, playlist, artist, or video link.');
  return parseReference({ type: match[1], id: match[2] });
}

function parseDash(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new Error('Invalid audio manifest.');
  if (/(?:\w+:)?ContentProtection\b/.test(xml))
    throw new Error('DRM-protected DASH audio is not supported by this downloader.');
  const mpd = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    removeNSPrefix: true,
  }).parse(xml).MPD;
  if (!mpd || mpd.type === 'dynamic' || array(mpd.Period).length !== 1)
    throw new Error('Unsupported audio manifest.');
  const period = array(mpd.Period)[0];
  const candidates = array(period.AdaptationSet).flatMap((adaptation) =>
    array(adaptation.Representation).map((rep) => ({ adaptation, rep })),
  );
  const selected = candidates
    .filter(
      ({ adaptation, rep }) =>
        (adaptation.contentType || '').includes('audio') ||
        (rep.mimeType || adaptation.mimeType || '').startsWith('audio/'),
    )
    .sort((a, b) => Number(b.rep.bandwidth) - Number(a.rep.bandwidth))[0];
  if (!selected) throw new Error('No audio in this manifest.');
  const { adaptation, rep } = selected;
  const template = rep.SegmentTemplate || adaptation.SegmentTemplate;
  if (!template?.initialization || !template.media || !template.SegmentTimeline)
    throw new Error('Unsupported DASH segment layout.');
  let base;
  for (const node of [mpd, period, adaptation, rep]) {
    if (node.BaseURL)
      base = mediaUrl(
        typeof node.BaseURL === 'object' ? node.BaseURL['#text'] : node.BaseURL,
        base,
      );
  }
  let number = Number(template.startNumber || 1);
  let time = 0;
  const expand = (source) =>
    mediaUrl(
      String(source).replace(
        /\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g,
        (_, key, width) => {
          const value = {
            RepresentationID: rep.id,
            Bandwidth: rep.bandwidth,
            Number: number,
            Time: time,
          }[key];
          if (value == null || Number(width || 0) > 20) throw new Error('Invalid DASH template.');
          return String(value).padStart(Number(width || 0), '0');
        },
      ),
      base,
    );
  const urls = [expand(template.initialization)];
  for (const segment of array(template.SegmentTimeline.S)) {
    const repeat = Number(segment.r || 0);
    const duration = Number(segment.d);
    if (
      !Number.isSafeInteger(repeat) ||
      repeat < 0 ||
      repeat > MAX_SEGMENTS ||
      !Number.isSafeInteger(duration) ||
      duration <= 0
    )
      throw new Error('Unsupported DASH timeline.');
    if (segment.t != null) time = Number(segment.t);
    if (!Number.isSafeInteger(time) || time < 0) throw new Error('Invalid DASH timestamp.');
    for (let i = 0; i <= repeat; i++) {
      if (urls.length >= MAX_SEGMENTS) throw new Error('Audio manifest is too large.');
      urls.push(expand(template.media));
      number++;
      time += duration;
    }
  }
  if (urls.length < 2) throw new Error('Empty audio manifest.');
  return { urls, extension: /flac/i.test(rep.codecs || adaptation.codecs || '') ? 'flac' : 'm4a' };
}

function parseManifest(playback, type) {
  if (playback.assetPresentation && playback.assetPresentation !== 'FULL')
    throw new Error('TIDAL only returned a preview for this item.');
  if (typeof playback.manifest !== 'string' || playback.manifest.length > 4_000_000)
    throw new Error('Invalid playback manifest.');
  const content = Buffer.from(playback.manifest, 'base64').toString('utf8');
  if (playback.manifestMimeType?.includes('dash+xml')) return parseDash(content);
  const data = JSON.parse(content);
  const scheme = String(data.encryptionType || 'NONE').toUpperCase();
  if (!['NONE', 'OLD_AES'].includes(scheme)) {
    const label = /^[A-Z\d_-]{1,40}$/.test(scheme) ? scheme : 'unknown';
    throw new Error(`This downloader does not support this audio encryption format (${label}).`);
  }
  let encryption;
  if (scheme === 'OLD_AES' || data.keyId) {
    if (type !== 'track')
      throw new Error('This downloader does not support encrypted video manifests.');
    if (typeof data.keyId !== 'string' || !data.keyId)
      throw new Error('TIDAL returned legacy encrypted audio without its decryption token.');
    // Older BTS manifests only identify legacy encryption through the keyId field.
    encryption = { type: 'OLD_AES', keyId: data.keyId };
  }
  if (!Array.isArray(data.urls) || !data.urls.length)
    throw new Error('No downloadable stream was returned.');
  // BTS URLs are alternative mirrors, not sequential segments.
  const url = mediaUrl(data.urls[0]);
  if (type === 'video') return { hls: url, extension: 'mp4' };
  return {
    urls: [url],
    extension: /flac/i.test(`${data.codecs} ${data.mimeType}`) ? 'flac' : 'm4a',
    ...(encryption ? { encryption } : {}),
  };
}

function parseHls(text, base, quality) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('Invalid video manifest.');
  if (
    lines.some(
      (line) => line.startsWith('#EXT-X-KEY:') && !/(?:^|,)METHOD=NONE(?:,|$)/.test(line.slice(11)),
    )
  )
    throw new Error('This downloader does not support encrypted HLS video.');
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    if (/AUDIO=/.test(lines[i]))
      throw new Error('Separate video audio renditions are not supported.');
    const height = Number(lines[i].match(/RESOLUTION=\d+x(\d+)/)?.[1]);
    if (!height || !lines[i + 1] || lines[i + 1].startsWith('#'))
      throw new Error('Invalid video variant.');
    variants.push({ height, url: mediaUrl(lines[i + 1], base) });
  }
  if (variants.length) {
    variants.sort((a, b) => b.height - a.height);
    return {
      variant: (variants.find((v) => v.height <= Number(quality.slice(1))) || variants.at(-1)).url,
    };
  }
  if (!lines.includes('#EXT-X-ENDLIST')) throw new Error('Live video downloads are not supported.');
  if (lines.some((line) => /^#EXT-X-(BYTERANGE|DISCONTINUITY)/.test(line)))
    throw new Error('Unsupported video segment layout.');
  const urls = [];
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP:')) {
      const uri = line.match(/URI="([^"]+)"/)?.[1];
      if (!uri || /BYTERANGE=/.test(line) || urls.length)
        throw new Error('Unsupported video initialization segment.');
      urls.push(mediaUrl(uri, base));
    } else if (!line.startsWith('#')) urls.push(mediaUrl(line, base));
  }
  if (!urls.length || urls.length > MAX_SEGMENTS) throw new Error('Invalid video segment count.');
  return { urls, extension: 'mp4' };
}

module.exports = { mediaUrl, parseReference, parseDash, parseManifest, parseHls };

const fs = require('node:fs');
const path = require('node:path');

const QUALITY = {
  Normal: 'LOW',
  High: 'HIGH',
  HiFi: 'LOSSLESS',
  Master: 'HI_RES_LOSSLESS',
  Max: 'HI_RES_LOSSLESS',
};
const TOKENS = new Set([
  'ArtistName',
  'ArtistsName',
  'AlbumArtistName',
  'AlbumTitle',
  'AlbumID',
  'AlbumYear',
  'Flag',
  'AudioQuality',
  'Duration',
  'DurationSeconds',
  'NumberOfTracks',
  'NumberOfVideos',
  'NumberOfVolumes',
  'ReleaseDate',
  'RecordType',
  'TrackNumber',
  'TrackTitle',
  'TrackID',
  'ExplicitFlag',
  'VolumeNumber',
  'PlaylistName',
  'PlaylistUUID',
  'VideoNumber',
  'VideoTitle',
  'VideoYear',
  'None',
]);

function defaults(musicPath) {
  return {
    downloadPath: path.join(musicPath, 'TIDAL'),
    audioQuality: 'HI_RES_LOSSLESS',
    videoQuality: 'P1080',
    checkExist: true,
    includeEP: true,
    saveCovers: true,
    lyricFile: false,
    saveAlbumInfo: false,
    downloadVideos: true,
    multiThread: true,
    usePlaylistFolder: true,
    albumFolderFormat: '{ArtistName}/{AlbumTitle} [{AlbumID}] [{AlbumYear}]',
    playlistFolderFormat: 'Playlists/{PlaylistName} [{PlaylistUUID}]',
    trackFileFormat: '{TrackNumber} - {ArtistName} - {TrackTitle}{ExplicitFlag}',
    videoFileFormat: '{VideoNumber} - {ArtistName} - {VideoTitle}{ExplicitFlag}',
  };
}

function validateSettings(input, current) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid download settings.');
  const next = { ...current };
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(current, key)) throw new Error(`Unknown download setting: ${key}`);
    if (typeof value !== typeof current[key]) throw new Error(`Invalid value for ${key}.`);
    if (
      typeof value === 'string' &&
      (!value.trim() || value.length > 1000 || /[\r\n\0]/.test(value))
    )
      throw new Error(`Invalid value for ${key}.`);
    next[key] = value;
  }
  if (!path.isAbsolute(next.downloadPath)) throw new Error('Choose an absolute download folder.');
  if (!['LOW', 'HIGH', 'LOSSLESS', 'HI_RES_LOSSLESS'].includes(next.audioQuality))
    throw new Error('Invalid audio quality.');
  if (!['P360', 'P480', 'P720', 'P1080'].includes(next.videoQuality))
    throw new Error('Invalid video quality.');
  for (const key of [
    'albumFolderFormat',
    'playlistFolderFormat',
    'trackFileFormat',
    'videoFileFormat',
  ]) {
    const format = next[key];
    if (
      path.win32.isAbsolute(format) ||
      path.posix.isAbsolute(format) ||
      format.split(/[\\/]/).some((part) => part === '.' || part === '..')
    )
      throw new Error('Naming formats must stay inside the download folder.');
    if (key.endsWith('FileFormat') && /[\\/]/.test(format))
      throw new Error('File name formats cannot contain folders.');
    const literal = format.replace(/\{(\w+)\}/g, (_, token) => {
      if (!TOKENS.has(token)) throw new Error(`Unknown naming placeholder: {${token}}`);
      return '';
    });
    if (/[{}<>:"|?*]/.test(literal)) throw new Error(`Invalid characters in ${key}.`);
  }
  return next;
}

class SettingsStore {
  constructor(filePath, legacyPath, musicPath) {
    this.filePath = filePath;
    this.value = defaults(musicPath);
    this.warning = '';
    const source = fs.existsSync(filePath) ? filePath : legacyPath;
    if (!fs.existsSync(source)) return;
    try {
      const input = JSON.parse(fs.readFileSync(source, 'utf8'));
      // Import preferences only. CLI credentials and API keys are never copied.
      for (const key of Object.keys(this.value)) {
        if (!Object.hasOwn(input, key)) continue;
        const value = key === 'audioQuality' ? QUALITY[input[key]] || input[key] : input[key];
        try {
          this.value = validateSettings({ [key]: value }, this.value);
        } catch {
          this.warning = 'Some saved preferences were invalid and have been reset to defaults.';
        }
      }
      if (source === legacyPath) this.save(this.value);
    } catch {
      this.warning =
        'Download settings could not be read. Defaults are in use; save settings to replace them.';
    }
  }

  save(input) {
    const next = validateSettings(input, this.value);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
    this.value = next;
    this.warning = '';
    return next;
  }
}

function cleanName(value) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Windows filenames cannot contain control characters.
  const invalidCharacters = /[<>:"/\\|?*\x00-\x1f]/g;
  let name = String(value ?? '')
    .replace(invalidCharacters, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name.slice(0, 160).replace(/[. ]+$/g, '') || '_';
}

function formatPath(format, values) {
  return format
    .split(/[\\/]/)
    .map((part) =>
      cleanName(
        part.replace(/\{(\w+)\}/g, (_, key) =>
          values[key] === '' ? '' : cleanName(values[key] ?? ''),
        ),
      ),
    )
    .join(path.sep);
}

function outputPath(settings, item, album, playlist, index, extension, quality) {
  const artist =
    album.artist?.name || item.artist?.name || item.artists?.[0]?.name || 'Unknown artist';
  const year = String(album.releaseDate || item.releaseDate || '').slice(0, 4);
  const duration = item.duration || 0;
  const values = {
    ArtistName: item.artist?.name || item.artists?.[0]?.name || artist,
    ArtistsName: item.artists?.map((a) => a.name).join(', ') || artist,
    AlbumArtistName: artist,
    AlbumTitle: album.title || item.title,
    AlbumID: album.id || item.id,
    AlbumYear: year,
    AudioQuality: quality,
    TrackID: item.id,
    TrackTitle: item.version ? `${item.title} (${item.version})` : item.title,
    TrackNumber: String(playlist ? index : item.trackNumber || index).padStart(2, '0'),
    VolumeNumber: item.volumeNumber || 1,
    ExplicitFlag: item.explicit ? ' (Explicit)' : '',
    Flag: item.explicit ? 'E' : '',
    PlaylistName: playlist?.title,
    PlaylistUUID: playlist?.uuid,
    VideoNumber: String(index).padStart(2, '0'),
    VideoTitle: item.title,
    VideoYear: year,
    ReleaseDate: album.releaseDate || '',
    RecordType: album.type || '',
    DurationSeconds: duration,
    Duration: `${Math.floor(duration / 60)}-${String(duration % 60).padStart(2, '0')}`,
    NumberOfTracks: album.numberOfTracks || '',
    NumberOfVideos: album.numberOfVideos || '',
    NumberOfVolumes: album.numberOfVolumes || 1,
    None: '',
  };
  const inPlaylist = playlist && settings.usePlaylistFolder;
  const folderValues = inPlaylist ? values : { ...values, ArtistName: artist };
  let folder = formatPath(
    inPlaylist ? settings.playlistFolderFormat : settings.albumFolderFormat,
    folderValues,
  );
  if (!inPlaylist && album.numberOfVolumes > 1)
    folder = path.join(folder, `Disc ${values.VolumeNumber}`);
  const file = formatPath(
    extension === 'mp4' ? settings.videoFileFormat : settings.trackFileFormat,
    values,
  );
  const root = path.resolve(settings.downloadPath);
  const destination = path.resolve(root, folder, `${file}.${extension}`);
  const relative = path.relative(root, destination);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error('Invalid download path.');
  return destination;
}

module.exports = { SettingsStore, defaults, validateSettings, cleanName, formatPath, outputPath };

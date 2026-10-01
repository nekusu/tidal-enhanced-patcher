import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFile, statFile } from '@electron/asar';
import { installAsarPackage } from '../scripts/archive';
import { unpatch } from '../scripts/unpatch';

let resourcesPath: string;
let asarFilePath: string;
let originalAsarFilePath: string;
let sourcePath: string;

beforeEach(async () => {
  resourcesPath = await mkdtemp(join(tmpdir(), 'tep-archive-test-'));
  asarFilePath = join(resourcesPath, 'app.asar');
  originalAsarFilePath = join(resourcesPath, 'app_original.asar');
  sourcePath = join(resourcesPath, 'src');
  await mkdir(sourcePath);
  await writeFile(join(sourcePath, 'index.js'), 'patched application');
});

afterEach(async () => {
  await rm(resourcesPath, { recursive: true, force: true });
});

describe('archive recovery', () => {
  test('restores the backup when app.asar is missing', async () => {
    await writeFile(originalAsarFilePath, 'original archive');

    expect(await unpatch(resourcesPath)).toBe(true);
    expect(await readFile(asarFilePath, 'utf8')).toBe('original archive');
    expect(existsSync(originalAsarFilePath)).toBe(false);
  });

  test('replaces an existing patched archive', async () => {
    await writeFile(asarFilePath, 'patched archive');
    await writeFile(originalAsarFilePath, 'original archive');

    expect(await unpatch(resourcesPath)).toBe(true);
    expect(await readFile(asarFilePath, 'utf8')).toBe('original archive');
  });

  test('reports failure without deleting the app if the backup is missing', async () => {
    await writeFile(asarFilePath, 'working archive');

    expect(await unpatch(resourcesPath)).toBe(false);
    expect(await readFile(asarFilePath, 'utf8')).toBe('working archive');
  });

  test('retains the backup when restoration fails', async () => {
    await mkdir(asarFilePath);
    await writeFile(join(asarFilePath, 'keep'), 'existing content');
    await writeFile(originalAsarFilePath, 'original archive');

    expect(await unpatch(resourcesPath)).toBe(false);
    expect(await readFile(originalAsarFilePath, 'utf8')).toBe('original archive');
    expect(await readFile(join(asarFilePath, 'keep'), 'utf8')).toBe('existing content');
  });
});

describe('archive installation', () => {
  test('installs the new archive and FFmpeg while keeping the original files', async () => {
    const ffmpegPath = join('node_modules', 'ffmpeg-static', 'ffmpeg.exe');
    await writeFile(asarFilePath, 'original archive');
    await mkdir(join(sourcePath, 'node_modules', 'ffmpeg-static'), { recursive: true });
    await writeFile(join(sourcePath, ffmpegPath), 'fixture executable');
    await mkdir(`${asarFilePath}.unpacked`);
    await writeFile(join(`${asarFilePath}.unpacked`, 'original.node'), 'native library');

    await installAsarPackage(resourcesPath, sourcePath);

    expect(await readFile(originalAsarFilePath, 'utf8')).toBe('original archive');
    expect(extractFile(asarFilePath, 'index.js').toString()).toBe('patched application');
    expect(statFile(asarFilePath, ffmpegPath).unpacked).toBe(true);
    expect(extractFile(asarFilePath, ffmpegPath).toString()).toBe('fixture executable');
    expect(await readFile(join(`${asarFilePath}.unpacked`, 'original.node'), 'utf8')).toBe(
      'native library',
    );
    expect((await readdir(resourcesPath)).some((name) => name.startsWith('.tep-archive-'))).toBe(
      false,
    );
  });

  // Creating symlinks on Windows can require administrator privileges.
  test.skipIf(process.platform === 'win32')(
    'keeps app.asar intact if ASAR packaging fails',
    async () => {
      await writeFile(asarFilePath, 'original archive');
      await symlink('../app.asar', join(sourcePath, 'outside-package'));

      await expect(installAsarPackage(resourcesPath, sourcePath)).rejects.toThrow(
        'links out of the package',
      );
      expect(await readFile(asarFilePath, 'utf8')).toBe('original archive');
      expect(existsSync(originalAsarFilePath)).toBe(false);
      expect(await readdir(resourcesPath)).toEqual(['app.asar', 'src']);
    },
  );

  test('keeps app.asar intact if installing unpacked files fails', async () => {
    const ffmpegPath = join('node_modules', 'ffmpeg-static', 'ffmpeg.exe');
    await writeFile(asarFilePath, 'original archive');
    await mkdir(join(sourcePath, 'node_modules', 'ffmpeg-static'), { recursive: true });
    await writeFile(join(sourcePath, ffmpegPath), 'fixture executable');
    await mkdir(join(`${asarFilePath}.unpacked`, ffmpegPath), { recursive: true });

    await expect(installAsarPackage(resourcesPath, sourcePath)).rejects.toThrow();
    expect(await readFile(asarFilePath, 'utf8')).toBe('original archive');
    expect(await readFile(originalAsarFilePath, 'utf8')).toBe('original archive');
  });

  test('refuses to overwrite an existing backup', async () => {
    await writeFile(asarFilePath, 'working archive');
    await writeFile(originalAsarFilePath, 'original archive');

    await expect(installAsarPackage(resourcesPath, sourcePath)).rejects.toThrow('EEXIST');
    expect(await readFile(asarFilePath, 'utf8')).toBe('working archive');
    expect(await readFile(originalAsarFilePath, 'utf8')).toBe('original archive');
  });
});

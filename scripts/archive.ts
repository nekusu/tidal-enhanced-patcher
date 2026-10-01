import { constants } from 'node:fs';
import { copyFile, cp, exists, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createPackageWithOptions, uncache } from '@electron/asar';

export async function installAsarPackage(appResourcesPath: string, sourcePath: string) {
  const asarFilePath = join(appResourcesPath, 'app.asar');
  const originalAsarFilePath = join(appResourcesPath, 'app_original.asar');
  // Keep staging on the same filesystem so the final rename replaces the archive atomically.
  const stagingPath = await mkdtemp(join(appResourcesPath, '.tep-archive-'));
  const stagedAsarFilePath = join(stagingPath, 'app.asar');

  try {
    const output: unknown = await createPackageWithOptions(sourcePath, stagedAsarFilePath, {
      unpackDir: '**/ffmpeg-static',
    });
    // ASAR 4.0.1 returns its output stream before it has finished writing.
    if (output instanceof Writable) await finished(output);

    await copyFile(asarFilePath, originalAsarFilePath, constants.COPYFILE_EXCL);
    if (await exists(`${stagedAsarFilePath}.unpacked`)) {
      // Preserve the original unpacked files, which are still needed after unpatching.
      await cp(`${stagedAsarFilePath}.unpacked`, `${asarFilePath}.unpacked`, {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
    await rename(stagedAsarFilePath, asarFilePath);
    uncache(asarFilePath);
  } finally {
    await rm(stagingPath, { recursive: true, force: true });
  }
}

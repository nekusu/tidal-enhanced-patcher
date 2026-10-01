import { exists, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '@clack/prompts';
import { uncache } from '@electron/asar';

export async function unpatch(appResourcesPath: string) {
  const asarFilePath = join(appResourcesPath, 'app.asar');
  const originalAsarFilePath = join(appResourcesPath, 'app_original.asar');

  try {
    if (!(await exists(originalAsarFilePath))) throw new Error('Original asar file not found');
    // Rename replaces an existing archive and also recovers a missing one.
    await rename(originalAsarFilePath, asarFilePath);
    uncache(asarFilePath);
    log.success('TIDAL unpatched successfully');
    return true;
  } catch (error) {
    log.error((error as Error).message);
    log.info('TIDAL could not be unpatched. Check the logs above for more information');
    return false;
  }
}

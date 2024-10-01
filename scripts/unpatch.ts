import { exists, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '@clack/prompts';

export async function unpatch(appResourcesPath: string) {
  const asarFilePath = join(appResourcesPath, 'app.asar');
  const originalAsarFilePath = join(appResourcesPath, 'app_original.asar');

  try {
    if (!(await exists(originalAsarFilePath))) throw new Error('Original asar file not found');
    await rm(asarFilePath);
    await rename(originalAsarFilePath, asarFilePath);
    log.success('TIDAL unpatched successfully');
  } catch (error) {
    log.error((error as Error).message);
    log.info('TIDAL could not be unpatched. Check the logs above for more information');
  }
}

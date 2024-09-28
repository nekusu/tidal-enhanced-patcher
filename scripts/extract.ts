import { exists } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '@clack/prompts';
import { extractSourceFiles } from '../utils';

export async function extract(appResourcesPath: string) {
  const asarFilePath = join(appResourcesPath, 'app.asar');
  const originalAsarFilePath = join(appResourcesPath, 'app_original.asar');
  const sourcePath = join(appResourcesPath, 'src');

  try {
    const pathToExtract = asarFilePath;
    // let pathToExtract = asarFilePath;
    if (await exists(originalAsarFilePath)) {
      log.info('TIDAL is patched. Patched asar file will be extracted');

      // extracting from app_original.asar fails for some reason
      // const file = await select({
      //   message: 'TIDAL is already patched. Select asar file to extract:',
      //   options: [
      //     { value: 'original', label: 'Original' },
      //     { value: 'patched', label: 'Patched' },
      //   ],
      // });
      // if (file === 'original') pathToExtract = originalAsarFilePath;
      // else if (file === 'patched') pathToExtract = asarFilePath;
    }
    await extractSourceFiles(pathToExtract, sourcePath);
  } catch (error) {
    log.error((error as Error).message);
  }
}

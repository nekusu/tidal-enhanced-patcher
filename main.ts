import { cancel, confirm, intro, isCancel, outro, select } from '@clack/prompts';
import { extract } from './scripts/extract';
import { patch } from './scripts/patch';
import { unpatch } from './scripts/unpatch';
import {
  existsInDefaultPath,
  getAppResourcesPath,
  isAppRunning,
  isSupportedPlatform,
  waitForTimeout,
} from './utils';

const scripts = { patch, unpatch, extract };

async function main() {
  intro('TIDAL Enhanced Patcher - https://github.com/nekusu/tidal-enhanced-patcher');

  if (!isSupportedPlatform() || (await isAppRunning()) || !(await existsInDefaultPath())) return;

  const appResourcesPath = await getAppResourcesPath();
  if (!appResourcesPath) return;

  while (true) {
    const script = await select({
      message: 'What do you want to do?',
      options: [
        { value: 'patch', label: 'Patch' },
        { value: 'unpatch', label: 'Unpatch' },
        {
          value: 'extract',
          label: 'Extract source files',
          hint: 'Run only if you know what you are doing',
        },
      ],
    });

    if (isCancel(script)) {
      cancel('Exiting...');
      break;
    }

    await scripts[script as keyof typeof scripts](appResourcesPath);
    if (await confirm({ message: 'Exit?' })) {
      outro('✨ Thank you for using TIDAL Enhanced Patcher!');
      await waitForTimeout(1000);
      break;
    }
  }
}

main();

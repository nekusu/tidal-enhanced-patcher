import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import downloadMenu from '../files/downloadMenu.js' with { type: 'text' };
import context from '../files/downloads/context.cjs' with { type: 'text' };
import controller from '../files/downloads/DownloadController.cjs' with { type: 'text' };
import decryption from '../files/downloads/decryption.cjs' with { type: 'text' };
import engine from '../files/downloads/engine.cjs' with { type: 'text' };
import manifests from '../files/downloads/manifests.cjs' with { type: 'text' };
import preload from '../files/downloads/preload.js' with { type: 'text' };
import session from '../files/downloads/session.cjs' with { type: 'text' };
import settings from '../files/downloads/settings.cjs' with { type: 'text' };
import notices from '../files/downloads/THIRD_PARTY_NOTICES.txt' with { type: 'text' };

const MARKER = '/* TIDAL Enhanced native downloads */';

export async function addNativeDownloads(sourcePath: string) {
  const mainPath = join(sourcePath, 'app/main');
  const menuPath = join(mainPath, 'menu/MenuController.js');
  const preloadPath = join(sourcePath, 'app/clientInterface/index.js');
  let menu = await readFile(menuPath, 'utf8');
  const originalPreload = await readFile(preloadPath, 'utf8');
  if (menu.includes(MARKER) || originalPreload.includes(MARKER)) {
    throw new Error('Native downloads are already installed. Restore the original archive first.');
  }
  const changes = [
    {
      anchor: /this\.userSessionController = userSessionController;/g,
      code: '$&\n    this.downloadController = new _TepDownloadController(this);',
    },
    {
      anchor: /const menu = _electron\.Menu\.buildFromTemplate\(template\);/g,
      code: 'template.splice(1, 0, _tepDownloadMenu.default(this));\n    $&',
    },
  ];
  // Fail before writing anything if TIDAL changes these integration points.
  for (const { anchor, code } of changes) {
    if ([...menu.matchAll(anchor)].length !== 1)
      throw new Error(
        `This TIDAL version is incompatible with native downloads: missing or ambiguous ${anchor}.`,
      );
    menu = menu.replace(anchor, code);
  }
  if (!originalPreload.includes('exposeInMainWorld'))
    throw new Error('This TIDAL version has an unsupported preload script.');
  menu = `${MARKER}\n'use strict';\nconst _TepDownloadController = require('../downloads/DownloadController.cjs');\nconst _tepDownloadMenu = require('./downloadMenu');\n${menu}`;
  const downloadPath = join(mainPath, 'downloads');
  await mkdir(downloadPath, { recursive: true });
  for (const [name, code] of Object.entries({
    'DownloadController.cjs': controller,
    'decryption.cjs': decryption,
    'engine.cjs': engine,
    'manifests.cjs': manifests,
    'settings.cjs': settings,
    'session.cjs': session,
    'THIRD_PARTY_NOTICES.txt': notices,
  })) {
    await writeFile(join(downloadPath, name), code as unknown as string);
  }
  await writeFile(join(mainPath, 'menu/downloadMenu.js'), downloadMenu as unknown as string);
  await writeFile(menuPath, menu);
  // A sandboxed preload cannot require local modules; inline the small DOM adapter.
  const renderer = `\n;${MARKER}\n(() => {\nconst module = { exports: {} };\n((module) => {\n${context}\n})(module);\nconst { resolveTarget } = module.exports;\n${preload}\n})();\n`;
  await writeFile(preloadPath, originalPreload + renderer);
}

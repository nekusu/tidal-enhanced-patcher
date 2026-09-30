// Runs in TIDAL's main renderer world so imports reuse the client's initialized
// auth module. Keep this function self-contained: it is serialized for Electron.
async function readClientCredentials(
  apiSubStatus,
  scope = globalThis,
  importModule = (url) => import(url),
) {
  if (scope.location?.origin !== 'https://desktop.tidal.com' || scope.top !== scope)
    throw new Error('Downloads are only available in the TIDAL window.');
  const sources = [
    ...[
      ...scope.document.querySelectorAll(
        'script[type="module"][src], link[rel="modulepreload"][href]',
      ),
    ].map((node) => node.getAttribute('src') || node.getAttribute('href')),
    ...scope.performance.getEntriesByType('resource').map((entry) => entry.name),
  ];
  const urls = new Set();
  for (const source of sources) {
    try {
      const url = new URL(source, scope.location.origin);
      // Only reuse auth/vendor modules already loaded by this TIDAL page.
      if (
        url.origin === scope.location.origin &&
        /^\/assets\/(?:vendor|auth)[\w.-]*\.js$/.test(url.pathname)
      )
        urls.add(url.href);
    } catch {
      // Ignore non-URL performance entries.
    }
  }
  for (const url of urls) {
    let exports;
    try {
      exports = await importModule(url);
    } catch {
      continue;
    }
    // Export names and chunk hashes change with each webclient release. The
    // credential provider's public interface is shared by TIDAL's own API calls.
    const provider = Object.values(exports).find(
      (value) => value && typeof value === 'object' && typeof value.getCredentials === 'function',
    );
    if (!provider) continue;
    let credentials;
    try {
      credentials = await provider.getCredentials(apiSubStatus);
    } catch {
      throw new Error(
        'TIDAL could not refresh its current session. Check the connection and retry.',
      );
    }
    // The provider can also return anonymous client credentials when logged out.
    if (!credentials?.userId || !credentials.token) return null;
    return { accessToken: credentials.token, userId: String(credentials.userId) };
  }
  throw new Error('TIDAL’s active session provider is unavailable. Reload TIDAL and retry.');
}

class ClientSession {
  constructor(delegate) {
    this.delegate = delegate;
  }

  async get(apiSubStatus, signal) {
    const model = this.delegate.userSessionController.getModel();
    if (!model.get('userLoggedIn')) return null;
    // Older clients still supply this field. Current clients keep OAuth tokens
    // in their credential provider instead of the native user-session model.
    const sessionId = model.get('sessionId');
    if (sessionId) return { sessionId, countryCode: model.get('countryCode') };
    const contents = this.delegate.mainWindow?.webContents;
    if (!contents || contents.isDestroyed()) throw new Error('Open TIDAL before downloading.');
    const frame = contents.mainFrame;
    if (new URL(frame.url).origin !== 'https://desktop.tidal.com')
      throw new Error('Downloads are only available in the TIDAL window.');
    const waiting = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30000)]);
    waiting.throwIfAborted();
    let onAbort;
    let credentials;
    try {
      const interrupted = new Promise((_, reject) => {
        onAbort = () => reject(waiting.reason);
        waiting.addEventListener('abort', onAbort, { once: true });
      });
      credentials = await Promise.race([
        contents.executeJavaScript(
          `(${readClientCredentials.toString()})(${JSON.stringify(apiSubStatus ?? null)})`,
        ),
        interrupted,
      ]);
    } finally {
      waiting.removeEventListener('abort', onAbort);
    }
    // Never reuse a token after a logout, account switch, or page navigation.
    if (!model.get('userLoggedIn') || !credentials) return null;
    if (
      contents.isDestroyed() ||
      contents.mainFrame !== frame ||
      new URL(frame.url).origin !== 'https://desktop.tidal.com' ||
      String(model.get('userId')) !== credentials.userId
    )
      throw new Error('TIDAL’s account changed. Retry the download.');
    const countryCode = model.get('countryCode');
    if (!countryCode)
      throw new Error('TIDAL is still loading your account details. Retry shortly.');
    // Credentials stay in memory and are never included in queue state or saved.
    return { accessToken: credentials.accessToken, countryCode };
  }
}

module.exports = { ClientSession, readClientCredentials };

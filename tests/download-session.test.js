import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { parseHTML } from 'linkedom';

// Runtime files are also imported as text by the patcher; use a separate loader.
const source = readFileSync(new URL('../files/downloads/session.cjs', import.meta.url), 'utf8');
const module = { exports: {} };
new Function('module', source)(module);
const { ClientSession, readClientCredentials } = module.exports;

function clientPage() {
  const { document } = parseHTML(`<html><head>
    <script type="module" src="/assets/index-current.js"></script>
    <script type="module" src="/assets/vendor-current.js"></script>
    <script type="module" src="https://unrelated.test/assets/vendor-other.js"></script>
  </head><body></body></html>`);
  const scope = {
    document,
    location: { origin: 'https://desktop.tidal.com' },
    performance: {
      getEntriesByType: () => [{ name: 'https://desktop.tidal.com/assets/vendor-current.js' }],
    },
  };
  scope.top = scope;
  return scope;
}

function nativeSession() {
  const fields = { userLoggedIn: true, userId: 123, countryCode: 'US' };
  const scripts = [];
  const contents = {
    mainFrame: { url: 'https://desktop.tidal.com/playlist/123' },
    isDestroyed: () => false,
    executeJavaScript: (code) => {
      new Script(code);
      scripts.push(code);
      return Promise.resolve({ accessToken: 'active-client-token', userId: '123' });
    },
  };
  const session = new ClientSession({
    mainWindow: { webContents: contents },
    userSessionController: { getModel: () => ({ get: (key) => fields[key] }) },
  });
  return { session, fields, contents, scripts };
}

describe('client credential provider', () => {
  test('reuses the loaded provider and lets it refresh credentials on demand', async () => {
    const scope = clientPage();
    const calls = [];
    const imports = [];
    let token = 'current-token';
    const provider = {
      getCredentials: (subStatus) => {
        calls.push(subStatus);
        return Promise.resolve({ token, userId: '123', refreshToken: 'must-not-be-returned' });
      },
    };
    const load = (url) => {
      imports.push(url);
      return Promise.resolve({ renamedExport: provider });
    };
    expect(await readClientCredentials(undefined, scope, load)).toEqual({
      accessToken: 'current-token',
      userId: '123',
    });
    token = 'refreshed-token';
    expect(await readClientCredentials('11003', scope, load)).toEqual({
      accessToken: 'refreshed-token',
      userId: '123',
    });
    expect(calls).toEqual([undefined, '11003']);
    expect(imports).toEqual([
      'https://desktop.tidal.com/assets/vendor-current.js',
      'https://desktop.tidal.com/assets/vendor-current.js',
    ]);
  });

  test('does not treat anonymous client credentials as a signed-in user', async () => {
    expect(
      await readClientCredentials(undefined, clientPage(), () =>
        Promise.resolve({
          provider: { getCredentials: () => Promise.resolve({ token: 'anonymous' }) },
        }),
      ),
    ).toBeNull();
  });

  test('distinguishes an unavailable provider from a signed-out session', async () => {
    await expect(
      readClientCredentials(undefined, clientPage(), () => Promise.resolve({})),
    ).rejects.toThrow('session provider is unavailable');
    await expect(
      readClientCredentials(undefined, clientPage(), () =>
        Promise.resolve({
          provider: { getCredentials: () => Promise.reject(new Error('sensitive auth failure')) },
        }),
      ),
    ).rejects.toThrow(
      'TIDAL could not refresh its current session. Check the connection and retry.',
    );
  });

  test('refuses to read credentials outside the TIDAL main frame', async () => {
    const scope = clientPage();
    scope.top = {};
    await expect(readClientCredentials(undefined, scope)).rejects.toThrow('TIDAL window');
    scope.top = scope;
    scope.location.origin = 'https://unrelated.test';
    await expect(readClientCredentials(undefined, scope)).rejects.toThrow('TIDAL window');
  });
});

describe('native client session adapter', () => {
  test('uses the current OAuth session even when the native sessionId is missing', async () => {
    const { session, scripts } = nativeSession();
    expect(await session.get()).toEqual({ accessToken: 'active-client-token', countryCode: 'US' });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).not.toContain('active-client-token');
  });

  test('retains support for older clients that supply a native session ID', async () => {
    const { session, fields, scripts } = nativeSession();
    fields.sessionId = 'legacy-session';
    expect(await session.get()).toEqual({ sessionId: 'legacy-session', countryCode: 'US' });
    expect(scripts).toHaveLength(0);
  });

  test('discards credentials if logout or an account change occurs during lookup', async () => {
    const { session, fields, contents } = nativeSession();
    contents.executeJavaScript = () => {
      fields.userLoggedIn = false;
      return Promise.resolve({ accessToken: 'old-account-token', userId: '123' });
    };
    expect(await session.get()).toBeNull();
    fields.userLoggedIn = true;
    contents.executeJavaScript = () => {
      fields.userId = 456;
      return Promise.resolve({ accessToken: 'old-account-token', userId: '123' });
    };
    await expect(session.get()).rejects.toThrow('account changed');
  });

  test('cancels a download waiting for the client’s shared refresh operation', async () => {
    const { session, contents } = nativeSession();
    let completeRefresh;
    contents.executeJavaScript = () =>
      new Promise((resolve) => {
        completeRefresh = resolve;
      });
    const abort = new AbortController();
    const pending = session.get(undefined, abort.signal);
    abort.abort(new Error('Download cancelled'));
    await expect(pending).rejects.toThrow('Download cancelled');
    // The client's own refresh can finish without restarting the cancelled job.
    completeRefresh({ accessToken: 'new-token', userId: '123' });
  });
});

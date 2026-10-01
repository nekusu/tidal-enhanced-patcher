// SPDX-License-Identifier: Apache-2.0
// Attribution and upstream license: THIRD_PARTY_NOTICES.txt
const { createDecipheriv } = require('node:crypto');

// Legacy BTS protocol reference: Yaron Huang's Tidal-Media-Downloader, decryption.py
// https://github.com/yaronzz/Tidal-Media-Downloader/blob/master/TIDALDL-PY/tidal_dl/decryption.py
// This implementation streams through Node's crypto API; no tidal-dl runtime is used.
const LEGACY_WRAPPING_KEY = Buffer.from('UIlTTEMmmLfGowo/UC60x2H45W6MdGgTRfo/umg4754=', 'base64');

function createLegacyDecipher(securityToken) {
  if (
    typeof securityToken !== 'string' ||
    securityToken.length > 4096 ||
    !/^[A-Za-z\d+/]+={0,2}$/.test(securityToken)
  )
    throw new Error('TIDAL returned an invalid legacy audio decryption token.');
  const wrapped = Buffer.from(securityToken, 'base64');
  if (
    wrapped.length < 48 ||
    (wrapped.length - 16) % 16 !== 0 ||
    wrapped.toString('base64').replace(/=+$/, '') !== securityToken.replace(/=+$/, '')
  )
    throw new Error('TIDAL returned an invalid legacy audio decryption token.');

  // The first block is the envelope IV. The decrypted envelope contains a
  // 16-byte audio key followed by an 8-byte nonce; its remaining bytes are unused.
  const unwrap = createDecipheriv('aes-256-cbc', LEGACY_WRAPPING_KEY, wrapped.subarray(0, 16));
  unwrap.setAutoPadding(false);
  const payload = Buffer.concat([unwrap.update(wrapped.subarray(16)), unwrap.final()]);
  try {
    const counter = Buffer.alloc(16);
    payload.copy(counter, 0, 16, 24);
    // Keep a single counter across network chunks, starting at zero after the nonce.
    return createDecipheriv('aes-128-ctr', payload.subarray(0, 16), counter);
  } finally {
    payload.fill(0);
  }
}

module.exports = { createLegacyDecipher };

// ─── Shared QBO Token Store ───────────────────────────────────────────────────
// One set of QBO tokens for the entire server. All dashboard users share the
// same QBO connection — only one person (the QBO admin) needs to authorize.
// This eliminates Intuit's "one admin at a time" reassignment conflict.
//
// Persistence: tokens are written to /tmp/qbo-tokens.json after every
// auth/refresh so they survive process restarts within the same Railway
// deployment. On a fresh deploy (new container) the file is gone and
// whoever visits first will see a "Reconnect QuickBooks" prompt.

const fs   = require('fs');
const axios = require('axios');

const TMP_FILE = '/tmp/qbo-tokens.json';

// ─── In-memory state (module singleton) ──────────────────────────────────────
let _tokens     = null; // { access_token, refresh_token, token_type, expires_in, ... }
let _realmId    = null;
let _expiresAt  = 0;    // epoch ms when access token expires
let _refreshing = null; // Promise lock — prevents duplicate concurrent refreshes

// ─── Persist helpers ──────────────────────────────────────────────────────────
function _save() {
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify({
      tokens: _tokens, realmId: _realmId, expiresAt: _expiresAt,
    }));
  } catch (e) {
    console.warn('[tokenStore] Could not write to /tmp:', e.message);
  }
}

function _load() {
  try {
    const raw = fs.readFileSync(TMP_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.tokens && data.realmId) {
      _tokens    = data.tokens;
      _realmId   = data.realmId;
      _expiresAt = data.expiresAt || 0;
      console.log('[tokenStore] Loaded persisted QBO tokens from /tmp (realmId:', _realmId, ')');
    }
  } catch {
    // File doesn't exist or is corrupt — start unauthenticated
  }
}

// Load from disk on startup
_load();

// ─── Public API ───────────────────────────────────────────────────────────────

function isConnected() {
  return !!(
    _tokens?.refresh_token &&
    _realmId
  );
}

function getRealmId() {
  return _realmId;
}

function set(tokenData, realmId) {
  _tokens    = tokenData;
  _realmId   = realmId;
  _expiresAt = Date.now() + ((tokenData.expires_in || 3600) * 1000);
  _save();
}

function clear() {
  _tokens    = null;
  _realmId   = null;
  _expiresAt = 0;
  try { fs.unlinkSync(TMP_FILE); } catch {}
}

// Returns a valid access token, refreshing if necessary.
// A promise lock (_refreshing) prevents multiple concurrent refreshes.
async function getAccessToken() {
  if (!isConnected()) throw new Error('QuickBooks not connected');

  // Refresh if the access token is expired or expires in < 60 s
  if (Date.now() > _expiresAt - 60_000) {
    if (!_refreshing) {
      _refreshing = _doRefresh().finally(() => { _refreshing = null; });
    }
    await _refreshing;
  }

  return _tokens.access_token;
}

async function _doRefresh() {
  console.log('[tokenStore] Refreshing QBO access token…');
  const env = process.env.QBO_ENVIRONMENT || 'production';
  const tokenUrl = env === 'sandbox'
    ? 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
    : 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

  const creds = Buffer.from(
    `${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`
  ).toString('base64');

  const res = await axios.post(
    tokenUrl,
    new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: _tokens.refresh_token,
    }).toString(),
    {
      headers: {
        Authorization: `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    }
  );

  const newTokens = res.data;
  _tokens    = { ..._tokens, ...newTokens };
  _expiresAt = Date.now() + ((newTokens.expires_in || 3600) * 1000);
  _save();
  console.log('[tokenStore] QBO access token refreshed successfully.');
}

module.exports = { isConnected, getRealmId, set, clear, getAccessToken };

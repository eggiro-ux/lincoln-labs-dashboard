// ─── Shared QBO Token Store ───────────────────────────────────────────────────
// One set of QBO tokens for the entire server. All dashboard users share the
// same QBO connection — only the QBO admin needs to authorize once.
//
// Persistence hierarchy (source of truth → fastest):
//   1. PostgreSQL (DATABASE_URL)  ← survives redeploys; durable source of truth
//   2. /tmp/qbo-tokens.json       ← survives process restarts within same container
//   3. In-memory (_tokens)        ← cache; fastest; lost on any restart
//
// On startup, init() loads from Postgres (if available) or /tmp as fallback.
// On every write (set / refresh / clear), both DB and /tmp are updated.

const fs    = require('fs');
const axios = require('axios');
const db    = require('./db');

const TMP_FILE = '/tmp/qbo-tokens.json';

// ─── In-memory state (module singleton) ──────────────────────────────────────
let _tokens     = null; // { access_token, refresh_token, token_type, ... }
let _realmId    = null;
let _expiresAt  = 0;    // epoch ms when access token expires (0 = unknown/expired)
let _refreshing = null; // Promise lock — prevents duplicate concurrent refreshes

// ─── Private: write to /tmp ───────────────────────────────────────────────────
function _saveTmp() {
  try {
    fs.writeFileSync(TMP_FILE, JSON.stringify({
      tokens: _tokens, realmId: _realmId, expiresAt: _expiresAt,
    }));
  } catch (e) {
    console.warn('[tokenStore] Could not write to /tmp:', e.message);
  }
}

// ─── Private: write to Postgres (fire-and-forget; errors are logged) ──────────
function _saveDb() {
  db.saveTokenRow(_tokens, _realmId).catch(e => {
    console.warn('[tokenStore] Could not save to database:', e.message);
  });
}

// Write to every persistence layer.
function _persist() {
  _saveTmp();
  _saveDb();
}

// ─── Private: load from /tmp (synchronous fallback) ───────────────────────────
function _loadTmp() {
  try {
    const raw  = fs.readFileSync(TMP_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.tokens && data.realmId) {
      _tokens    = data.tokens;
      _realmId   = data.realmId;
      _expiresAt = data.expiresAt || 0;
      console.log('[tokenStore] Loaded QBO tokens from /tmp (realmId:', _realmId, ')');
    }
  } catch {
    // File absent or corrupt — start unauthenticated, that's fine.
  }
}

// ─── Init (async) — MUST be awaited before server starts ─────────────────────
// Tries Postgres first; falls back to /tmp if DB is unavailable or empty.
async function init() {
  console.log('[tokenStore] DATABASE_URL present:', !!process.env.DATABASE_URL);
  try {
    await db.ensureTable();
    const row = await db.loadTokenRow();

    if (row?.refresh_token && row?.realm_id) {
      _tokens = {
        access_token:               row.access_token,
        refresh_token:              row.refresh_token,
        token_type:                 row.token_type,
        expires_in:                 row.expires_in,
        x_refresh_token_expires_in: row.x_refresh_token_expires_in,
      };
      _realmId   = row.realm_id;
      _expiresAt = 0; // Unknown — force a refresh on next getAccessToken() call.
                      // Safer than trusting a stale expiry from a previous deploy.
      console.log('[tokenStore] Loaded QBO tokens from database (realmId:', _realmId, ')');
      return; // DB had data; skip /tmp
    }

    console.log('[tokenStore] No tokens in database — checking /tmp fallback…');
  } catch (e) {
    console.warn('[tokenStore] Database init error, falling back to /tmp:', e.message);
  }

  // Fallback: load from /tmp (works in local dev or if DB is temporarily down).
  _loadTmp();
}

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

// Store new tokens (called from OAuth callback and after token refresh).
function set(tokenData, realmId) {
  _tokens    = tokenData;
  _realmId   = realmId;
  _expiresAt = Date.now() + ((tokenData.expires_in || 3600) * 1000);
  _persist();
}

// Clear all tokens (called from /auth/qbo-logout).
function clear() {
  _tokens    = null;
  _realmId   = null;
  _expiresAt = 0;

  // Remove from /tmp
  try { fs.unlinkSync(TMP_FILE); } catch {}

  // Remove from DB (fire-and-forget)
  db.clearTokenRow().catch(e => {
    console.warn('[tokenStore] Could not clear database tokens:', e.message);
  });
}

// Returns a valid access token, refreshing silently if near-expiry.
// A promise lock prevents duplicate concurrent refreshes.
async function getAccessToken() {
  if (!isConnected()) throw new Error('QuickBooks not connected');

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

  const tokenUrl = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
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
        Authorization:  `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept:         'application/json',
      },
    }
  );

  const newTokens = res.data;
  _tokens    = { ..._tokens, ...newTokens };
  _expiresAt = Date.now() + ((newTokens.expires_in || 3600) * 1000);
  _persist(); // write refreshed tokens to both DB and /tmp
  console.log('[tokenStore] QBO access token refreshed successfully.');
}

module.exports = { init, isConnected, getRealmId, set, clear, getAccessToken };

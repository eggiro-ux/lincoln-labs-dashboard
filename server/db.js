// ─── PostgreSQL persistence layer for QBO tokens ─────────────────────────────
// Used by tokenStore.js as the durable source of truth across deploys.
// When DATABASE_URL is not set (local dev without Postgres), all functions
// return silently and tokenStore falls back to /tmp file persistence.

const { Pool } = require('pg');

let _pool = null;

function getPool() {
  if (_pool) return _pool;
  if (!process.env.DATABASE_URL) return null;

  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Railway Postgres uses self-signed certs; disable strict validation.
    ssl: { rejectUnauthorized: false },
    max: 3,               // small pool — this app has very low DB concurrency
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  _pool.on('error', (err) => {
    console.error('[db] Unexpected pool error:', err.message);
  });

  return _pool;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

async function ensureTable() {
  const pool = getPool();
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tokens (
      id                          TEXT PRIMARY KEY,
      access_token                TEXT,
      refresh_token               TEXT,
      realm_id                    TEXT,
      token_type                  TEXT,
      expires_in                  INTEGER,
      x_refresh_token_expires_in  INTEGER,
      created_at                  TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('[db] tokens table ready.');
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

async function loadTokenRow() {
  const pool = getPool();
  if (!pool) return null;

  const result = await pool.query(
    "SELECT * FROM tokens WHERE id = 'default'"
  );
  return result.rows[0] ?? null;
}

async function saveTokenRow(tokenData, realmId) {
  const pool = getPool();
  if (!pool) return;

  await pool.query(
    `INSERT INTO tokens
       (id, access_token, refresh_token, realm_id, token_type,
        expires_in, x_refresh_token_expires_in, created_at)
     VALUES ('default', $1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (id) DO UPDATE SET
       access_token                = EXCLUDED.access_token,
       refresh_token               = EXCLUDED.refresh_token,
       realm_id                    = EXCLUDED.realm_id,
       token_type                  = EXCLUDED.token_type,
       expires_in                  = EXCLUDED.expires_in,
       x_refresh_token_expires_in  = EXCLUDED.x_refresh_token_expires_in,
       created_at                  = NOW()`,
    [
      tokenData.access_token,
      tokenData.refresh_token,
      realmId,
      tokenData.token_type          ?? null,
      tokenData.expires_in          ?? null,
      tokenData.x_refresh_token_expires_in ?? null,
    ]
  );
}

async function clearTokenRow() {
  const pool = getPool();
  if (!pool) return;

  await pool.query("DELETE FROM tokens WHERE id = 'default'");
}

module.exports = { ensureTable, loadTokenRow, saveTokenRow, clearTokenRow };

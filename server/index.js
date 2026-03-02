require('dotenv').config();
const express = require('express');
const session = require('express-session');
const OAuthClient = require('intuit-oauth');
const path = require('path');
const { getMonthlyData, getCurrentPeriodData } = require('./qbo');

const app = express();
const PORT = process.env.PORT || 3000;

// Required for Railway (and any reverse-proxy): trust X-Forwarded-Proto so
// express-session will set Secure cookies even though the internal connection is HTTP.
app.set('trust proxy', 1);

// ─── Session store (SQLite so sessions survive Railway restarts) ──────────────
const SQLiteStore = require('connect-sqlite3')(session);
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: '/tmp' }),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── OAuth client factory ─────────────────────────────────────────────────────
function makeOAuthClient() {
  return new OAuthClient({
    clientId: process.env.QBO_CLIENT_ID,
    clientSecret: process.env.QBO_CLIENT_SECRET,
    environment: process.env.QBO_ENVIRONMENT || 'production',
    redirectUri: process.env.QBO_REDIRECT_URI,
  });
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.tokens || !req.session.realmId) {
    return res.status(401).json({ error: 'Not authenticated', loginUrl: '/auth/login' });
  }
  next();
}

// ─── Auto-refresh tokens if expired ──────────────────────────────────────────
async function getValidTokens(req) {
  const tokens = req.session.tokens;
  const expiresAt = req.session.tokenExpiresAt || 0;
  if (Date.now() > expiresAt - 60000) {
    // Refresh
    const oauthClient = makeOAuthClient();
    oauthClient.setToken(tokens);
    const authResponse = await oauthClient.refreshUsingToken(tokens.refresh_token);
    const newTokens = authResponse.getJson();
    req.session.tokens = newTokens;
    req.session.tokenExpiresAt = Date.now() + (newTokens.expires_in * 1000);
    return newTokens;
  }
  return tokens;
}

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
  const oauthClient = makeOAuthClient();
  const authUri = oauthClient.authorizeUri({
    scope: [OAuthClient.scopes.Accounting, OAuthClient.scopes.OpenId],
    state: Math.random().toString(36).substring(7),
  });
  res.redirect(authUri);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const oauthClient = makeOAuthClient();
    const authResponse = await oauthClient.createToken(req.url);
    const tokens = authResponse.getJson();
    req.session.tokens = tokens;
    req.session.realmId = req.query.realmId;
    req.session.tokenExpiresAt = Date.now() + (tokens.expires_in * 1000);
    // Explicitly wait for SQLite to commit before redirecting — avoids a race
    // condition where the browser follows the redirect before the session is written.
    req.session.save(err => {
      if (err) console.error('Session save error:', err);
      res.redirect('/');
    });
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/auth/status', (req, res) => {
  res.json({ authenticated: !!(req.session.tokens && req.session.realmId) });
});

// ─── API routes ───────────────────────────────────────────────────────────────

// Historical monthly trend data
app.get('/api/monthly', requireAuth, async (req, res) => {
  try {
    const tokens = await getValidTokens(req);
    const data = await getMonthlyData(tokens, req.session.realmId);
    res.json(data);
  } catch (err) {
    console.error('/api/monthly error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch monthly data', detail: err.message });
  }
});

// Current period vs prior period same-day comparison
app.get('/api/current-period', requireAuth, async (req, res) => {
  try {
    const tokens = await getValidTokens(req);
    const data = await getCurrentPeriodData(tokens, req.session.realmId);
    res.json(data);
  } catch (err) {
    console.error('/api/current-period error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch current period data', detail: err.message });
  }
});

// ─── Catch-all → frontend ─────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => console.log(`Lincoln Labs dashboard running on port ${PORT}`));

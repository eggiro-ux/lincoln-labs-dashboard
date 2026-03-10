// ─── Catch silent crashes before they silently SIGTERM the process ────────────
process.on('uncaughtException', err => {
  console.error('UNCAUGHT EXCEPTION — process will exit:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION — process will exit:', reason);
  process.exit(1);
});

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const OAuthClient = require('intuit-oauth');
const path = require('path');
const { getMonthlyData, getCurrentPeriodData } = require('./qbo');
const { handleAsk } = require('./ask');
const tokenStore = require('./tokenStore');
const marketingRouter = require('./routes/marketing');
const { getPlByLabData } = require('./routes/plByLab');

const app = express();
const PORT = process.env.PORT || 3000;

// Required for Railway (and any reverse-proxy): trust X-Forwarded-Proto so
// express-session will set Secure cookies even though the internal connection is HTTP.
app.set('trust proxy', 1);

// ─── Health check — must be before session middleware so Railway can reach it ─
app.get('/health', (req, res) => res.sendStatus(200));

// ─── Session store ────────────────────────────────────────────────────────────
// Sessions are used only for:
//   1. Dashboard password gate (req.session.dashboardAuthed)
//   2. OAuth CSRF state during QBO connect flow (req.session.oauthState)
// QBO tokens are NOT stored per-session — they live in the shared tokenStore.
app.use(session({
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
// A fresh OAuthClient per call — the library holds mutable token state so
// never share one instance across requests.
function makeOAuthClient() {
  return new OAuthClient({
    clientId:     process.env.QBO_CLIENT_ID,
    clientSecret: process.env.QBO_CLIENT_SECRET,
    environment:  process.env.QBO_ENVIRONMENT || 'production',
    redirectUri:  process.env.QBO_REDIRECT_URI,
  });
}

// ─── Middleware ───────────────────────────────────────────────────────────────

// Dashboard password gate.
// If DASHBOARD_PASSWORD is not set, the dashboard is open (dev / single-user).
// If it is set, the session must have been marked dashboardAuthed.
function requireDashboardAuth(req, res, next) {
  const pwd = process.env.DASHBOARD_PASSWORD;
  if (!pwd || req.session.dashboardAuthed) return next();
  return res.status(401).json({ error: 'Dashboard login required' });
}

// QBO connection gate — used by API routes that need live QBO data.
function requireQBO(req, res, next) {
  if (!tokenStore.isConnected()) {
    return res.status(503).json({ error: 'QuickBooks not connected', reconnectUrl: '/auth/qbo-login' });
  }
  next();
}

// ─── Dashboard auth routes ────────────────────────────────────────────────────

// Returns combined status — frontend uses this on every load.
app.get('/auth/status', (req, res) => {
  const pwd = process.env.DASHBOARD_PASSWORD;
  res.json({
    dashboardAuthed: !pwd || !!req.session.dashboardAuthed,
    qboConnected:    tokenStore.isConnected(),
  });
});

// Password-gate login.
app.post('/auth/dashboard-login', (req, res) => {
  const pwd = process.env.DASHBOARD_PASSWORD;
  if (!pwd) {
    // No password configured — always authed
    req.session.dashboardAuthed = true;
    return res.json({ ok: true });
  }
  if (req.body.password === pwd) {
    req.session.dashboardAuthed = true;
    req.session.save(err => {
      if (err) console.error('Session save error on dashboard login:', err);
      res.json({ ok: true });
    });
  } else {
    res.status(401).json({ error: 'Incorrect password' });
  }
});

// Sign out of the dashboard (does NOT disconnect QBO).
app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ─── QBO OAuth routes — only the QBO admin needs to use these ────────────────

// Initiate QBO OAuth. Stores CSRF state in session so the callback can verify.
app.get('/auth/qbo-login', (req, res) => {
  const state = Math.random().toString(36).substring(2);
  req.session.oauthState = state;
  req.session.save(err => {
    if (err) console.error('Session save error on qbo-login:', err);
    const oauthClient = makeOAuthClient();
    const authUri = oauthClient.authorizeUri({
      scope: [OAuthClient.scopes.Accounting, OAuthClient.scopes.OpenId],
      state,
    });
    res.redirect(authUri);
  });
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { state, realmId } = req.query;
    if (!state || state !== req.session.oauthState) {
      console.error('OAuth state mismatch — rejecting callback');
      return res.redirect('/?error=auth_failed');
    }
    delete req.session.oauthState; // consumed; remove so it can't be replayed

    const oauthClient = makeOAuthClient();
    const authResponse = await oauthClient.createToken(req.url);
    const tokens = authResponse.getJson();

    // Store in the shared singleton — all users will benefit immediately.
    tokenStore.set(tokens, realmId);

    req.session.save(err => {
      if (err) console.error('Session save error on callback:', err);
      res.redirect('/');
    });
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect('/?error=auth_failed');
  }
});

// Disconnect QBO (clears the shared token store).
app.get('/auth/qbo-logout', (req, res) => {
  tokenStore.clear();
  res.redirect('/');
});

// ─── API routes ───────────────────────────────────────────────────────────────

// Historical monthly trend data
app.get('/api/monthly', requireDashboardAuth, requireQBO, async (req, res) => {
  try {
    const accessToken = await tokenStore.getAccessToken();
    const tokens = { access_token: accessToken };
    const am = req.query.accounting_method === 'Cash' ? 'Cash' : 'Accrual';
    const data = await getMonthlyData(tokens, tokenStore.getRealmId(), am);
    res.json(data);
  } catch (err) {
    console.error('/api/monthly error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch monthly data', detail: err.message });
  }
});

// Current period vs prior period same-day comparison
app.get('/api/current-period', requireDashboardAuth, requireQBO, async (req, res) => {
  try {
    const accessToken = await tokenStore.getAccessToken();
    const tokens = { access_token: accessToken };
    const am = req.query.accounting_method === 'Cash' ? 'Cash' : 'Accrual';
    const data = await getCurrentPeriodData(tokens, tokenStore.getRealmId(), am);
    res.json(data);
  } catch (err) {
    console.error('/api/current-period error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch current period data', detail: err.message });
  }
});

// AI-powered natural-language query against QBO data
app.post('/api/ask', requireDashboardAuth, requireQBO, async (req, res) => {
  try {
    const accessToken = await tokenStore.getAccessToken();
    const tokens = { access_token: accessToken };
    const { question, clarifyingAnswers, accountingMethod } = req.body;
    if (!question?.trim()) return res.status(400).json({ error: 'question is required' });
    const am = accountingMethod === 'Cash' ? 'Cash' : 'Accrual';
    const result = await handleAsk(
      tokens,
      tokenStore.getRealmId(),
      question.trim(),
      clarifyingAnswers || null,
      am,
    );
    res.json(result);
  } catch (err) {
    console.error('/api/ask error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use('/api', marketingRouter);

app.get('/api/pl-by-lab', requireDashboardAuth, requireQBO, getPlByLabData);

// ─── Catch-all → frontend ─────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── Startup ──────────────────────────────────────────────────────────────────
// Init tokenStore first so any persisted QBO tokens are loaded before we
// accept requests. If the database is unavailable, it falls back to /tmp.
async function start() {
  try {
    await tokenStore.init();
  } catch (err) {
    console.error('[startup] tokenStore.init() failed (continuing anyway):', err.message);
  }
  app.listen(PORT, () => console.log(`Lincoln Labs dashboard running on port ${PORT}`));
}

start();

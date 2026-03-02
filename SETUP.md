# Lincoln Labs Dashboard — Setup Guide

This guide walks you through deploying the live QuickBooks dashboard from scratch.
Estimated time: **20–30 minutes**.

---

## Step 1 — Register a QuickBooks Developer App (10 min)

1. Go to [developer.intuit.com](https://developer.intuit.com) and sign in with your Intuit/QBO account.
2. Click **"Create an app"** → choose **QuickBooks Online and Payments**.
3. Give it a name (e.g. `Lincoln Labs Dashboard`) — this is internal only.
4. Once created, go to the app's **Keys & credentials** tab.
5. You'll see a **Client ID** and **Client Secret** — copy both, you'll need them in Step 3.
6. Under **Redirect URIs**, add:
   ```
   https://YOUR-RAILWAY-APP.up.railway.app/auth/callback
   ```
   (You'll get the Railway URL in Step 2 — come back and fill this in.)
7. Make sure the app scope includes **Accounting**.
8. Switch the app to **Production** (not Sandbox) so it reads your real QBO data.
   - Under "Production settings", complete the required fields (they're minimal for a private app).

---

## Step 2 — Deploy to Railway (5 min)

1. Go to [railway.app](https://railway.app) and sign in with your GitHub account.
2. Click **"New Project"** → **"Deploy from GitHub repo"**.
3. Select your `lincoln-labs-dashboard` repository.
4. Railway will auto-detect it as a Node.js app and start deploying.
5. Once deployed, go to **Settings → Networking → Generate Domain**.
   - You'll get a URL like `lincoln-labs-dashboard-production.up.railway.app`
   - Copy this URL — go back to Step 1 and add it to your QBO Redirect URI.

---

## Step 3 — Set Environment Variables in Railway (5 min)

In your Railway project, go to **Variables** and add the following:

| Variable | Value |
|---|---|
| `QBO_CLIENT_ID` | From Step 1 (Keys & credentials) |
| `QBO_CLIENT_SECRET` | From Step 1 (Keys & credentials) |
| `QBO_REDIRECT_URI` | `https://your-app.up.railway.app/auth/callback` |
| `QBO_ENVIRONMENT` | `production` |
| `SESSION_SECRET` | Any long random string (e.g. run `openssl rand -hex 32` in Terminal) |

Railway will automatically restart the app after you save variables.

---

## Step 4 — Connect Your QBO Account

1. Open your dashboard URL in a browser.
2. Click **"Connect QuickBooks"**.
3. You'll be redirected to Intuit's login — sign in with your QBO credentials.
4. Authorize the app to access your QuickBooks data.
5. You'll be redirected back to the dashboard, which will immediately start loading your revenue data.

Your session stays active for 7 days. After that, just click "Connect QuickBooks" again.

---

## Step 5 — Share with Your Team

Share the Railway URL with your colleagues. They each click "Connect QuickBooks" and sign in
with their own QBO credentials (they need QBO access — Reports level or higher is sufficient).

Sessions are per-user and stored server-side, so each person authenticates independently.

---

## Updating Account Names

If your QuickBooks chart of accounts ever changes, edit `server/accounts.js` — the account
names in the `accounts` arrays must match QBO exactly (case-sensitive).

Push the change to GitHub and Railway will redeploy automatically.

---

## Costs

- **Railway**: ~$5/month (Hobby plan), covers this app comfortably
- **QuickBooks Developer App**: Free for private/internal use
- **GitHub**: Free

---

## Troubleshooting

**"Error loading data"** — Usually a token issue. Click "Disconnect QBO" then reconnect.

**Data looks wrong** — Check `server/accounts.js`. Account names must match QBO exactly.
Run the QBO P&L report in your browser and compare spelling character-by-character.

**Redirect URI mismatch** — Make sure the URI in Railway's environment variables matches
exactly what you entered in the QBO developer portal (including `https://`).

**Railway app sleeping** — Railway's free tier sleeps after inactivity. Hobby plan ($5/mo)
keeps it always-on. Alternatively, set up a free uptime monitor at [uptimerobot.com](https://uptimerobot.com).

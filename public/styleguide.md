# Lincoln Labs Dashboard — Style Guide

A complete reference for every visual and layout decision in the dashboard. Read this to build any new component that matches the existing design without touching the source code.

---

## 1. Color Palette

### CSS Custom Properties (defined on `:root`)

| Token | Hex | Semantic Role |
|---|---|---|
| `--bg` | `#0f0f0e` | Page background — deepest layer |
| `--surface` | `#191917` | Cards, inputs, buttons, chart background |
| `--border` | `#2a2a27` | All borders, grid lines, dividers |
| `--text` | `#e8e6e0` | Primary text, active labels, values |
| `--muted` | `#7a7870` | Secondary text, captions, inactive states |

### Product Line / Series Accent Colors

| Series | Key | Hex | Usage |
|---|---|---|---|
| Civille + Phantom Copy | `civille` | `#22c55e` | Green — solid line |
| AwesomeAPI | `awesomeapi` | `#eab308` | Amber — solid line |
| Brash Apps | `brash_apps` | `#f97316` | Orange — solid line |
| Total Truss Margin | `truss_total_margin` | `#06b6d4` | Cyan — solid line |
| Truss Client Salaries (delta) | `truss_sal_delta` | `#a855f7` | Purple — solid line |
| Truss Svc Fees + Recruitment | `truss_svc_rec` | `#3b82f6` | Blue — solid line |
| Lincoln Labs Total | `lincoln_labs` | `#e5e5e5` | Near-white — dashed line `[4,4]` |

### Semantic / One-Off Colors (not tokenized)

| Hex | Where used |
|---|---|
| `#4ade80` | Primary action green: spinner top arc, primary button border/text, ask submit border/text, password submit |
| `#4ade8010` | Primary button hover background (4ade80 at ~6% opacity) |
| `#4ade8012` | Ask submit hover background |
| `#f87171` | Error / negative red: error text, password error, ask error, negative delta |
| `#4ade80` | Positive delta indicator (same green as action) |
| `#2a1515` | Error bar background (dark red tint) |
| `#5a2020` | Error bar border |
| `#111110` | Tooltip background (slightly darker than `--surface`) |
| `#1e1e1c` | Table row separator (between `--surface` and `--border`) |
| `#1d1d1b` | Table row hover background |
| `#3a3a37` | Zero-line on chart (slightly lighter than `--border`); crosshair line; hovered grid line |
| `#e8e6e0` with `opacity: 0.9` | Current period legend swatch (= `--text` at near-full opacity) |
| `#e8e6e060` | Prior period legend swatch (`--text` at ~38% opacity) |
| `#eab308` | "Show Current Month" toggle active: border + text color |

---

## 2. Typography

### Font Families

| Family | Weights loaded | Role |
|---|---|---|
| `'DM Mono', monospace` | 400, 500 | **Default body font.** All UI text: labels, captions, buttons, inputs, tabs, numbers in tooltips. |
| `'Fraunces', serif` | 300 (normal + italic), 600 | **Display / numeric values.** Page heading, section headings, stat card values, ask large number. |

Both are loaded from Google Fonts:
```html
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Fraunces:ital,wght@0,300;0,600;1,300&display=swap" rel="stylesheet">
```

### Text Styles

| Style | Font | Size | Weight | Letter-spacing | Other |
|---|---|---|---|---|---|
| **Page heading** `h1` | Fraunces serif | `2.4rem` | 300 | `-0.02em` | `line-height: 1`; italic `em` child uses `color: var(--muted)` |
| **Section heading** `h2` (login prompt, period header) | Fraunces serif | `1.8rem` / `1.4rem` | 300 | — | — |
| **Password gate heading** | Fraunces serif | `2rem` | 300 | — | — |
| **Ask large number** `.ask-number-val` | Fraunces serif | `3.8rem` | 600 | `-0.03em` | `line-height: 1; color: #4ade80` |
| **Stat card value** `.stat-val` | Fraunces serif | `1.35rem` | 600 | `-0.02em` | `line-height: 1` |
| **Body / default** | DM Mono | `0.82rem` | 400 | — | `line-height` unset (inherits) |
| **Button** `.btn` | DM Mono | `0.75rem` | 400 | `0.05em` | — |
| **Tab label** `.tab` | DM Mono | `0.72rem` | 400 | `0.06em` | `text-transform: uppercase` |
| **Legend item** `.legend-item` | DM Mono | `0.7rem` | 400 | `0.04em` | — |
| **Stat label** `.stat-label` | DM Mono | `0.62rem` | 400 | `0.08em` | `text-transform: uppercase` |
| **Stat sub / delta** `.stat-sub` | DM Mono | `0.62rem` | 400 | `0.03em` | `color: var(--muted)` |
| **Auth status / last-updated** | DM Mono | `0.68rem` | 400 | — | `color: var(--muted)` |
| **Method toggle** `.method-btn` | DM Mono | `0.68rem` | 400 | `0.06em` | `text-transform: uppercase` |
| **Subheader subtitle** `header p` | DM Mono | `0.72rem` | 400 | `0.08em` | `text-transform: uppercase; color: var(--muted)` |
| **Period dates** `.period-dates` | DM Mono | `0.7rem` | 400 | `0.04em` | `color: var(--muted)` |
| **Ask input** `.ask-input` | DM Mono | `0.8rem` | 400 | — | `line-height: 1.5` |
| **Ask result prose** `.ask-answer-text` | DM Mono | `0.82rem` | 400 | — | `line-height: 1.75` |
| **Ask table header** `th` | DM Mono | `0.63rem` | 400 | `0.09em` | `text-transform: uppercase` |
| **Ask table cell** `td` | DM Mono | `0.74rem` | 400 | — | — |
| **Ask chip** `.ask-chip` | DM Mono | `0.68rem` | 400 | — | — |
| **Ask examples label** | DM Mono | `0.63rem` | 400 | `0.1em` | `text-transform: uppercase` |
| **Ask clarify button** | DM Mono | `0.74rem` | 400 | — | — |
| **Chart axis labels** (canvas) | DM Mono | `10px` | 400 | — | Rendered with canvas `fillText` |
| **Chart delta labels** (canvas) | DM Mono | `bold 9px` | bold | — | Rendered with canvas `fillText` |
| **Tooltip month** `.tt-month` | DM Mono | `0.7rem` | 400 | `0.08em` | `text-transform: uppercase` |
| **Tooltip row label** `.tt-label` | DM Mono | `0.72rem` | 400 | — | `color: var(--muted)` |
| **Tooltip value** `.tt-val` | DM Mono | `0.75rem` | 400 | — | `white-space: nowrap` |
| **Loading message** | DM Mono | `0.75rem` | 400 | `0.05em` | `color: var(--muted)` |
| **Loading step** | DM Mono | `0.68rem` | 400 | `0.04em` | `color: var(--border)` |

---

## 3. Spacing & Layout

### Page Shell

```css
body {
  padding: 40px 48px;   /* top/bottom: 40px, left/right: 48px */
  min-height: 100vh;
}
```

### Header

```css
header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  margin-bottom: 32px;
  padding-bottom: 24px;
  border-bottom: 1px solid var(--border);
}
.header-left p { margin-top: 6px; }
.auth-area { gap: 8px; }   /* between button row and last-updated */
```

### Accounting Method Toggle (above tabs)

```css
/* Wrapper */
display: flex; justify-content: flex-end; margin-bottom: 16px;
```

### Tab Bar

```css
.tabs { margin-bottom: 24px; border-bottom: 1px solid var(--border); }
.tab  { padding: 10px 24px; margin-bottom: -1px; }
/* Active underline uses border-bottom: 2px solid var(--text) */
```

### Chart Wrapper

```css
.chart-wrapper {
  padding: 28px 28px 16px;   /* top/sides: 28px, bottom: 16px */
  background: var(--surface);
  border: 1px solid var(--border);
}
```

Canvas chart margins (JS constants, in pixels):
```js
const MARGIN = { top: 24, right: 32, bottom: 52, left: 72 };
```

### Stats Row (KPI cards below trend chart)

```css
.stats-row {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 1px;           /* creates hairline border effect via background: var(--border) */
  margin-top: 1px;
  background: var(--border);
}
.stat-card {
  padding: 18px 20px;
  background: var(--surface);
}
```

### Legend

```css
.legend { gap: 24px; margin-bottom: 16px; flex-wrap: wrap; }
.legend-item { gap: 8px; }
.legend-dot { width: 10px; height: 10px; border-radius: 50%; }
```

### Current Period Legend

```css
.period-legend { gap: 24px; margin-bottom: 16px; }
.period-legend-item { gap: 8px; }
.period-legend-swatch { width: 24px; height: 10px; border-radius: 2px; }
.period-header { margin-bottom: 20px; }
```

### Tooltip

```css
#tooltip {
  padding: 12px 16px;
  min-width: 240px;
}
.tt-month { margin-bottom: 10px; padding-bottom: 8px; }
.tt-row { gap: 16px; padding: 3px 0; }
.tt-dot { width: 7px; height: 7px; border-radius: 50%; }
```

### Ask Tab

```css
.ask-input-wrap { gap: 12px; margin-bottom: 18px; }
.ask-input      { padding: 14px 16px; }
.ask-submit     { padding: 0 24px; }
.ask-examples   { gap: 8px; margin-bottom: 32px; }
.ask-chip       { padding: 6px 13px; }
.ask-loading    { gap: 14px; padding: 32px 0; }
.ask-result-meta { padding-bottom: 14px; margin-bottom: 18px; }
.ask-answer-text { margin-bottom: 20px; }
.ask-number-lbl  { margin-top: 10px; }
.ask-table th, .ask-table td { padding: 9px 14px; }
.ask-clarify-opts { gap: 8px; max-width: 560px; }
.ask-clarify-btn  { padding: 11px 16px; }
```

### Password Gate

```css
#passwordGate { gap: 24px; }
.pw-form  { gap: 0; width: 320px; }
.pw-input { padding: 12px 16px; }          /* border-right: none (flush with submit) */
.pw-submit { padding: 12px 20px; }
```

### Border Radii

The design uses **zero border-radius everywhere** (sharp rectangular corners) except:
- Legend dots / stat dots / tooltip dots: `border-radius: 50%` (perfect circles)
- Period legend swatch: `border-radius: 2px` (very slight)
- Spinner: `border-radius: 50%`

---

## 4. Component Patterns

### 4.1 Tab Navigation

```html
<div class="tabs">
  <div class="tab active" data-tab="trend">Monthly Trend</div>
  <div class="tab" data-tab="current">Current Period</div>
  <div class="tab" data-tab="ask">Ask</div>
</div>
```

```css
.tabs {
  display: flex;
  gap: 0;
  margin-bottom: 24px;
  border-bottom: 1px solid var(--border);
}
.tab {
  padding: 10px 24px;
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  color: var(--muted);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;           /* overlaps the tabs container border */
  transition: color 0.15s, border-color 0.15s;
}
.tab.active {
  color: var(--text);
  border-bottom-color: var(--text);  /* white underline on active */
}
```

### 4.2 Accounting Method Segmented Toggle

```html
<div style="display:flex;justify-content:flex-end;margin-bottom:16px;">
  <div class="method-toggle">
    <button class="method-btn active" data-method="Accrual">Accrual</button>
    <button class="method-btn" data-method="Cash">Cash</button>
  </div>
</div>
```

```css
.method-toggle { display: flex; gap: 0; }
.method-btn {
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--muted);
  font-family: 'DM Mono', monospace;
  font-size: 0.68rem;
  padding: 6px 14px;
  cursor: pointer;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  transition: color 0.15s, border-color 0.15s;
}
.method-btn:first-child { border-right: none; }   /* flush join */
.method-btn.active {
  color: var(--text);
  border-color: var(--muted);
}
```

### 4.3 KPI Stat Card

```html
<div class="stat-card" data-key="civille">
  <div class="stat-label">
    <div class="stat-dot" style="background:#22c55e"></div>
    <span style="color:var(--muted)">Civille + Phantom Copy</span>
  </div>
  <div class="stat-val" style="color:#22c55e">$142,500.00</div>
  <div class="stat-sub">
    <span style="color:#4ade80">↑ 12.3% vs prior month</span>
  </div>
</div>
```

```css
/* The grid wrapper produces 1px "gap" borders via background: var(--border) */
.stats-row {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 1px;
  margin-top: 1px;
  background: var(--border);
}
.stat-card {
  background: var(--surface);
  padding: 18px 20px;
}
.stat-label {
  font-size: 0.62rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.stat-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.stat-val {
  font-family: 'Fraunces', serif;
  font-weight: 600;
  font-size: 1.35rem;
  letter-spacing: -0.02em;
  line-height: 1;
  /* color = series accent color, set inline */
}
.stat-sub {
  font-size: 0.62rem;
  color: var(--muted);
  margin-top: 4px;
  letter-spacing: 0.03em;
}
/* Delta colors applied inline on the inner <span>: */
/* Positive: color: #4ade80 */
/* Negative: color: #f87171 */
```

### 4.4 Chart Container

```html
<div class="chart-wrapper">
  <canvas id="trendChart"></canvas>
</div>
```

```css
.chart-wrapper {
  position: relative;
  background: var(--surface);
  border: 1px solid var(--border);
  padding: 28px 28px 16px;
}
canvas { display: block; width: 100%; }
```

Canvas sizing (JS):
```js
const W = wrapper.clientWidth - 56;   /* 56 = some outer padding budget */
const H = Math.max(380, Math.round(W * 0.38));   /* ~16:6 aspect ratio */
trendCanvas.width  = W * devicePixelRatio;
trendCanvas.height = H * devicePixelRatio;
trendCtx.scale(devicePixelRatio, devicePixelRatio);
```

### 4.5 Buttons

**Standard button:**
```html
<button class="btn">Disconnect QuickBooks</button>
<a href="/auth/qbo-login" class="btn">Sign Out</a>
```
```css
.btn {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
  font-family: 'DM Mono', monospace;
  font-size: 0.75rem;
  padding: 10px 18px;
  cursor: pointer;
  letter-spacing: 0.05em;
  text-decoration: none;
  transition: border-color 0.2s;
}
.btn:hover { border-color: var(--muted); }
```

**Primary / action button (green):**
```html
<a href="/auth/qbo-login" class="btn primary">
  Connect QuickBooks
</a>
```
```css
.btn.primary {
  border-color: #4ade80;
  color: #4ade80;
}
.btn.primary:hover { background: #4ade8010; }
```

**Inline toggle button** (e.g. "Show Current Month" — smaller variant):
```html
<button class="btn" style="font-size:0.68rem;padding:7px 14px;white-space:nowrap;">
  Show Current Month
</button>
```
Active state (applied via JS when month is shown):
```js
btn.style.borderColor = '#eab308';
btn.style.color       = '#eab308';
```

**Ask submit button:**
```css
.ask-submit {
  align-self: stretch;
  padding: 0 24px;
  background: var(--surface);
  border: 1px solid #4ade80;
  color: #4ade80;
  font-family: 'DM Mono', monospace;
  font-size: 0.75rem;
  letter-spacing: 0.06em;
  cursor: pointer;
  transition: background 0.15s;
  white-space: nowrap;
}
.ask-submit:hover    { background: #4ade8012; }
.ask-submit:disabled { opacity: 0.4; cursor: not-allowed; }
```

### 4.6 Error Bar

```html
<div id="errorState">
  <div class="error-body">
    <span class="error-msg">Failed to load data: some error</span>
    <div class="error-actions">
      <a href="#">Reconnect QuickBooks</a>
      <a href="#">Retry</a>
    </div>
  </div>
</div>
```
```css
#errorState {
  padding: 20px 24px;
  background: #2a1515;
  border: 1px solid #5a2020;
  font-size: 0.75rem;
  color: #f87171;
  margin-bottom: 24px;
}
.error-body  { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.error-msg   { line-height: 1.6; }
.error-actions { display: flex; gap: 8px; flex-shrink: 0; }
.error-actions a {
  font-size: 0.72rem;
  padding: 7px 14px;
  border: 1px solid #5a2020;
  color: #f87171;
  text-decoration: none;
  transition: border-color 0.2s;
  white-space: nowrap;
}
.error-actions a:hover { border-color: #f87171; }
```

### 4.7 Loading State

```html
<div id="loadingState">
  <div class="spinner"></div>
  <p id="loadingMsg">Checking authentication…</p>
  <span id="loadingStep">Fetching monthly history</span>
</div>
```
```css
#loadingState {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px;
  gap: 16px;
}
.spinner {
  width: 32px;
  height: 32px;
  border: 2px solid var(--border);
  border-top-color: #4ade80;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
#loadingState p    { font-size: 0.75rem; color: var(--muted); letter-spacing: 0.05em; }
#loadingState span { font-size: 0.68rem; color: var(--border); letter-spacing: 0.04em; }
```

### 4.8 Tooltip

```html
<div id="tooltip">
  <div class="tt-month">Mar 2026</div>
  <div id="ttRows">
    <div class="tt-row">
      <span class="tt-label">
        <span class="tt-dot" style="background:#22c55e"></span>
        Civille + Phantom Copy
      </span>
      <span class="tt-val">$142,500.00</span>
    </div>
  </div>
</div>
```
```css
#tooltip {
  position: fixed;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.12s;
  z-index: 100;
  background: #111110;
  border: 1px solid var(--border);
  padding: 12px 16px;
  min-width: 240px;
}
#tooltip.visible { opacity: 1; }

.tt-month {
  font-size: 0.7rem;
  color: var(--muted);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.tt-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  font-size: 0.72rem;
  padding: 3px 0;
}
.tt-label { display: flex; align-items: center; gap: 6px; color: var(--muted); }
.tt-dot   { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.tt-val   { font-size: 0.75rem; color: var(--text); white-space: nowrap; }
```

Tooltip is positioned by JS: appears to the right of cursor (`mx + 16`), flips left if it would overflow the viewport (`mx - ttW - 16` where `ttW = 280`).

### 4.9 Legend (Trend Chart)

```html
<div class="legend" id="legend">
  <div class="legend-item">
    <div class="legend-dot" style="background:#22c55e"></div>
    Civille + Phantom Copy
  </div>
  <div class="legend-item hidden">   <!-- hidden series -->
    <div class="legend-dot" style="background:#a855f7"></div>
    Truss Client Salaries (Income − Exp)
  </div>
</div>
```
```css
.legend      { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 16px; }
.legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.7rem;
  letter-spacing: 0.04em;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.15s;
  user-select: none;
}
.legend-item:hover  { color: var(--text); }
.legend-item.hidden { opacity: 0.3; }
.legend-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
```

### 4.10 Ask Tab — Query Input

```html
<div class="ask-input-wrap">
  <textarea class="ask-input" rows="2" placeholder="Ask anything…"></textarea>
  <button class="ask-submit">Ask →</button>
</div>
<div class="ask-examples">
  <span class="ask-examples-lbl">Try:</span>
  <button class="ask-chip">What was our total revenue last month?</button>
</div>
```
Key CSS already listed in §3 Ask Tab spacing above. See §4.5 for ask-submit button styles.

### 4.11 Password Gate Overlay

```html
<div id="passwordGate">
  <h2>Lincoln Labs <em>Revenue</em></h2>
  <p>Enter the dashboard password to continue.</p>
  <form class="pw-form">
    <input class="pw-input" type="password" placeholder="Password">
    <button type="submit" class="pw-submit">Enter →</button>
  </form>
  <span id="pwError"></span>
</div>
```
```css
#passwordGate {
  position: fixed;
  inset: 0;
  background: var(--bg);
  z-index: 999;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 24px;
}
.pw-form  { display: flex; gap: 0; width: 320px; }
.pw-input {
  flex: 1;
  background: var(--surface);
  border: 1px solid var(--border);
  border-right: none;      /* flush join with submit */
  color: var(--text);
  font-family: 'DM Mono', monospace;
  font-size: 0.82rem;
  padding: 12px 16px;
  outline: none;
}
.pw-input:focus { border-color: var(--muted); }
.pw-submit {
  background: var(--surface);
  border: 1px solid #4ade80;
  color: #4ade80;
  font-family: 'DM Mono', monospace;
  font-size: 0.75rem;
  padding: 12px 20px;
  cursor: pointer;
  letter-spacing: 0.05em;
  white-space: nowrap;
}
.pw-submit:hover { background: #4ade8010; }
#pwError { font-size: 0.72rem; color: #f87171; min-height: 1.2em; }
```

---

## 5. Chart Styling

All charts are drawn on `<canvas>` using the Canvas 2D API — no third-party chart library.

### Series Colors & Line Style (Trend Chart)

| Series | Color | `lineDash` | Line width |
|---|---|---|---|
| Civille + Phantom Copy | `#22c55e` | `[]` (solid) | 2px |
| AwesomeAPI | `#eab308` | `[]` | 2px |
| Brash Apps | `#f97316` | `[]` | 2px |
| Total Truss Margin | `#06b6d4` | `[]` | 2px |
| Truss Client Salaries (delta) | `#a855f7` | `[]` | 2px |
| Truss Svc Fees + Recruitment | `#3b82f6` | `[]` | 2px |
| Lincoln Labs Total | `#e5e5e5` | `[4, 4]` (dashed) | 2px |

### Data Points (Dots)

| State | Radius | Fill | Stroke |
|---|---|---|---|
| Default | 3.5px | `#191917` (surface — hollow effect) | Series color, 2px |
| Hovered | 5.5px | Series color (filled) | Series color, 2px |

### Grid Lines

| Element | Color | Line width | Dash |
|---|---|---|---|
| Regular horizontal gridlines | `#2a2a27` (border) | 1px | solid |
| Zero-line | `#3a3a37` | 1.5px | solid |
| Crosshair (hover vertical) | `#3a3a37` | 1px | `[3, 3]` |

### Axis Labels

- **Y-axis:** DM Mono 10px, `color: #7a7870 (--muted)`, right-aligned, offset `-8px` from plot left edge. Values formatted as `$Xk` / `$X.Xm`.
- **X-axis:** DM Mono 10px, `color: #7a7870`, center-aligned below plot. Month labels split to two lines (`Mon\nYYYY`), spaced `15px` apart vertically. Labels are step-sampled: every `ceil(n/18)` months, always including last.

### Y-Axis Scale

- Min: 0 (or floored negative if any series goes negative)
- Max: `ceil(dataMax * 1.08 / 10000) * 10000`
- Steps: "nice" rounding using `[1, 2, 2.5, 5, 10] × magnitude` — at most 8 ticks

### Comparison Chart (Current Period)

- Grouped bars — 2 bars per series (current solid, prior ghost)
- **Current bar:** `globalAlpha = 0.9`, filled with series color
- **Prior bar:** `globalAlpha = 0.25` fill + `globalAlpha = 1` dashed outline (`[3, 2]`), offset `barW + 2` px to the right
- Delta label: `bold 9px` DM Mono, green (`#4ade80`) if positive, red (`#f87171`) if negative, centered between the two bars
- X-axis group label: `#7a7870`, `0.68rem`, centered below bars

---

## 6. Design Principles

### Dark-First, Near-Black (not pure black)
Background is `#0f0f0e` — a slightly warm near-black. Surface is `#191917`. This warm undertone (`0e`/`17` endings) prevents the "cold blue-black" look of pure `#000` or `#111111`.

### Monospace Everywhere (except display numerics)
All UI text uses **DM Mono**. This creates visual rhythm and a technical/data-forward aesthetic. The only exception is large display numbers and headings (Fraunces), which provide contrast through a serif typeface at lighter weight.

### Two-Font Contrast Rule
- **Fraunces** (serif, light or bold): headings, KPI values, the brand wordmark. Signals "this is a number or a name that matters."
- **DM Mono** (monospace): everything else. Signals "this is data, metadata, or a control."

### All Borders Are the Same Weight and Color
Every divider, card outline, input border, and button border uses `1px solid var(--border)` (`#2a2a27`). Interactive hover states upgrade the border to `var(--muted)` (`#7a7870`) — never to a bright accent. This keeps the layout from feeling cluttered.

### No Border Radius on Boxes
All rectangles — cards, buttons, inputs, chart containers, tooltips — have sharp corners (no `border-radius`). This creates a precise, technical feel. The only circles are decorative dot indicators.

### Single Action Color: Green
`#4ade80` is the **only** color used for primary affordances (CTAs, spinner, active toggles). It's bright enough to draw attention on the dark surface, and consistent enough that users learn "green = action."

### Accent Colors Are Reserved for Data Series
The six series colors (`#22c55e`, `#eab308`, `#f97316`, `#06b6d4`, `#a855f7`, `#3b82f6`) never appear in UI chrome. They appear only in chart lines, dots, stat card values, and legend swatches. This makes the data pop and prevents color confusion.

### Opacity for Inactive States
Rather than a separate "disabled" color, inactive items use `opacity: 0.3` (legend hidden items) or switch to `color: var(--muted)`. This preserves the color identity while signaling inactivity.

### Transitions Are Short and Consistent
- Color/border transitions: `0.15s` (tabs, legend, method toggle)
- Border-color on buttons: `0.2s`
- Tooltip fade: `opacity 0.12s`
No `ease-in-out` keywords needed — the defaults are sufficient.

### Uppercase Tracking for Labels
Small labels (tabs, stat labels, method toggle, axis headers) use `text-transform: uppercase` with positive `letter-spacing` (0.04–0.1em). This compensates for the reduced readability of small caps and creates clear visual hierarchy between labels and values.

### Tight Negative Letter-Spacing on Numerics
Large numbers (headings at `2.4rem`, stat values at `1.35rem`, ask number at `3.8rem`) use `letter-spacing: -0.02em` to `-0.03em`. This prevents the optical looseness that Fraunces develops at display sizes.

### 1px Gap Grid for Cards
The stats row uses `background: var(--border)` on the grid container with `gap: 1px`. This creates hairline "borders" between cards without actual borders — ensuring the gaps are always exactly 1px regardless of zoom level.

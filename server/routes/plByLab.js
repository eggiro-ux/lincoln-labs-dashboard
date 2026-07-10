'use strict';
// GET /api/pl-by-lab?accounting_method=Accrual
//
// Fetches the TOTAL (unfiltered) P&L for completed months + current MTD,
// then parses the QBO tree into a comprehensive response:
//   - summary: company-level totals
//   - buRows: per-BU revenue/cogs/gp for the overview table
//   - fullPLRows: flattened rows for the full-company P&L table
//   - labs: per-lab P&L rows and KPIs
//   - unassigned: items with no lab attribution

const axios      = require('axios');
const tokenStore = require('../tokenStore');

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const QBO_BASE = {
  production: 'https://quickbooks.api.intuit.com',
  sandbox:    'https://sandbox-quickbooks.api.intuit.com',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getReportMonths(startDateStr, endDateStr) {
  const today = new Date();

  // Default: Jan 1 of current year → last day of last completed month
  if (!startDateStr || !endDateStr) {
    const year      = today.getFullYear();
    const thisMonth = today.getMonth() + 1; // 1-indexed

    // Default start: Jan 1 of current year
    startDateStr = `${year}-01-01`;

    // Default end: last day of last completed month
    // If we are in January, fall back to last day of January current year (MTD)
    if (thisMonth > 1) {
      const lastCompletedMonth = thisMonth - 1;
      const lastDay = new Date(year, lastCompletedMonth, 0).getDate();
      endDateStr = `${year}-${String(lastCompletedMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    } else {
      // January: show Jan MTD
      const todayDay = today.getDate();
      endDateStr = `${year}-01-${String(todayDay).padStart(2, '0')}`;
    }
  }

  // Parse start and end dates
  const [sy, sm, sd] = startDateStr.split('-').map(Number);
  const [ey, em, ed] = endDateStr.split('-').map(Number);

  const todayYear  = today.getFullYear();
  const todayMonth = today.getMonth() + 1;
  const todayDay   = today.getDate();

  const months = [];

  // Iterate month by month from start to end
  let curYear = sy, curMonth = sm;
  while (curYear < ey || (curYear === ey && curMonth <= em)) {
    const lastDayOfMonth = new Date(curYear, curMonth, 0).getDate();

    const isCurrentMonth = (curYear === todayYear && curMonth === todayMonth);
    const isLastMonth    = (curYear === ey && curMonth === em);

    let monthEnd;
    let partial = false;

    if (isCurrentMonth) {
      // Cap at today
      const cappedDay = Math.min(todayDay, lastDayOfMonth);
      // Also cap at the requested end date if it's this month
      if (isLastMonth) {
        const requestedDay = Math.min(ed, todayDay);
        monthEnd = `${curYear}-${String(curMonth).padStart(2, '0')}-${String(requestedDay).padStart(2, '0')}`;
      } else {
        monthEnd = `${curYear}-${String(curMonth).padStart(2, '0')}-${String(cappedDay).padStart(2, '0')}`;
      }
      partial = true;
    } else if (isLastMonth) {
      // Last month in range: use the requested end day
      const usedDay = Math.min(ed, lastDayOfMonth);
      monthEnd = `${curYear}-${String(curMonth).padStart(2, '0')}-${String(usedDay).padStart(2, '0')}`;
      // Partial if end day is not month-end
      partial = (usedDay < lastDayOfMonth);
    } else {
      monthEnd = `${curYear}-${String(curMonth).padStart(2, '0')}-${String(lastDayOfMonth).padStart(2, '0')}`;
    }

    // Determine start day for first month
    const monthStart = (curYear === sy && curMonth === sm)
      ? `${curYear}-${String(curMonth).padStart(2, '0')}-${String(sd).padStart(2, '0')}`
      : `${curYear}-${String(curMonth).padStart(2, '0')}-01`;

    months.push({
      label:   `${MONTH_ABBR[curMonth - 1]} ${curYear}`,
      start:   monthStart,
      end:     monthEnd,
      partial,
    });

    // Advance
    curMonth++;
    if (curMonth > 12) { curMonth = 1; curYear++; }
  }

  return months;
}

async function fetchTotalPL(accessToken, realmId, startDate, endDate, accountingMethod) {
  const env    = process.env.QBO_ENVIRONMENT || 'production';
  const base   = QBO_BASE[env];
  const params = new URLSearchParams({
    start_date:          startDate,
    end_date:            endDate,
    accounting_method:   accountingMethod,
    summarize_column_by: 'Month',
  });
  const url = `${base}/v3/company/${realmId}/reports/ProfitAndLoss?${params}`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  return res.data;
}

// ── Forex Currency Fee item split ─────────────────────────────────────────────
// "Forex Currency Fee" is a product/service ITEM that posts into the
// "Truss Service Fees" income ACCOUNT, so the account-level P&L lumps it in.
// The Truss lab-specific view breaks it out as its own income line by pulling
// item-level sales from the ItemSales report (one call per month) and
// subtracting from the service-fees row. Consolidated views stay account-level.
const FOREX_ITEM_NAME = 'forex currency fee';

// QBO's ItemSales response nests the per-metric sub-columns (Quantity, Amount,
// % of Sales, Avg Price, COGS, …) inside a parent "Total" column, while each
// row's ColData holds all the values flat. Flatten the column tree so indexes
// line up with ColData. (Live response verified 2026-07-07: 2 top-level
// columns wrapping 7 sub-columns vs 8 flat ColData entries per row.)
function flattenColumns(colList, out = []) {
  for (const c of (colList || [])) {
    if (c.Columns?.Column) flattenColumns(c.Columns.Column, out);
    else out.push(c);
  }
  return out;
}

// Find the item's amount in one ItemSales report. The item usually appears as a
// Data row, but QBO renders it as a Section (Header + Summary) if it ever has
// sub-items, so both shapes are handled.
function extractForexAmount(report) {
  const cols = flattenColumns(report.Columns?.Column);
  const colKey = c => ((c.MetaData || []).find(m => m.Name === 'ColKey') || {}).Value || '';
  // ColKey metadata is QBO's unambiguous column id; titles are the fallback
  let amtIdx = cols.findIndex(c => colKey(c) === 'Amount');
  if (amtIdx === -1) amtIdx = cols.findIndex(c => (c.ColTitle || '').trim().toLowerCase() === 'amount');
  if (amtIdx === -1) amtIdx = cols.findIndex(c => (c.ColTitle || '').trim().toLowerCase().includes('amount'));
  if (amtIdx === -1) return 0;

  let amount = 0;
  (function walk(node) {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const name = (node.type === 'Section'
      ? node.Header?.ColData?.[0]?.value
      : node.ColData?.[0]?.value) || '';
    if (name.trim().toLowerCase() === FOREX_ITEM_NAME) {
      const colData = node.type === 'Section'
        ? (node.Summary?.ColData || node.Header?.ColData || [])
        : (node.ColData || []);
      // QBO sometimes omits the leading item-name column from Columns metadata
      // while ColData still starts with the name — every index then shifts by
      // one (the same quirk parsePL's colDataOffset handles). Align per row:
      // reading the wrong column here once showed Qty (7.28) as the dollar
      // amount instead of $25,424.
      const offset = Math.max(0, colData.length - cols.length);
      const v = parseFloat(colData[amtIdx + offset]?.value || '0');
      if (!isNaN(v)) amount += v;
      return; // Section summary already includes children — don't recurse
    }
    if (node.Rows?.Row) walk(node.Rows.Row);
    if (node.Row)       walk(node.Row);
  })(report.Rows?.Row);

  return amount;
}

// One ItemSales call per report month (the month-summarized variant interleaves
// Qty/Amount/% sub-columns per month, which is much harder to parse reliably).
// Returns { 'YYYY-MM': amount }.
async function fetchForexFeeByMonth(accessToken, realmId, months, accountingMethod) {
  const env  = process.env.QBO_ENVIRONMENT || 'production';
  const base = QBO_BASE[env];

  const results = await Promise.all(months.map(async (m) => {
    const params = new URLSearchParams({
      start_date:        m.start,
      end_date:          m.end,
      accounting_method: accountingMethod,
    });
    const url = `${base}/v3/company/${realmId}/reports/ItemSales?${params}`;
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    return { key: m.start.substring(0, 7), amount: extractForexAmount(res.data) };
  }));

  const byMonth = {};
  results.forEach(r => { byMonth[r.key] = r.amount; });
  return byMonth;
}

// Split the Forex amounts out of the Truss Service Fees row in the Truss
// lab-specific rows. Zero-sum: Total Income, KPIs, buRows, and the
// consolidated fullPLRows are unaffected.
function breakOutForexRow(trussLab, monthRanges, forexByMonth) {
  const rows = trussLab?.rows;
  if (!rows) return;

  const forexVals = monthRanges.map(r => forexByMonth[r.start.substring(0, 7)] || 0);
  if (!forexVals.some(v => v !== 0)) return;

  const idx = rows.findIndex(r =>
    r.type === 'row' && (r.label || '').toLowerCase().includes('truss service fees'));
  if (idx === -1) return;

  const svcRow = rows[idx];
  // svcRow.values is shared with fullPLRows — replace, never mutate in place
  rows[idx] = { ...svcRow, values: svcRow.values.map((v, i) => v - forexVals[i]) };
  // No accountId: this line is item-level, so the account drill doesn't apply
  rows.splice(idx + 1, 0, { label: 'Forex Currency Fee', values: forexVals, type: 'row' });
}

// ── Lab matching ──────────────────────────────────────────────────────────────
// Phantom Copy is a sub-account of Civille — rolls up into Civille.
function matchLab(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/awesome/.test(t))    return 'AwesomeAPI';
  if (/caboodle/.test(t))   return 'Caboodle';  // acquired company, expenses-only lab for now
  if (/phantom/.test(t))    return 'Civille';   // Phantom Copy is a Civille sub-account
  if (/civille/.test(t))    return 'Civille';
  // Specific rent overrides — must come before the broad /lincoln/ catch
  if (/lincoln.*\brent\b|\brent\b.*lincoln/.test(t)) return 'Civille'; // LL-labelled rent sub-account → Civille (word boundary avoids matching "rental")
  if (/\bkansas\b/.test(t)) return 'Lincoln Labs'; // Office Rent - Kansas → Lincoln Labs
  if (/back.?owed/.test(t)) return 'Lincoln Labs'; // Back-Owed Rent → Lincoln Labs
  // Truss income override — subletting income is the overseas-office sub-let, belongs with Truss
  if (/subletting/.test(t)) return 'Truss';
  if (/lincoln/.test(t))    return 'Lincoln Labs';
  if (/overseas/.test(t))   return 'Truss';     // Overseas Rent & Utilities → Truss
  if (/accomplice/.test(t)) return 'Truss';     // Accomplice is a Truss product line
  if (/\btruss\b/.test(t))  return 'Truss';
  if (/\bapps?\b/.test(t))  return 'Apps';
  return null;
}

// ── Transaction-level reallocations ───────────────────────────────────────────
// Some QBO accounts contain postings that belong to a different lab than the
// account's name implies (e.g. Google Workspace charges for Civille domains
// booked to the Lincoln Labs software sub-account). matchLab works at the
// account level and can't split those, so these memo rules move individual
// transactions between labs. Zero-sum: the source lab's row is reduced by
// exactly what the target lab gains, so the company-wide P&L never changes.
// The drill honors the split via the `realloc` query param (see getPlDrillData).
//
// Rule shape: { id, accountId, memoMatch?, nameMatch?, memoExclude?, targets: [{ lab, share, label }] }
// - A rule claims a transaction when memoMatch hits the memo OR nameMatch hits
//   the vendor name (seat charges are often memo'd with a staff name, so the
//   vendor column is the only reliable signal).
// - Rules are tried IN ORDER and the first match claims the transaction, so a
//   memo matching several rules is only ever moved once (e.g. the "Brash Apps
//   proxy + Fathom license" charge matches apps_brash before civ_fathom).
// - targets shares may sum to < 1 to leave a remainder with the source lab.
const TXN_REALLOCATIONS = [
  {
    id:        'civ_workspace',
    accountId: '227',                    // Software → "Lincoln Labs" sub-account
    memoMatch: /civil|getci|ripon/i,     // Google Workspace_civil/_getci/_ripon — all Civille client domains
    targets:   [{ lab: 'Civille', share: 1, label: 'Google Workspace — Civille, GetCivil & Ripon (from Lincoln Labs)' }],
  },
  {
    id:        'apps_brash',
    accountId: '227',
    memoMatch: /brash/i,                 // Brash Apps proxy server (incl. bundled Fathom license)
    targets:   [{ lab: 'Apps', share: 1, label: 'Brash Apps — proxy server & Fathom (from Lincoln Labs)' }],
  },
  {
    id:        'apps_proxy',
    accountId: '227',
    memoMatch: /^apps\s*-\s*proxy/i,     // "Apps - proxy server (x2)"
    targets:   [{ lab: 'Apps', share: 1, label: 'Proxy server (from Lincoln Labs)' }],
  },
  {
    id:        'civ_fathom',
    accountId: '227',
    memoMatch: /fathom/i,                // Fathom licenses belong to Civille…
    memoExclude: /eric\s+giroux/i,       // …unless the seat is Eric's (stays Lincoln Labs)
    targets:   [{ lab: 'Civille', share: 1, label: 'Fathom (from Lincoln Labs)' }],
  },
  {
    id:        'aws_split',
    accountId: '227',
    memoMatch: /amazon web services|\baws\b/i,
    targets: [                           // per Eric 2026-07-10: 70 / 20 / 10
      { lab: 'Civille',    share: 0.70, label: 'AWS — 70% Civille share (from Lincoln Labs)' },
      { lab: 'AwesomeAPI', share: 0.20, label: 'AWS — 20% AwesomeAPI share (from Lincoln Labs)' },
      { lab: 'Truss',      share: 0.10, label: 'AWS — 10% Truss share (from Lincoln Labs)' },
    ],
  },
  {
    // The bookkeeper posts manual "Anthropic expenses are split 70% LL, 30%
    // Truss" journal entries: a credit here in 227 and a debit in 229
    // (Software — Truss). Eric wants the dashboard split to ignore that
    // bookkeeping entirely, so route the credits to Truss where they exactly
    // cancel the debits — the JE nets to zero on every lab P&L, past and
    // future, and the seat charges below split on their gross amounts.
    id:        'anthropic_je',
    accountId: '227',
    memoMatch: /anthropic expenses are split/i,
    targets:   [{ lab: 'Truss', share: 1, label: 'Anthropic 70/30 journal entries (from Lincoln Labs)' }],
  },
  {
    // Seat charges are memo'd with staff names (Danil Shingarev, Julia
    // Collins), so match on the vendor name column.
    id:        'anthropic_split',
    accountId: '227',
    nameMatch: /anthropic/i,
    targets: [                           // per Eric 2026-07-10: even 3-way split of gross
      { lab: 'Civille',    share: 1 / 3, label: 'Anthropic — 1/3 Civille share (from Lincoln Labs)' },
      { lab: 'AwesomeAPI', share: 1 / 3, label: 'Anthropic — 1/3 AwesomeAPI share (from Lincoln Labs)' },
      { lab: 'Truss',      share: 1 / 3, label: 'Anthropic — 1/3 Truss share (from Lincoln Labs)' },
    ],
  },
  {
    id:        'civ_openai',
    accountId: '227',
    nameMatch: /openai/i,                // memos are usually blank
    memoMatch: /openai|chatgpt/i,
    targets:   [{ lab: 'Civille', share: 1, label: 'OpenAI (from Lincoln Labs)' }],
  },
  {
    id:        'civ_figma',
    accountId: '227',
    nameMatch: /figma/i,
    memoMatch: /figma/i,
    targets:   [{ lab: 'Civille', share: 1, label: 'Figma (from Lincoln Labs)' }],
  },
  {
    id:        'civ_zoom',
    accountId: '227',
    nameMatch: /zoom/i,
    memoMatch: /\bzoom\b/i,
    targets:   [{ lab: 'Civille', share: 1, label: 'Zoom (from Lincoln Labs)' }],
  },
  {
    id:        'civ_kadence',
    accountId: '227',
    nameMatch: /kadence/i,
    memoMatch: /kadence/i,               // "Paypal *kadence …"
    targets:   [{ lab: 'Civille', share: 1, label: 'Kadence (from Lincoln Labs)' }],
  },
  {
    id:        'ramp_split',
    accountId: '227',
    nameMatch: /\bramp\b/i,
    memoMatch: /\bramp\b/i,
    targets: [                           // per Eric 2026-07-10: 40 Truss / 40 Civille / 20 stays LL
      { lab: 'Truss',   share: 0.40, label: 'Ramp — 40% Truss share (from Lincoln Labs)' },
      { lab: 'Civille', share: 0.40, label: 'Ramp — 40% Civille share (from Lincoln Labs)' },
    ],
  },
  {
    id:        'truss_loom',
    accountId: '227',
    nameMatch: /loom/i,                  // covers "Farrukh Umarov"-memo'd seats too
    memoMatch: /\bloom\b/i,
    targets:   [{ lab: 'Truss', share: 1, label: 'Loom (from Lincoln Labs)' }],
  },
  {
    id:        'stackblitz_split',
    accountId: '227',
    nameMatch: /stackblitz/i,            // memos are just "Eric Giroux"
    targets: [                           // per Eric 2026-07-10: even 3-way split
      { lab: 'Civille',    share: 1 / 3, label: 'Stackblitz — 1/3 Civille share (from Lincoln Labs)' },
      { lab: 'Truss',      share: 1 / 3, label: 'Stackblitz — 1/3 Truss share (from Lincoln Labs)' },
      { lab: 'AwesomeAPI', share: 1 / 3, label: 'Stackblitz — 1/3 AwesomeAPI share (from Lincoln Labs)' },
    ],
  },
  {
    id:        'atlassian_split',
    accountId: '227',
    memoMatch: /atlassian/i,
    nameMatch: /atlassian/i,
    targets: [                           // per Eric 2026-07-10: 20 / 25 / 50 / 5, none stays LL
      { lab: 'Civille',    share: 0.20, label: 'Atlassian — 20% Civille share (from Lincoln Labs)' },
      { lab: 'Truss',      share: 0.25, label: 'Atlassian — 25% Truss share (from Lincoln Labs)' },
      { lab: 'AwesomeAPI', share: 0.50, label: 'Atlassian — 50% AwesomeAPI share (from Lincoln Labs)' },
      { lab: 'Apps',       share: 0.05, label: 'Atlassian — 5% Apps share (from Lincoln Labs)' },
    ],
  },
  {
    // "Anything Black Teak or Eric Hoopman related" splits 4 ways — this covers
    // the PayPlug charge in the LL software account; the Exec Transportation
    // instances are handled by the same-pattern rule on account 1150040026.
    // LL's 25% stays as the natural remainder since this account is already LL.
    id:        'hoopman_software',
    accountId: '227',
    memoMatch: /hoopman|black teak/i,
    nameMatch: /black teak/i,
    targets: [
      { lab: 'Truss',      share: 0.25, label: 'Eric Hoopman / Black Teak — 25% Truss share (from Lincoln Labs)' },
      { lab: 'AwesomeAPI', share: 0.25, label: 'Eric Hoopman / Black Teak — 25% AwesomeAPI share (from Lincoln Labs)' },
      { lab: 'Civille',    share: 0.25, label: 'Eric Hoopman / Black Teak — 25% Civille share (from Lincoln Labs)' },
    ],
  },

  // ── Gifts & Employee Morale (unassigned account 73) ─────────────────────────
  {
    id:        'gifts_uzbekistan',
    accountId: '73',
    memoMatch: /uzbekistan/i,            // Truss overseas-office events
    targets:   [{ lab: 'Truss', share: 1, label: 'Uzbekistan team events (from Gifts & Morale)' }],
  },
  {
    id:        'gifts_teleflora',
    accountId: '73',
    nameMatch: /teleflora/i,
    memoMatch: /teleflora/i,
    targets: [                           // per Eric 2026-07-10: 50/50 Civille & LL
      { lab: 'Civille',      share: 0.5, label: 'Teleflora — 50% Civille share (from Gifts & Morale)' },
      { lab: 'Lincoln Labs', share: 0.5, label: 'Teleflora — 50% share (from Gifts & Morale)' },
    ],
  },
  {
    id:        'gifts_julia',
    accountId: '73',
    memoMatch: /julia/i,                 // "anything with Julia goes to Truss"
    targets:   [{ lab: 'Truss', share: 1, label: 'Julia Collins items (from Gifts & Morale)' }],
  },

  // ── Executive Transportation (unassigned account 1150040026) ────────────────
  {
    id:        'exec_531',
    accountId: '1150040026',
    nameMatch: /531 north main/i,
    memoMatch: /funds transfer/i,
    targets: [                           // per Eric 2026-07-10: even 4-way
      { lab: 'Truss',        share: 0.25, label: '531 North Main transfers — 25% Truss share (from Exec Transportation)' },
      { lab: 'Lincoln Labs', share: 0.25, label: '531 North Main transfers — 25% share (from Exec Transportation)' },
      { lab: 'AwesomeAPI',   share: 0.25, label: '531 North Main transfers — 25% AwesomeAPI share (from Exec Transportation)' },
      { lab: 'Civille',      share: 0.25, label: '531 North Main transfers — 25% Civille share (from Exec Transportation)' },
    ],
  },
  {
    id:        'exec_kadir',
    accountId: '1150040026',
    memoMatch: /kadir/i,                 // Kadir Fuzaylov is Truss staff
    targets:   [{ lab: 'Truss', share: 1, label: 'Kadir Fuzaylov travel (from Exec Transportation)' }],
  },
  {
    id:        'exec_hoopman',
    accountId: '1150040026',
    memoMatch: /hoopman|black teak/i,
    nameMatch: /black teak/i,
    targets: [                           // per Eric 2026-07-10: even 4-way
      { lab: 'Truss',        share: 0.25, label: 'Eric Hoopman / Black Teak — 25% Truss share (from Exec Transportation)' },
      { lab: 'Lincoln Labs', share: 0.25, label: 'Eric Hoopman / Black Teak — 25% share (from Exec Transportation)' },
      { lab: 'AwesomeAPI',   share: 0.25, label: 'Eric Hoopman / Black Teak — 25% AwesomeAPI share (from Exec Transportation)' },
      { lab: 'Civille',      share: 0.25, label: 'Eric Hoopman / Black Teak — 25% Civille share (from Exec Transportation)' },
    ],
  },

  // ── Advertising & Marketing travel (unassigned account 1150040059) ──────────
  {
    id:        'advmkt_julia',
    accountId: '1150040059',
    memoMatch: /julia/i,
    targets:   [{ lab: 'Truss', share: 1, label: 'Julia Collins items (from Adv & Marketing)' }],
  },
];

// ── Whole-account splits ──────────────────────────────────────────────────────
// Accounts whose ENTIRE balance divides across labs by fixed shares (no memo
// matching needed, so no extra QBO fetch — the split applies directly to the
// account's P&L month vector, which also covers accounts whose PLDetail drill
// returns no line items). Shares per Eric 2026-07-10.
const EVEN_4WAY = [
  { lab: 'Civille',      share: 0.25 },
  { lab: 'Truss',        share: 0.25 },
  { lab: 'AwesomeAPI',   share: 0.25 },
  { lab: 'Lincoln Labs', share: 0.25 },
];
const CIV_TRUSS_5050 = [
  { lab: 'Civille', share: 0.5 },
  { lab: 'Truss',   share: 0.5 },
];
// LL payroll (accounts 86/90/147/135) splits by month, derived from Gusto
// per-employee gross pay (verified to the cent against the QBO wage JEs,
// 2026-07-10). People in the LL payroll bucket and their lab weights per Eric:
// Eric Giroux 35/35/20/3/7 Civ/Truss/Awesome/Apps/LL, Danil Shingarev
// 25/25/20/0/30, Laura Van Brocklin (left Mar) and Ella Roux 100% Civille.
// Sidecar accounts (taxes/health/dental) follow the wage proportions.
// FALLBACK covers months with no entry (Jul 2026+): current roster (Eric +
// Danil) at June comp levels. Regenerate when the LL payroll roster changes.
const LL_PAYROLL_MONTHLY = {
  '2026-01': [{ lab: 'Civille', share: 0.389187 }, { lab: 'Truss', share: 0.273078 }, { lab: 'AwesomeAPI', share: 0.176778 }, { lab: 'Apps', share: 0.015631 }, { lab: 'Lincoln Labs', share: 0.145326 }],
  '2026-02': [{ lab: 'Civille', share: 0.395847 }, { lab: 'Truss', share: 0.268293 }, { lab: 'AwesomeAPI', share: 0.174489 }, { lab: 'Apps', share: 0.015055 }, { lab: 'Lincoln Labs', share: 0.146316 }],
  '2026-03': [{ lab: 'Civille', share: 0.343138 }, { lab: 'Truss', share: 0.300213 }, { lab: 'AwesomeAPI', share: 0.191415 }, { lab: 'Apps', share: 0.018283 }, { lab: 'Lincoln Labs', share: 0.146951 }],
  '2026-04': [{ lab: 'Civille', share: 0.320470 }, { lab: 'Truss', share: 0.320470 }, { lab: 'AwesomeAPI', share: 0.200000 }, { lab: 'Apps', share: 0.021141 }, { lab: 'Lincoln Labs', share: 0.137919 }],
  '2026-05': [{ lab: 'Civille', share: 0.312349 }, { lab: 'Truss', share: 0.312349 }, { lab: 'AwesomeAPI', share: 0.200000 }, { lab: 'Apps', share: 0.018705 }, { lab: 'Lincoln Labs', share: 0.156597 }],
  '2026-06': [{ lab: 'Civille', share: 0.310736 }, { lab: 'Truss', share: 0.310736 }, { lab: 'AwesomeAPI', share: 0.200000 }, { lab: 'Apps', share: 0.018221 }, { lab: 'Lincoln Labs', share: 0.160307 }],
};
const LL_PAYROLL_FALLBACK = [{ lab: 'Civille', share: 0.310736 }, { lab: 'Truss', share: 0.310736 }, { lab: 'AwesomeAPI', share: 0.200000 }, { lab: 'Apps', share: 0.018221 }, { lab: 'Lincoln Labs', share: 0.160307 }];

const ACCOUNT_SPLITS = {
  '6':   { name: 'Bank Charges & Fees',      targets: CIV_TRUSS_5050 },
  '9':   { name: 'Interest Paid',            targets: CIV_TRUSS_5050 },
  '11':  { name: 'Meals & Entertainment',    targets: CIV_TRUSS_5050 },
  '13':  { name: 'Office Supplies',          targets: [{ lab: 'Civille', share: 1 }] },
  '8':   { name: 'Insurance',                targets: EVEN_4WAY },
  '10':  { name: 'Legal & Professional',     targets: EVEN_4WAY },
  '65':  { name: 'QuickBooks Subscriptions', targets: EVEN_4WAY },
  '86':  { name: 'Payroll Wages',            targets: LL_PAYROLL_FALLBACK, monthlyTargets: LL_PAYROLL_MONTHLY },
  '90':  { name: 'Payroll Taxes',            targets: LL_PAYROLL_FALLBACK, monthlyTargets: LL_PAYROLL_MONTHLY },
  '147': { name: 'Health Insurance',         targets: LL_PAYROLL_FALLBACK, monthlyTargets: LL_PAYROLL_MONTHLY },
  '135': { name: 'Dental & Vision',          targets: LL_PAYROLL_FALLBACK, monthlyTargets: LL_PAYROLL_MONTHLY },
};

// Union of labs a split can route to (monthly lists may differ from fallback).
function acctSplitLabs(split) {
  const labs = new Set((split.targets || []).map(t => t.lab));
  Object.values(split.monthlyTargets || {}).forEach(list => list.forEach(t => labs.add(t.lab)));
  return [...labs];
}

// Share for a lab in a given YYYY-MM month (monthly entry wins over fallback).
function acctShareFor(split, monthKey, lab) {
  const list = (split.monthlyTargets && split.monthlyTargets[monthKey]) || split.targets || [];
  const t = list.find(x => x.lab === lab);
  return t ? t.share : 0;
}

function acctSplitLabel(split, lab) {
  if (split.monthlyTargets) return `${split.name} — ${lab} share (Gusto-derived)`;
  const share = acctShareFor(split, '', lab);
  return share === 1
    ? `${split.name} (shared account)`
    : `${split.name} — ${+(share * 100).toFixed(1)}% ${lab} share`;
}

// First matching rule for this account + memo/vendor-name, or null. Single
// source of truth for claim semantics — used by both the P&L aggregation and
// the drill filter.
function claimingRule(accountId, memo, name) {
  const m = memo || '';
  const n = name || '';
  return TXN_REALLOCATIONS.find(r =>
    String(r.accountId) === String(accountId) &&
    ((r.memoMatch && r.memoMatch.test(m)) || (r.nameMatch && r.nameMatch.test(n))) &&
    !(r.memoExclude && r.memoExclude.test(m))
  ) || null;
}

// Fetch per-transaction detail for every account that has reallocation rules
// and bucket claimed amounts by month. Each transaction is claimed by at most
// one rule (claimingRule) and distributed across that rule's targets by share.
// Returns { accountId: [{ rule, target, values }] } with only non-zero entries,
// or null when there is nothing to move.
async function fetchTxnReallocations(accessToken, realmId, months, am) {
  const accountIds = [...new Set(TXN_REALLOCATIONS.map(r => String(r.accountId)))];
  if (!accountIds.length) return null;
  const startDate = months[0].start;
  const endDate   = months[months.length - 1].end;

  const byAccount = {};
  await Promise.all(accountIds.map(async (accId) => {
    const report  = await fetchPLDetail(accessToken, realmId, accId, startDate, endDate, am);
    const txns    = parseTransactionReport(report, accId);
    const entries = new Map(); // `${rule.id}::${lab}` → { rule, target, values }
    for (const t of txns) {
      const rule = claimingRule(accId, t.memo, t.name);
      if (!rule) continue;
      const mi = months.findIndex(m => t.date >= m.start && t.date <= m.end);
      if (mi < 0) continue;
      for (const target of rule.targets) {
        const key = `${rule.id}::${target.lab}`;
        let e = entries.get(key);
        if (!e) { e = { rule, target, values: months.map(() => 0) }; entries.set(key, e); }
        e.values[mi] += t.amount * target.share;
      }
    }
    const list = [...entries.values()].filter(e => e.values.some(v => v !== 0));
    if (list.length) byAccount[accId] = list;
  }));
  return Object.keys(byAccount).length ? byAccount : null;
}

// ── Compound label construction ───────────────────────────────────────────────
function buildLabel(parentSectionName, rowLabel) {
  const p = (parentSectionName || '').trim();
  const r = (rowLabel || '').trim();
  if (!p) return r;

  const pl = p.toLowerCase();

  // Generic top-level containers — child label is self-describing in context
  if (pl === 'income' || pl === 'revenue' || pl === 'sales') return r;
  if (pl.includes('cost of goods') || pl === 'cogs')         return `COGS — ${r}`;

  // Specific category mappings
  if (pl === 'offshore labor')                            return `Offshore Labor — ${r}`;
  if (pl === 'onshore')                                   return `Onshore — ${r}`;
  if (pl.includes('wages') || pl.includes('salaries'))    return `Payroll — Wages: ${r}`;
  if (pl.includes('taxes') && pl.includes('payroll'))     return `Payroll — Taxes: ${r}`;
  if (pl.includes('health insurance'))                    return `Payroll — Health Insurance: ${r}`;
  if (pl.includes('dental') || pl.includes('vision'))     return `Payroll — Dental/Vision: ${r}`;
  if (pl.includes('advertising') || pl.includes('marketing')) return `Advertising & Marketing — ${r}`;
  if (pl.includes('meals') || pl.includes('entertainment')) return `Meals & Entertainment — ${r}`;
  if (pl.includes('travel') || pl.includes('transportation')) return `Travel & Transportation — ${r}`;
  if (pl.includes('internal meetings'))                   return `Internal Meetings — ${r}`;
  if (pl.includes('legal') || pl.includes('professional')) return `Legal & Professional — ${r}`;
  if (pl.includes('merchant') || pl.includes('processing fee')) return `Merchant Fees — ${r}`;
  if (pl === 'software' || pl.includes('subscriptions') || pl.includes('dues')) return `Software & Subscriptions — ${r}`;
  if (pl.includes('rent') || pl.includes('lease'))        return `Rent — ${r}`;
  if (pl.includes('referral'))                            return `Referral Commissions — ${r}`;
  if (pl.includes('taxes') || pl.includes('licenses'))    return `Taxes & Licenses — ${r}`;
  if (pl.includes('payroll'))                             return `Payroll — ${r}`;
  if (pl === 'lincoln labs')                              return `Lincoln Labs — ${r}`;
  if (pl.includes('insurance'))                           return `Insurance — ${r}`;
  if (pl.includes('utilities') || pl.includes('telephone') || pl.includes('internet')) return `Utilities — ${r}`;
  return `${p} — ${r}`;
}

// Subtotal label overrides
function subtotalLabel(sectionName) {
  const s = (sectionName || '').toLowerCase();
  if (s === 'civille')          return 'Total Civille Group';
  if (s === 'lincoln labs')     return 'Total Lincoln Labs';
  if (s === 'truss')            return 'Total Truss';
  if (s === 'offshore labor')   return 'Total Offshore Labor';
  if (s === 'onshore')          return 'Total Onshore';
  if (s === 'other income')     return 'Total Other Income';
  if (s.includes('income'))     return 'Total Income';
  if (s.includes('cost of goods') || s === 'cogs') return 'Total COGS';
  if (s.includes('expense'))    return 'Total Expenses';
  return `Total ${sectionName}`;
}

// ── Group display name normalizer ────────────────────────────────────────────
// Maps raw QBO section names to user-friendly group labels
function groupDisplayName(raw) {
  const MAP = {
    'Software':                      'Software & Subscriptions',
    'Dues & subscriptions':          'Dues & Subscriptions',
    'Merchant fees':                 'Merchant Fees',
    'Meals & Entertainment':         'Meals & Entertainment',
  };
  return MAP[raw] || raw;
}

function slugify(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// ── Core parser ───────────────────────────────────────────────────────────────
// reallocByAccount: optional output of fetchTxnReallocations — per-account
// month vectors to move between labs at the expense-routing step.
function parsePL(pl, reallocByAccount) {
  const cols = pl.Columns?.Column || [];

  // ColData offset: QBO sometimes includes an Account column first
  const hasAccountCol = cols.some(c => c.ColType === 'Account');
  const colDataOffset = hasAccountCol ? 0 : 1;

  // Month columns only (same YYYY-MM start and end = single month)
  const monthCols = cols
    .map((c, i) => {
      const meta = {};
      (c.MetaData || []).forEach(m => { meta[m.Name] = m.Value; });
      return { idx: i, type: c.ColType, startDate: meta.StartDate, endDate: meta.EndDate };
    })
    .filter(c =>
      c.type === 'Money' &&
      c.startDate && c.endDate &&
      c.startDate.substring(0, 7) === c.endDate.substring(0, 7)
    );

  const N = monthCols.length;
  const zero = () => Array(N).fill(0);
  // YYYY-MM key per month column — used for month-varying account splits
  const monthKeys = monthCols.map(c => (c.startDate || '').substring(0, 7));

  const getVals = (colData) =>
    monthCols.map(col => parseFloat(colData[col.idx + colDataOffset]?.value || '0'));

  // ── Accumulator structures ─────────────────────────────────────────────────

  // fullPLRows: array of { label, values, type }
  const fullPLRows = [];

  // Per-lab row accumulators
  const LAB_NAMES = ['Civille', 'Truss', 'AwesomeAPI', 'Apps', 'Lincoln Labs', 'Caboodle'];
  const labIncome   = {};
  const labCOGS     = {};
  const labExpenses = {};
  LAB_NAMES.forEach(l => {
    labIncome[l]   = [];
    labCOGS[l]     = [];
    labExpenses[l] = [];
  });

  const unassignedIncome   = [];
  const unassignedExpenses = [];

  // BU revenue tracking (for overview table)
  // We track totals per-BU from income section
  const buRevByMonth = {}; // buName -> number[N]
  LAB_NAMES.forEach(l => { buRevByMonth[l] = zero(); });

  // Summary accumulators
  const sumIncome   = zero();
  const sumCOGS     = zero();
  const sumExpenses = zero();

  // Exchange gain/loss
  let exchangeVals = null;

  // ── Tree walker ────────────────────────────────────────────────────────────

  // Walk a section's rows and emit flat items into the target arrays.
  // parentSectionName: the display name of the immediate parent section (for label construction)
  // topSectionType: 'income' | 'cogs' | 'expenses'
  // Route a data row (label + values) into the correct lab bucket.
  function routeDataRow(topSectionType, displayLabel, parentSectionName, rowLabel, vals, groupName, accountId) {
    const lab = matchLab(displayLabel) || matchLab(parentSectionName) || matchLab(rowLabel);
    if (topSectionType === 'income') {
      // Unmatched income defaults to Lincoln Labs (catch-all for misc. company income)
      const incLab = lab || 'Lincoln Labs';
      labIncome[incLab] = labIncome[incLab] || [];
      labIncome[incLab].push({ label: displayLabel, values: vals, accountId });
      if (buRevByMonth[incLab]) {
        for (let i = 0; i < N; i++) buRevByMonth[incLab][i] += vals[i];
      }
      for (let i = 0; i < N; i++) sumIncome[i] += vals[i];
    } else if (topSectionType === 'cogs') {
      if (lab) {
        labCOGS[lab] = labCOGS[lab] || [];
        labCOGS[lab].push({ label: displayLabel, values: vals, accountId });
      } else {
        unassignedExpenses.push({ label: displayLabel, values: vals, accountId });
      }
      for (let i = 0; i < N; i++) sumCOGS[i] += vals[i];
    } else {
      // expenses — do NOT accumulate sumExpenses here (top-level totals used)
      // Store group metadata so buildLabRows can emit collapsible sections

      // Transaction-level reallocations: subtract moved amounts from this row
      // and emit a companion row in each target lab. `realloc` tells the drill
      // which side of the split to show ('exclude' = source, rule id = target).
      // Whole-account splits (ACCOUNT_SPLITS) ride the same pipeline, with the
      // split computed directly from the account's month vector.
      const acctSplit  = accountId && ACCOUNT_SPLITS[String(accountId)];
      const acctMoves  = acctSplit ? acctSplitLabs(acctSplit).map(lab => ({
        rule:   { id: `acct_${accountId}` },
        target: { lab, label: acctSplitLabel(acctSplit, lab) },
        values: vals.map((v, i) => v * acctShareFor(acctSplit, monthKeys[i], lab)),
      })) : [];
      const txnMoves = (accountId && reallocByAccount && reallocByAccount[String(accountId)]) || [];
      const moves    = acctMoves.concat(txnMoves);
      const expVals = moves.length
        ? vals.map((v, i) => moves.reduce((acc, m) => acc - m.values[i], v))
        : vals;
      const realloc = moves.length ? 'exclude' : undefined;

      if (lab) {
        labExpenses[lab] = labExpenses[lab] || [];
        labExpenses[lab].push({ label: displayLabel, values: expVals, group: groupName, subLabel: parentSectionName, accountId, realloc });
      } else {
        unassignedExpenses.push({ label: displayLabel, values: expVals, group: groupName, subLabel: parentSectionName, accountId, realloc });
      }
      for (const m of moves) {
        labExpenses[m.target.lab] = labExpenses[m.target.lab] || [];
        labExpenses[m.target.lab].push({
          label: m.target.label, values: m.values,
          group: groupName, subLabel: null,
          accountId, realloc: `${m.rule.id}::${m.target.lab}`,
        });
      }
    }
  }

  // groupName: for expenses, the name of the top-level expense category (depth=0 under Expenses).
  // This is threaded down the recursion so every leaf row knows which group it belongs to,
  // enabling collapsible grouped sections in the lab-specific P&L views.
  function walkSection(rows, topSectionType, parentSectionName, depth, groupName) {
    for (const row of (rows || [])) {
      if (row.type === 'Section') {
        const header  = row.Header?.ColData?.[0]?.value || '';
        const summary = row.Summary?.ColData?.[0]?.value || '';
        const sName   = header || summary;

        // For expense sections, the first level (direct children of "Expenses") defines the group.
        // Compute this before handling the header so own-postings rows get the right group too.
        const currentGroup = (topSectionType === 'expenses' && !groupName) ? sName : groupName;

        // QBO puts a parent account's own postings in Section Header.ColData when
        // it has sub-accounts. Detect this and emit as a data row; otherwise emit
        // as a label-only section header.
        if (header) {
          const headerVals = row.Header.ColData.length > 1 ? getVals(row.Header.ColData) : null;
          if (headerVals && headerVals.some(v => v !== 0)) {
            // Parent account has its own postings — build a descriptive label using
            // the parent section for context (same logic as Data rows)
            const headerAccountId = row.Header.ColData[0]?.id || null;
            const displayLabel = buildLabel(parentSectionName, header);
            fullPLRows.push({ label: displayLabel, values: headerVals, type: 'row', accountId: headerAccountId });
            routeDataRow(topSectionType, displayLabel, parentSectionName, header, headerVals, currentGroup, headerAccountId);
          } else {
            fullPLRows.push({ label: header, type: 'section_header' });
          }
        }

        // Recurse into children, passing the resolved group name down
        if (row.Rows?.Row) {
          walkSection(row.Rows.Row, topSectionType, sName, depth + 1, currentGroup);
        }

        // Emit section summary (subtotal) row
        if (row.Summary?.ColData) {
          const vals   = getVals(row.Summary.ColData);
          const subLbl = subtotalLabel(sName);
          let rowType  = 'subtotal';
          const sl = sName.toLowerCase();
          if (sl.includes('income') && depth === 0)          rowType = 'total_income';
          if (sl.includes('cost of goods') || sl === 'cogs') rowType = 'total_cogs';
          if (sl.includes('expense') && depth === 0)         rowType = 'total_expenses';
          if (sl === 'gross profit')                          rowType = 'gross_profit';
          fullPLRows.push({ label: subLbl, values: vals, type: rowType });
        }
      }

      if (row.type === 'Data' && row.ColData) {
        const rowLabel     = row.ColData[0]?.value || '';
        const accountId    = row.ColData[0]?.id    || null;   // ADD THIS
        const vals         = getVals(row.ColData);
        const displayLabel = buildLabel(parentSectionName, rowLabel);

        fullPLRows.push({ label: displayLabel, values: vals, type: 'row', accountId });

        if (vals.some(v => v !== 0)) {
          routeDataRow(topSectionType, displayLabel, parentSectionName, rowLabel, vals, groupName, accountId);
        }
      }
    }
  }

  // ── Top-level pass ──────────────────────────────────────────────────────────
  for (const topRow of (pl.Rows?.Row || [])) {
    if (topRow.type !== 'Section') continue;
    const h = (topRow.Header?.ColData?.[0]?.value || '').toLowerCase();
    const s = (topRow.Summary?.ColData?.[0]?.value || '').toLowerCase();

    // Gross profit and net income rows are computed — skip
    if (h === 'gross profit' || s === 'gross profit') {
      if (topRow.Summary?.ColData) {
        const vals = getVals(topRow.Summary.ColData);
        fullPLRows.push({ label: 'Gross Profit', values: vals, type: 'gross_profit' });
      }
      continue;
    }
    if (h.startsWith('net income') || s.startsWith('net income')) {
      if (topRow.Summary?.ColData) {
        const vals = getVals(topRow.Summary.ColData);
        fullPLRows.push({ label: 'Net Income', values: vals, type: 'net_income' });
      }
      continue;
    }
    if (h.startsWith('net operating') || s.startsWith('net operating')) {
      if (topRow.Summary?.ColData) {
        const vals = getVals(topRow.Summary.ColData);
        fullPLRows.push({ label: 'Net Operating Income', values: vals, type: 'net_op' });
      }
      continue;
    }

    const isIncome  = h.includes('income') || h.includes('revenue') || h.includes('sales');
    const isCOGS    = h.includes('cost of goods') || h.includes('cogs');
    const sType     = isIncome ? 'income' : isCOGS ? 'cogs' : 'expenses';

    const topHeader = topRow.Header?.ColData?.[0]?.value || '';
    if (topHeader) {
      fullPLRows.push({ label: topHeader, type: 'section_header' });
    }

    if (topRow.Rows?.Row) {
      walkSection(topRow.Rows.Row, sType, topHeader, 0);
    }

    // Top-level summary
    if (topRow.Summary?.ColData) {
      const vals   = getVals(topRow.Summary.ColData);
      const subLbl = subtotalLabel(topHeader);
      let rowType  = 'subtotal';
      if (isIncome) rowType = 'total_income';
      if (isCOGS)   rowType = 'total_cogs';
      if (!isIncome && !isCOGS) rowType = 'total_expenses';
      fullPLRows.push({ label: subLbl, values: vals, type: rowType });

      // Accumulate summary totals
      if (isIncome) {
        const sv = getVals(topRow.Summary.ColData);
        for (let i = 0; i < N; i++) sumIncome[i] = sv[i]; // use QBO total directly
      }
      if (isCOGS) {
        const sv = getVals(topRow.Summary.ColData);
        for (let i = 0; i < N; i++) sumCOGS[i] = sv[i];
      }
      if (!isIncome && !isCOGS) {
        const sv = getVals(topRow.Summary.ColData);
        for (let i = 0; i < N; i++) sumExpenses[i] += sv[i];
      }
    }
  }

  // ── Exchange gain/loss ─────────────────────────────────────────────────────
  // Find it in fullPLRows
  const exRow = fullPLRows.find(r => r.label && r.label.toLowerCase().includes('exchange'));
  exchangeVals = exRow?.values || zero();

  // ── Summary ────────────────────────────────────────────────────────────────
  const grossProfit   = sumIncome.map((v, i) => v - sumCOGS[i]);
  const netOpIncome   = grossProfit.map((v, i) => v - sumExpenses[i]);
  const netIncome     = netOpIncome.map((v, i) => v + exchangeVals[i]);

  const summary = {
    totalIncome:    sumIncome,
    totalCOGS:      sumCOGS,
    grossProfit,
    totalExpenses:  sumExpenses,
    netOpIncome,
    exchangeGainLoss: exchangeVals,
    netIncome,
  };

  // ── BU Rows ────────────────────────────────────────────────────────────────
  // Truss: split service fees vs pass-through
  const trussServiceFees = labIncome['Truss']?.filter(r =>
    r.label.toLowerCase().includes('service') || r.label.toLowerCase().includes('fee')
  ) || [];
  const trussPassThrough = labIncome['Truss']?.filter(r =>
    r.label.toLowerCase().includes('client') || r.label.toLowerCase().includes('salary') || r.label.toLowerCase().includes('salaries')
  ) || [];

  function sumRows(rows) {
    const totals = zero();
    for (const r of rows) for (let i = 0; i < N; i++) totals[i] += r.values[i] || 0;
    return totals;
  }

  function makeRevRow(name, monthRevenue, cogsRows, expRows, opts = {}) {
    const totalRevenue   = monthRevenue.reduce((a, b) => a + b, 0);
    const totalCOGS      = sumRows(cogsRows).reduce((a, b) => a + b, 0);
    const grossProfit    = totalRevenue - totalCOGS;
    const gmPct          = totalRevenue ? parseFloat((grossProfit / totalRevenue * 100).toFixed(1)) : null;
    const totalExpenses  = sumRows(expRows).reduce((a, b) => a + b, 0);
    const netIncome      = grossProfit - totalExpenses;
    const netMarginPct   = totalRevenue ? parseFloat((netIncome / totalRevenue * 100).toFixed(1)) : null;
    return { name, monthRevenue, totalRevenue, totalCOGS, grossProfit, gmPct,
             totalExpenses, netIncome, netMarginPct, ...opts };
  }

  // Pre-compute unassigned expense totals here so the BU catch-all row can reference them
  // (they'd normally be computed later in the unassigned block, but buRows needs them first)
  const reconciliationItems = unassignedExpenses.filter(r =>
    r.label.toLowerCase().includes('z — over') ||
    r.label.toLowerCase().includes('z - over') ||
    r.label.toLowerCase().includes('qb payment') ||
    r.label.toLowerCase().includes('quickbooks payment')
  );
  const reconciliationTotal  = sumRows(reconciliationItems).reduce((a,b)=>a+b,0);
  const pureUntaggedExp      = unassignedExpenses.filter(r => !reconciliationItems.includes(r));
  const untaggedExpTotal     = sumRows(pureUntaggedExp).reduce((a,b)=>a+b,0);
  const untaggedIncomeTotal  = sumRows(unassignedIncome).reduce((a,b)=>a+b,0);
  // Total unassigned expenses (pure untagged + reconciliation items)
  const unassignedExpForBU   = untaggedExpTotal + reconciliationTotal;

  // ── Single consolidated Truss BU row ─────────────────────────────────────────
  // Uses the same "total margin" model as the revenue dashboard (truss_total_margin):
  //   Economic revenue = (svc fees + device procurement + recruiting + accomplice)
  //                    + (client salary income − client salary COGS)
  // This avoids inflating totals with gross pass-through figures.
  // trussPassThrough (defined above) already identifies the client-salary income rows.
  const trussSalCOGSRows   = (labCOGS['Truss'] || []).filter(r =>
    r.label.toLowerCase().includes('client') ||
    r.label.toLowerCase().includes('salary') ||
    r.label.toLowerCase().includes('salari')
  );
  const trussNonSalIncRows = (labIncome['Truss'] || []).filter(r => !trussPassThrough.includes(r));
  const trussNonSalRevMo   = sumRows(trussNonSalIncRows);   // svc fees + device + recruiting + accomplice
  const trussSalIncMo      = sumRows(trussPassThrough);     // gross client salary income
  const trussSalCOGSMo     = sumRows(trussSalCOGSRows);     // client salary COGS
  const trussSalDeltaMo    = trussSalIncMo.map((v, i) => v - trussSalCOGSMo[i]);
  const trussEconRevMo     = trussNonSalRevMo.map((v, i) => v + trussSalDeltaMo[i]);
  const trussEconRevTotal  = trussEconRevMo.reduce((a, b) => a + b, 0);
  const trussBUExpTotal    = sumRows(labExpenses['Truss'] || []).reduce((a, b) => a + b, 0);
  const trussBUNetIncome   = trussEconRevTotal - trussBUExpTotal;
  const trussBUMarginPct   = trussEconRevTotal
    ? parseFloat((trussBUNetIncome / trussEconRevTotal * 100).toFixed(1)) : null;

  // Phantom Copy is now folded into Civille, so labIncome['Civille'] already includes it
  const civilleRev        = sumRows(labIncome['Civille'] || []);
  const awesomeRev        = sumRows(labIncome['AwesomeAPI'] || []);
  const appsRev           = sumRows(labIncome['Apps'] || []);
  const llRev             = sumRows(labIncome['Lincoln Labs'] || []);
  const caboodleRev       = sumRows(labIncome['Caboodle'] || []);
  const otherRev      = sumRows(unassignedIncome);
  const otherRevTotal = otherRev.reduce((a, b) => a + b, 0);

  // Build the five named lab rows first so we can compute the true catch-all residual.
  const civBU     = makeRevRow('Civille', civilleRev, labCOGS['Civille'] || [], labExpenses['Civille'] || []);
  const trussBU   = { name: 'Truss', monthRevenue: trussEconRevMo, totalRevenue: trussEconRevTotal,
                      totalCOGS: 0, grossProfit: trussEconRevTotal, gmPct: null,
                      totalExpenses: trussBUExpTotal, netIncome: trussBUNetIncome, netMarginPct: trussBUMarginPct };
  const awesomeBU = makeRevRow('AwesomeAPI', awesomeRev, labCOGS['AwesomeAPI'] || [], labExpenses['AwesomeAPI'] || []);
  const appsBU    = makeRevRow('Apps', appsRev, labCOGS['Apps'] || [], labExpenses['Apps'] || []);
  const llBU      = makeRevRow('Lincoln Labs Co.', llRev, labCOGS['Lincoln Labs'] || [], labExpenses['Lincoln Labs'] || []);
  const caboodleBU = makeRevRow('Caboodle', caboodleRev, labCOGS['Caboodle'] || [], labExpenses['Caboodle'] || []);

  // Unassigned / Other is a true catch-all: its net income = total P&L net income minus
  // the sum of the five named labs. This ensures the BU table always reconciles to the
  // actual P&L bottom line, capturing exchange gain/loss and any other items that don't
  // map cleanly to a specific lab.
  const totalPLNetIncome   = netIncome.reduce((a, b) => a + b, 0);
  const namedLabsNetIncome = civBU.netIncome + trussBU.netIncome + awesomeBU.netIncome
                           + appsBU.netIncome + llBU.netIncome + caboodleBU.netIncome;
  const unassignedResidual = totalPLNetIncome - namedLabsNetIncome;
  const unassignedResidualMarginPct = otherRevTotal
    ? parseFloat((unassignedResidual / otherRevTotal * 100).toFixed(1)) : null;

  const buRows = [
    civBU,
    trussBU,
    awesomeBU,
    appsBU,
    llBU,
    caboodleBU,
    { name: 'Unassigned / Other', monthRevenue: otherRev, totalRevenue: otherRevTotal,
      totalCOGS: 0, grossProfit: otherRevTotal, gmPct: null,
      totalExpenses: unassignedExpForBU,
      netIncome: unassignedResidual,
      netMarginPct: unassignedResidualMarginPct,
      isOther: true },
  ];

  // ── Per-lab P&L rows ───────────────────────────────────────────────────────
  function buildLabRows(labName, opts = {}) {
    const incRows  = (opts.extraIncome || []).concat(labIncome[labName] || []);
    const cogsRows = (opts.extraCOGS   || []).concat(labCOGS[labName]   || []);
    const expRows  = (opts.extraExpenses || []).concat(labExpenses[labName] || []);

    const rows = [];

    // Income
    rows.push({ label: 'INCOME', type: 'section_header' });
    incRows.forEach(r => rows.push({ label: r.label, values: r.values, type: 'row', accountId: r.accountId }));
    const totalInc = sumRows(incRows);
    rows.push({ label: 'Total Income', values: totalInc, type: 'total_income' });

    // COGS
    if (cogsRows.length > 0) {
      rows.push({ label: 'COST OF GOODS SOLD', type: 'section_header' });
      cogsRows.forEach(r => rows.push({ label: r.label, values: r.values, type: 'row', accountId: r.accountId }));
      const totalCOGS = sumRows(cogsRows);
      rows.push({ label: 'Total COGS', values: totalCOGS, type: 'total_cogs' });
      const gp = totalInc.map((v, i) => v - totalCOGS[i]);
      rows.push({ label: 'Gross Profit', values: gp, type: 'gross_profit' });
    }

    // Expenses — grouped by QBO top-level expense category (collapsible in the UI)
    if (expRows.length > 0) {
      rows.push({ label: 'OPERATING EXPENSES', type: 'section_header' });

      // Partition into grouped (have a .group) vs ungrouped fallbacks
      const groupMap  = new Map(); // preserves insertion order
      const ungrouped = [];
      for (const r of expRows) {
        if (r.group) {
          if (!groupMap.has(r.group)) groupMap.set(r.group, []);
          groupMap.get(r.group).push(r);
        } else {
          ungrouped.push(r);
        }
      }

      // Ungrouped rows first (shouldn't be many; mainly a safety fallback)
      ungrouped.forEach(r => rows.push({ label: r.label, values: r.values, type: 'row', accountId: r.accountId, realloc: r.realloc }));

      // Grouped expense sections — each group gets a collapsible header + child rows
      for (const [grpName, grpRows] of groupMap) {
        const grpTotal = sumRows(grpRows);
        const grpId    = slugify(grpName);
        const grpLabel = groupDisplayName(grpName);

        // Group header: bold, clickable, shows subtotal
        rows.push({ label: grpLabel, values: grpTotal, type: 'group_header', groupId: grpId });

        // Child rows: use parentSectionName as sub-label when it adds context
        // (i.e. it's a named sub-category rather than just the group name itself)
        grpRows.forEach(r => {
          const useSub = r.subLabel && r.subLabel !== grpName;
          rows.push({
            label:    useSub ? r.subLabel : r.label,
            values:   r.values,
            type:     'group_child',
            groupId:  grpId,
            accountId: r.accountId,
            realloc:  r.realloc,
          });
        });
      }

      const totalExp = sumRows(expRows);
      rows.push({ label: 'Total Expenses', values: totalExp, type: 'total_expenses' });

      // Net Op Income
      const totalCOGS2 = sumRows(cogsRows);
      const netOp = totalInc.map((v, i) => v - totalCOGS2[i] - totalExp[i]);
      rows.push({ label: 'Net Operating Income (est.)', values: netOp, type: 'net_op' });
    }

    return rows;
  }

  function labKPIs(labName, opts = {}) {
    const incRows  = (opts.extraIncome    || []).concat(labIncome[labName]    || []);
    const cogsRows = (opts.extraCOGS      || []).concat(labCOGS[labName]      || []);
    const expRows  = (opts.extraExpenses  || []).concat(labExpenses[labName]  || []);

    const totalInc = sumRows(incRows).reduce((a,b)=>a+b,0);
    const totalCgs = sumRows(cogsRows).reduce((a,b)=>a+b,0);
    const totalExp = sumRows(expRows).reduce((a,b)=>a+b,0);
    const gp       = totalInc - totalCgs;
    const gmPct    = totalInc ? parseFloat((gp / totalInc * 100).toFixed(1)) : null;
    const netOp        = gp - totalExp;
    const netMarginPct = totalInc ? parseFloat((netOp / totalInc * 100).toFixed(1)) : null;

    return { revenue: totalInc, cogs: totalCgs, grossProfit: gp, gmPct, totalExpenses: totalExp, netOpIncome: netOp, netMarginPct };
  }

  // Truss special KPIs
  function trussKPIs() {
    const serviceFees = sumRows(trussServiceFees).reduce((a,b)=>a+b,0);
    const passThrough = sumRows(trussPassThrough).reduce((a,b)=>a+b,0);
    const totalRev    = serviceFees + passThrough;
    const totalCgs    = sumRows(labCOGS['Truss'] || []).reduce((a,b)=>a+b,0);
    const gp          = totalRev - totalCgs;
    const gmPct       = totalRev ? parseFloat((gp / totalRev * 100).toFixed(1)) : null;
    const totalExp    = sumRows(labExpenses['Truss'] || []).reduce((a,b)=>a+b,0);
    const netOp       = gp - totalExp;
    const netMarginPct = totalRev ? parseFloat((netOp / totalRev * 100).toFixed(1)) : null;
    return {
      totalRevenue:    totalRev,
      serviceFeesRev:  serviceFees,
      passThroughRev:  passThrough,
      totalCOGS:       totalCgs,
      grossProfit:     gp,
      gmPct,
      totalExpenses:   totalExp,
      netOpIncome:     netOp,
      netMarginPct,
    };
  }

  // Truss P&L rows (all income combined, then all COGS, then expenses)
  function trussRows() {
    const allInc   = (labIncome['Truss'] || []);
    const cogsRows = (labCOGS['Truss']   || []);
    const expRows  = (labExpenses['Truss'] || []);
    const rows = [];

    rows.push({ label: 'INCOME', type: 'section_header' });
    allInc.forEach(r => rows.push({ label: r.label, values: r.values, type: 'row', accountId: r.accountId }));
    const totalInc = sumRows(allInc);
    rows.push({ label: 'Total Income', values: totalInc, type: 'total_income' });

    if (cogsRows.length > 0) {
      rows.push({ label: 'COST OF GOODS SOLD', type: 'section_header' });
      cogsRows.forEach(r => rows.push({ label: r.label, values: r.values, type: 'row', accountId: r.accountId }));
      const totalCOGS = sumRows(cogsRows);
      rows.push({ label: 'Total COGS', values: totalCOGS, type: 'total_cogs' });
      const gp = totalInc.map((v, i) => v - totalCOGS[i]);
      rows.push({ label: 'Gross Profit', values: gp, type: 'gross_profit' });
    }

    if (expRows.length > 0) {
      rows.push({ label: 'OPERATING EXPENSES', type: 'section_header' });
      expRows.forEach(r => rows.push({ label: r.label, values: r.values, type: 'row', accountId: r.accountId, realloc: r.realloc }));
      const totalExp  = sumRows(expRows);
      rows.push({ label: 'Total Expenses', values: totalExp, type: 'total_expenses' });
      const totalCOGS2 = sumRows(cogsRows);
      const netOp = totalInc.map((v, i) => v - totalCOGS2[i] - totalExp[i]);
      rows.push({ label: 'Net Operating Income (est.)', values: netOp, type: 'net_op' });
    }

    return rows;
  }

  // Civille already includes Phantom Copy (matchLab routes phantom → Civille)
  const labs = {
    'Civille':      { subtitle: null, kpis: labKPIs('Civille'),     rows: buildLabRows('Civille')     },
    'Truss':        { subtitle: null, kpis: trussKPIs(),             rows: buildLabRows('Truss')       },
    'AwesomeAPI':   { subtitle: null, kpis: labKPIs('AwesomeAPI'),   rows: buildLabRows('AwesomeAPI')  },
    'Apps':         { subtitle: null, kpis: labKPIs('Apps'),         rows: buildLabRows('Apps')        },
    'Lincoln Labs': { subtitle: null, kpis: labKPIs('Lincoln Labs'), rows: buildLabRows('Lincoln Labs')},
    'Caboodle':     { subtitle: 'Recently acquired — expenses only for now', kpis: labKPIs('Caboodle'), rows: buildLabRows('Caboodle') },
  };

  // ── Unassigned ─────────────────────────────────────────────────────────────
  // (reconciliationItems, pureUntaggedExp, untaggedExpTotal, untaggedIncomeTotal
  //  are all pre-computed above before buRows so the catch-all row reconciles correctly)

  const unassigned = {
    kpis: {
      untaggedIncome:       untaggedIncomeTotal,
      untaggedExpenses:     untaggedExpTotal,
      reconciliationItems:  reconciliationTotal,
      totalToClassify:      untaggedIncomeTotal + untaggedExpTotal + reconciliationTotal,
    },
    incomeRows:  unassignedIncome,
    expenseRows: pureUntaggedExp,
  };

  return { summary, buRows, fullPLRows, labs, unassigned, N,
    monthRanges: monthCols.map(c => ({ start: c.startDate, end: c.endDate })) };
}

// ── Route handler ─────────────────────────────────────────────────────────────

async function getPlByLabData(req, res) {
  try {
    const accessToken = await tokenStore.getAccessToken();
    const realmId     = tokenStore.getRealmId();
    const am          = req.query.accounting_method === 'Cash' ? 'Cash' : 'Accrual';

    // Accept optional start_date / end_date query params (YYYY-MM-DD)
    const reqStart = req.query.start_date || null;
    const reqEnd   = req.query.end_date   || null;

    const months    = getReportMonths(reqStart, reqEnd);
    const startDate = months[0].start;
    const endDate   = months[months.length - 1].end;

    const [pl, forexByMonth, reallocations] = await Promise.all([
      fetchTotalPL(accessToken, realmId, startDate, endDate, am),
      // Forex breakout is a nice-to-have — never let it sink the whole P&L
      fetchForexFeeByMonth(accessToken, realmId, months, am).catch(err => {
        console.error('/api/pl-by-lab ItemSales (Forex) fetch failed:', err.response?.data || err.message);
        return null;
      }),
      // Same deal for transaction-level reallocations: on failure, rows simply
      // stay with the account's lab instead of the whole report erroring.
      fetchTxnReallocations(accessToken, realmId, months, am).catch(err => {
        console.error('/api/pl-by-lab reallocation fetch failed:', err.response?.data || err.message);
        return null;
      }),
    ]);
    const { summary, buRows, fullPLRows, labs, unassigned, monthRanges } = parsePL(pl, reallocations);

    if (forexByMonth) breakOutForexRow(labs['Truss'], monthRanges, forexByMonth);

    const partialMonths = months.reduce((acc, m, i) => { if (m.partial) acc.push(i); return acc; }, []);

    res.json({
      months:           months.map(m => m.label),
      partialMonths,
      accountingMethod: am,
      summary,
      buRows,
      fullPLRows,
      labs,
      unassigned,
      monthRanges,
    });
  } catch (err) {
    const qboErr = err.response?.data;
    console.error('/api/pl-by-lab error:', qboErr || err.message);
    res.status(500).json({
      error:  'Failed to fetch P&L by lab data',
      detail: err.message,
      qbo:    qboErr || null,
    });
  }
}

// Fetch the QBO ProfitAndLossDetail report filtered to a single account.
//
// ProfitAndLossDetail is the report QBO itself renders when you click a P&L
// cell, and it's the only detail report here that actually supports what the
// drill needs (verified against Intuit's API reference 2026-07-07):
//   - `account` filter: comma-separated account IDs. TransactionList silently
//     IGNORES an `account` param (it isn't in its parameter list), which is why
//     the old drill showed every company transaction in the period.
//   - `accounting_method`: the drill must match the basis the P&L was run on
//     or Cash-basis cells never reconcile. TransactionList has no such param.
//   - Amount column: TransactionList doesn't support `subt_nat_amount`, so
//     amounts came back blank. ProfitAndLossDetail returns it.
async function fetchPLDetail(accessToken, realmId, accountId, startDate, endDate, accountingMethod) {
  const env    = process.env.QBO_ENVIRONMENT || 'production';
  const base   = QBO_BASE[env];
  // No `columns` param: QBO validates the list and silently DROPS anything it
  // doesn't recognize — and despite Intuit's own docs showing subt_nat_amount
  // in a sample query, PLDetail rejects it, returning a report with no amount
  // column at all (verified against prod 2026-07-07). The default column set
  // (Date, Transaction Type, Num, Name, Memo, Split, Amount, Balance) has
  // everything the drill needs.
  const params = new URLSearchParams({
    account:           accountId,
    start_date:        startDate,
    end_date:          endDate,
    accounting_method: accountingMethod,
  });
  const url = `${base}/v3/company/${realmId}/reports/ProfitAndLossDetail?${params}`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  return res.data;
}

// Walk a QBO report's Rows tree and collect every row whose `type === 'Data'`.
// QBO nests these arbitrarily (Section → Rows → Row → possibly deeper sections),
// so a recursive flatten is the only safe way to extract every line item.
//
// When accountId is given, sections headed by a DIFFERENT account are skipped:
// PLDetail's `account` filter includes sub-accounts (e.g. account=Civille also
// returns a "Phantom Copy" section), but the P&L row being drilled shows only
// the parent's own postings — including children would overstate the total.
// Structural sections ("Income", "Ordinary Income/Expenses") carry no id and
// are always traversed.
function collectDataRows(node, acc, accountId) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(n => collectDataRows(n, acc, accountId)); return; }
  const hdrId = node.Header?.ColData?.[0]?.id;
  if (accountId && hdrId && String(hdrId) !== String(accountId)) return;
  if (node.type === 'Data' && node.ColData) acc.push(node);
  if (node.Rows?.Row)     collectDataRows(node.Rows.Row, acc, accountId);
  if (node.Row)           collectDataRows(node.Row, acc, accountId);
}

// Column headers QBO uses when neither ColKey metadata nor a key-style ColType
// is present (some report variants return generic ColTypes like "String").
const COL_TITLE_TO_KEY = {
  'date':             'tx_date',
  'transaction type': 'txn_type',
  'num':              'doc_num',
  'no.':              'doc_num',
  'name':             'name',
  'memo/description': 'memo',
  'memo':             'memo',
  'split':            'split_acc',
  'account':          'account_name',
  'amount':           'subt_nat_amount',
};

function parseTransactionReport(report, accountId) {
  const columns = report.Columns?.Column || [];
  const colIdx  = {};
  // Resolve each column to a canonical key — prefer ColKey metadata (QBO's
  // unambiguous id), then ColType, then the human title. First match wins.
  columns.forEach((col, i) => {
    const metaKey  = ((col.MetaData || []).find(m => m.Name === 'ColKey') || {}).Value;
    const titleKey = COL_TITLE_TO_KEY[(col.ColTitle || '').trim().toLowerCase()];
    for (const key of [metaKey, col.ColType, titleKey]) {
      if (key && colIdx[key] == null) colIdx[key] = i;
    }
  });

  const get = (cols, type) => {
    const i = colIdx[type];
    return (i != null && cols[i]) ? (cols[i].value || '') : '';
  };
  const getId = (cols, type) => {
    const i = colIdx[type];
    return (i != null && cols[i]) ? (cols[i].id || null) : null;
  };
  const getAmt = (cols) => {
    const raw = get(cols, 'subt_nat_amount') || get(cols, 'subt_nat_home_amount') || get(cols, 'amount') || get(cols, 'nat_amount');
    const n   = raw ? parseFloat(raw) : 0;
    return isNaN(n) ? 0 : n;
  };

  const dataRows = [];
  collectDataRows(report.Rows?.Row, dataRows, accountId);

  return dataRows.map(row => {
    const cols = row.ColData || [];
    return {
      date:   get(cols, 'tx_date'),
      type:   get(cols, 'txn_type'),
      txnId:  getId(cols, 'txn_type') || getId(cols, 'tx_date'),
      num:    get(cols, 'doc_num'),
      name:   get(cols, 'name'),
      memo:   get(cols, 'memo'),
      split:  get(cols, 'split_acc') || get(cols, 'account_name'),
      amount: getAmt(cols),
    };
  });
}

async function getPlDrillData(req, res) {
  try {
    const { accountId, startDate, endDate } = req.query;
    if (!accountId || !startDate || !endDate) {
      return res.status(400).json({ error: 'accountId, startDate, endDate are required' });
    }
    const am          = req.query.accountingMethod === 'Cash' ? 'Cash' : 'Accrual';
    const accessToken = await tokenStore.getAccessToken();
    const realmId     = tokenStore.getRealmId();

    const report = await fetchPLDetail(accessToken, realmId, accountId, startDate, endDate, am);
    // Debug escape hatch (auth-gated like the rest of the route): return the
    // raw QBO report so column-encoding surprises can be diagnosed in prod.
    if (req.query.raw === '1') return res.json(report);
    let transactions = parseTransactionReport(report, accountId);

    // Reallocation-aware filtering (see TXN_REALLOCATIONS): a drill on a source
    // row hides the transactions that were moved to another lab; a drill on a
    // reallocated row ('<ruleId>::<lab>') shows only the ones that rule claimed,
    // scaled to that lab's share. No param = raw account (full P&L tab).
    const reallocParam = req.query.realloc;
    let shareNote = null;
    if (reallocParam === 'exclude') {
      // Fully-claimed transactions disappear; partially-claimed ones (rules
      // whose target shares sum to < 1) stay at the share left with this lab.
      let hasRemainder = false;
      const kept = [];
      for (const t of transactions) {
        const rule = claimingRule(accountId, t.memo, t.name);
        if (!rule) { kept.push(t); continue; }
        const remainder = 1 - rule.targets.reduce((s, tg) => s + tg.share, 0);
        if (remainder > 1e-9) {
          kept.push({ ...t, amount: +(t.amount * remainder).toFixed(2) });
          hasRemainder = true;
        }
      }
      transactions = kept;
      if (hasRemainder) shareNote = 'Split transactions are shown at the share remaining with this account.';
    } else if (reallocParam) {
      const [ruleId, labName] = reallocParam.split('::');
      if (ruleId === `acct_${accountId}`) {
        // Whole-account split: every transaction, scaled to the lab's share
        // for the drilled month (splits can vary by month).
        const split = ACCOUNT_SPLITS[String(accountId)];
        const share = split ? acctShareFor(split, String(startDate).substring(0, 7), labName) : 0;
        if (split && share !== 1) {
          transactions = transactions.map(t => ({ ...t, amount: +(t.amount * share).toFixed(2) }));
          shareNote = `Amounts shown are ${labName}'s ${+(share * 100).toFixed(1)}% share of each transaction.`;
        }
      } else {
        const rule   = TXN_REALLOCATIONS.find(r => r.id === ruleId);
        const target = rule && (rule.targets.find(tg => tg.lab === labName) || rule.targets[0]);
        if (target) {
          transactions = transactions.filter(t => claimingRule(accountId, t.memo, t.name)?.id === ruleId);
          if (target.share !== 1) {
            transactions = transactions.map(t => ({ ...t, amount: +(t.amount * target.share).toFixed(2) }));
            const pct = +(target.share * 100).toFixed(1); // 33.3, not 33
            shareNote = `Amounts shown are ${target.lab}'s ${pct}% share of each transaction.`;
          }
        }
      }
    }

    console.log(`/api/pl-drill account=${accountId} ${startDate}..${endDate} ${am}${reallocParam ? ` realloc=${reallocParam}` : ''} → ${transactions.length} txns`);
    res.json(shareNote ? { transactions, shareNote } : { transactions });
  } catch (err) {
    const qboErr = err.response?.data;
    console.error('/api/pl-drill error:', qboErr || err.message);
    res.status(500).json({ error: 'Failed to fetch transaction detail', detail: err.message, qbo: qboErr || null });
  }
}

// parsePL, TXN_REALLOCATIONS, and claimingRule are exported for tests only
module.exports = { getPlByLabData, getPlDrillData, parsePL, TXN_REALLOCATIONS, claimingRule };

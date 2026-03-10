'use strict';
// GET /api/pl-by-lab
//
// Fetches the TOTAL (unfiltered) P&L for completed months of the current year,
// then classifies each line item by lab by matching brand keywords in account
// and section names.
//
// Double-counting prevention: when a Section's header or summary matches a lab,
// the Section Summary is used as the single authoritative total and children are
// NOT recursed into (e.g. "Total Civille" captures Phantom Copy without listing
// Phantom Copy separately).

const axios      = require('axios');
const tokenStore = require('../tokenStore');

const LAB_CLASSES = ['Apps', 'AwesomeAPI', 'Civille', 'Lincoln Labs', 'Truss'];
const MONTH_ABBR  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const QBO_BASE = {
  production: 'https://quickbooks.api.intuit.com',
  sandbox:    'https://sandbox-quickbooks.api.intuit.com',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function completedMonthsThisYear() {
  const today     = new Date();
  const year      = today.getFullYear();
  const thisMonth = today.getMonth() + 1; // current month is incomplete
  const months    = [];
  for (let m = 1; m < thisMonth; m++) {
    const lastDay = new Date(year, m, 0).getDate();
    months.push({
      label: `${MONTH_ABBR[m - 1]} ${year}`,
      start: `${year}-${String(m).padStart(2, '0')}-01`,
      end:   `${year}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    });
  }
  return months;
}

// Single P&L fetch — no class filter, all months in one request.
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

// ── Lab matching ──────────────────────────────────────────────────────────────
// Return the lab key if text contains that lab's brand name; null otherwise.
// Order matters: check longer/more-specific patterns first.
function matchLab(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/awesome/.test(t))   return 'AwesomeAPI'; // before generic checks
  if (/civille/.test(t))   return 'Civille';
  if (/phantom/.test(t))   return 'Civille';    // Phantom Copy is a Civille sub-brand
  if (/lincoln/.test(t))   return 'Lincoln Labs';
  if (/\btruss\b/.test(t)) return 'Truss';
  if (/\bapps?\b/.test(t)) return 'Apps';       // word-boundary so "AwesomeApp" doesn't match
  return null;
}

// ── Core parser ───────────────────────────────────────────────────────────────
// Walk the P&L tree once and classify line items into per-lab buckets.
// Returns: { labName: { income: [{label, values}], cogs: [...], expenses: [...] } }
function extractLabData(pl) {
  const cols = pl.Columns?.Column || [];

  // Same ColData offset logic used in qbo.js
  const hasAccountCol = cols.some(c => c.ColType === 'Account');
  const colDataOffset = hasAccountCol ? 0 : 1;

  // Month columns only (exclude YTD / Total summary columns)
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

  // Initialize result structure
  const labs = {};
  LAB_CLASSES.forEach(lab => { labs[lab] = { income: [], cogs: [], expenses: [] }; });

  if (monthCols.length === 0) return labs;

  const getVals = (colData) =>
    monthCols.map(col => parseFloat(colData[col.idx + colDataOffset]?.value || '0'));

  // Recursively walk a list of rows, placing matching items into labs[lab][sectionType].
  function walk(rows, sectionType) {
    for (const row of rows) {

      if (row.type === 'Section') {
        const header  = row.Header?.ColData?.[0]?.value || '';
        const summary = row.Summary?.ColData?.[0]?.value || '';
        const lab     = matchLab(header) || matchLab(summary);

        if (lab) {
          if (row.Summary?.ColData) {
            // Use the Section Summary as the authoritative total for this lab.
            // Do NOT recurse into children — that would double-count.
            const values = getVals(row.Summary.ColData);
            if (values.some(v => v !== 0)) {
              labs[lab][sectionType].push({ label: summary || header, values });
            }
          } else if (row.Rows?.Row) {
            // Section matched but has no Summary (unusual) — recurse as fallback.
            walk(row.Rows.Row, sectionType);
          }
        } else {
          // Section doesn't belong to a specific lab — recurse to find matches inside.
          if (row.Rows?.Row) walk(row.Rows.Row, sectionType);
        }
      }

      if (row.type === 'Data' && row.ColData) {
        // Individual account row — classify by name if it matches a lab.
        const name = row.ColData[0]?.value || '';
        const lab  = matchLab(name);
        if (lab) {
          const values = getVals(row.ColData);
          if (values.some(v => v !== 0)) {
            labs[lab][sectionType].push({ label: name, values });
          }
        }
      }
    }
  }

  // Top-level P&L sections determine whether children are income, COGS, or expenses.
  for (const row of (pl.Rows?.Row || [])) {
    if (row.type !== 'Section') continue;
    const h = (row.Header?.ColData?.[0]?.value || '').toLowerCase();
    const s = (row.Summary?.ColData?.[0]?.value || '').toLowerCase();

    // Skip QBO computed summary rows (no real children)
    if (h === 'gross profit' || s === 'gross profit') continue;
    if (h.startsWith('net ')  || s.startsWith('net '))  continue;

    const isIncome = h.includes('income') || h.includes('revenue') || h.includes('sales');
    const isCOGS   = h.includes('cost of goods') || h.includes('cogs');
    const sType    = isIncome ? 'income' : isCOGS ? 'cogs' : 'expenses';

    if (row.Rows?.Row) walk(row.Rows.Row, sType);
  }

  return labs;
}

// ── Route handler ─────────────────────────────────────────────────────────────

async function getPlByLabData(req, res) {
  try {
    const accessToken = await tokenStore.getAccessToken();
    const realmId     = tokenStore.getRealmId();
    const am          = req.query.accounting_method === 'Cash' ? 'Cash' : 'Accrual';

    const months = completedMonthsThisYear();
    if (months.length === 0) {
      return res.json({ months: [], labs: {}, labNames: LAB_CLASSES });
    }

    const startDate = months[0].start;
    const endDate   = months[months.length - 1].end;

    const pl   = await fetchTotalPL(accessToken, realmId, startDate, endDate, am);
    const labs = extractLabData(pl);

    res.json({ months: months.map(m => m.label), labs, labNames: LAB_CLASSES });
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

module.exports = { getPlByLabData };

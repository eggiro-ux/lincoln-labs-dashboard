'use strict';
// GET /api/pl-by-lab
// Returns a full P&L (income, COGS, expenses line items) per lab class,
// for all completed calendar months of the current year.

const axios      = require('axios');
const tokenStore = require('../tokenStore');

const LAB_CLASSES = ['Apps', 'AwesomeAPI', 'Civille', 'Lincoln Labs', 'Truss'];
const MONTH_ABBR  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const QBO_BASE = {
  production: 'https://quickbooks.api.intuit.com',
  sandbox:    'https://sandbox-quickbooks.api.intuit.com',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function completedMonthsThisYear() {
  const today     = new Date();
  const year      = today.getFullYear();
  const thisMonth = today.getMonth() + 1; // current month is not yet complete
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

async function fetchClassPL(accessToken, realmId, className, startDate, endDate, accountingMethod) {
  const env    = process.env.QBO_ENVIRONMENT || 'production';
  const base   = QBO_BASE[env];
  const params = new URLSearchParams({
    start_date:          startDate,
    end_date:            endDate,
    accounting_method:   accountingMethod,
    summarize_column_by: 'Month',
    class:               className,
  });
  const url = `${base}/v3/company/${realmId}/reports/ProfitAndLoss?${params}`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  return res.data;
}

// Parse a class-filtered P&L report into { income, cogs, expenses } where each
// is an array of { label, values } — one value per completed-month column.
function parsePL(pl) {
  const cols = pl.Columns?.Column || [];

  // Same ColData offset logic as qbo.js
  const hasAccountCol = cols.some(c => c.ColType === 'Account');
  const colDataOffset = hasAccountCol ? 0 : 1;

  // Per-month Money columns only (exclude YTD / Total summary columns)
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

  if (monthCols.length === 0) return { income: [], cogs: [], expenses: [] };

  // Extract per-month values from a Data row's ColData array
  const getVals = (colData) =>
    monthCols.map(col => parseFloat(colData[col.idx + colDataOffset]?.value || '0'));

  // Recursively collect all Data-row line items within a section tree.
  // Skips zero-across-all-months rows to keep the table clean.
  function collectRows(rows) {
    const items = [];
    for (const row of rows) {
      if (row.type === 'Data' && row.ColData) {
        const label = row.ColData[0]?.value;
        if (label) {
          const values = getVals(row.ColData);
          if (values.some(v => v !== 0)) items.push({ label, values });
        }
      } else if (row.type === 'Section' && row.Rows?.Row) {
        items.push(...collectRows(row.Rows.Row));
      }
    }
    return items;
  }

  const income   = [];
  const cogs     = [];
  const expenses = [];

  for (const topRow of (pl.Rows?.Row || [])) {
    if (topRow.type !== 'Section') continue;

    const h = (topRow.Header?.ColData?.[0]?.value || '').toLowerCase();
    const s = (topRow.Summary?.ColData?.[0]?.value || '').toLowerCase();

    // Skip QBO's computed summary-only sections (no children to recurse)
    if (h === 'gross profit' || s === 'gross profit') continue;
    if (h === 'net income'   || s === 'net income')   continue;

    const isIncome = h.includes('income') || h.includes('revenue') || h.includes('sales');
    const isCOGS   = h.includes('cost of goods') || h.includes('cogs');

    if (!topRow.Rows?.Row) continue;

    if (isIncome)    income.push(...collectRows(topRow.Rows.Row));
    else if (isCOGS) cogs.push(...collectRows(topRow.Rows.Row));
    else             expenses.push(...collectRows(topRow.Rows.Row));
  }

  return { income, cogs, expenses };
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

    const results = await Promise.all(
      LAB_CLASSES.map(lab => fetchClassPL(accessToken, realmId, lab, startDate, endDate, am))
    );

    const labs = {};
    LAB_CLASSES.forEach((lab, i) => { labs[lab] = parsePL(results[i]); });

    res.json({ months: months.map(m => m.label), labs, labNames: LAB_CLASSES });
  } catch (err) {
    console.error('/api/pl-by-lab error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch P&L by lab data', detail: err.message });
  }
}

module.exports = { getPlByLabData };

'use strict';
// GET /api/pl-by-lab
// Fetches QBO ProfitAndLoss filtered by class for each Lab, across all completed
// calendar months of the current year. All labs are fetched in parallel.

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
  const today    = new Date();
  const year     = today.getFullYear();
  const thisMonth = today.getMonth() + 1; // 1-based; current month is not yet complete
  const months   = [];
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
  const env  = process.env.QBO_ENVIRONMENT || 'production';
  const base = QBO_BASE[env];
  const params = new URLSearchParams({
    start_date:          startDate,
    end_date:            endDate,
    accounting_method:   accountingMethod,
    summarize_column_by: 'Month',
    class:               className,
  });
  const url = `${base}/v3/company/${realmId}/reports/ProfitAndLoss?${params}`;
  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept:        'application/json',
    },
  });
  return res.data;
}

// Parse a class-filtered P&L report.
// Returns { income, cogs, grossProfit, expenses, netIncome } — each an array
// of numbers aligned to the completed-month columns in the report.
function parsePL(pl) {
  const cols = pl.Columns?.Column || [];

  // Same ColData offset logic as qbo.js
  const hasAccountCol = cols.some(c => c.ColType === 'Account');
  const colDataOffset = hasAccountCol ? 0 : 1;

  // Identify per-month Money columns (excludes YTD / Total columns)
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

  const n = monthCols.length;
  const zeros = () => Array(n).fill(0);

  const income      = zeros();
  const cogs        = zeros();
  const grossProfit = zeros();
  const expenses    = zeros();
  const netIncome   = zeros();

  let hasGrossProfit = false;
  let hasNetIncome   = false;

  const getVals = (row) =>
    monthCols.map(col =>
      parseFloat(row.Summary?.ColData?.[col.idx + colDataOffset]?.value || '0')
    );

  for (const row of (pl.Rows?.Row || [])) {
    if (row.type !== 'Section' || !row.Summary?.ColData) continue;

    const summaryLabel = (row.Summary.ColData[0]?.value || '').toLowerCase();
    const headerLabel  = (row.Header?.ColData?.[0]?.value || '').toLowerCase();

    if (summaryLabel.includes('total income') || summaryLabel.includes('total revenue')) {
      getVals(row).forEach((v, i) => { income[i] = v; });

    } else if (summaryLabel.includes('total cost of goods') || headerLabel.includes('cost of goods')) {
      getVals(row).forEach((v, i) => { cogs[i] = v; });

    } else if (summaryLabel === 'gross profit' || headerLabel === 'gross profit') {
      hasGrossProfit = true;
      getVals(row).forEach((v, i) => { grossProfit[i] = v; });

    } else if (summaryLabel.includes('total expense')) {
      getVals(row).forEach((v, i) => { expenses[i] = v; });

    } else if (summaryLabel === 'net income' || headerLabel === 'net income') {
      hasNetIncome = true;
      getVals(row).forEach((v, i) => { netIncome[i] = v; });
    }
  }

  // Derive any values QBO didn't return directly
  if (!hasGrossProfit) {
    for (let i = 0; i < n; i++) {
      grossProfit[i] = Math.round((income[i] - cogs[i]) * 100) / 100;
    }
  }
  if (!hasNetIncome) {
    for (let i = 0; i < n; i++) {
      netIncome[i] = Math.round((grossProfit[i] - expenses[i]) * 100) / 100;
    }
  }

  return { income, cogs, grossProfit, expenses, netIncome };
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
    LAB_CLASSES.forEach((lab, i) => {
      labs[lab] = parsePL(results[i]);
    });

    res.json({ months: months.map(m => m.label), labs, labNames: LAB_CLASSES });
  } catch (err) {
    console.error('/api/pl-by-lab error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch P&L by lab data', detail: err.message });
  }
}

module.exports = { getPlByLabData };

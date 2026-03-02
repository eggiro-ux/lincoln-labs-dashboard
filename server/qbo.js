const axios = require('axios');
const ACCOUNT_MAP = require('./accounts');

const QBO_BASE = {
  production: 'https://quickbooks.api.intuit.com',
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
};

// ─── Flatten QBO P&L rows into a map of { accountName -> value } ──────────────
function flattenRows(rows, result = {}) {
  if (!rows) return result;
  for (const row of rows) {
    if (row.type === 'Section' && row.Rows) {
      flattenRows(row.Rows.Row, result);
    }
    if (row.type === 'Data' && row.ColData) {
      const name = row.ColData[0]?.value;
      const val = parseFloat(row.ColData[1]?.value || '0');
      if (name && name !== '') result[name] = (result[name] || 0) + val;
    }
  }
  return result;
}

// ─── Fetch a P&L report for a date range ─────────────────────────────────────
async function fetchPL(tokens, realmId, startDate, endDate, columns = 'month') {
  const env = process.env.QBO_ENVIRONMENT || 'production';
  const base = QBO_BASE[env];

  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    accounting_method: 'Accrual',
  });

  if (columns === 'month') params.set('columns', 'MONTH');

  const url = `${base}/v3/company/${realmId}/reports/ProfitAndLoss?${params}`;

  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: 'application/json',
    },
  });

  return res.data;
}

// ─── Aggregate raw account map into our series using ACCOUNT_MAP ──────────────
function aggregateSeries(accountValues, expenseValues = {}) {
  const result = {};
  for (const [key, config] of Object.entries(ACCOUNT_MAP)) {
    let income = 0;
    for (const acct of config.accounts) {
      income += accountValues[acct] || 0;
    }
    if (config.type === 'delta') {
      let expense = 0;
      for (const acct of config.expenseAccounts || []) {
        expense += expenseValues[acct] || 0;
      }
      result[key] = Math.round((income - expense) * 100) / 100;
    } else {
      result[key] = Math.round(income * 100) / 100;
    }
  }
  return result;
}

// ─── /api/monthly — full historical P&L by month ─────────────────────────────
// Returns { months: [...], series: { civille: [...], ... } }
async function getMonthlyData(tokens, realmId) {
  // Pull from Jan 2024 to today
  const start = '2024-01-01';
  const today = new Date();
  const end = today.toISOString().split('T')[0];

  const pl = await fetchPL(tokens, realmId, start, end, 'month');

  // Extract column headers (month labels)
  const cols = pl.Columns?.Column || [];
  const monthCols = cols
    .map((c, i) => ({ idx: i, label: c.ColTitle, type: c.ColType }))
    .filter(c => c.type === 'Money' && c.label && c.label !== 'Total');

  // Build per-month account values
  const rows = pl.Rows?.Row || [];

  const monthlyIncome = monthCols.map(() => ({}));
  const monthlyExpense = monthCols.map(() => ({}));

  function processRows(rows, section = '') {
    for (const row of rows) {
      if (row.type === 'Section') {
        const sectionName = row.Header?.ColData?.[0]?.value || section;
        const isCOGS = sectionName.toLowerCase().includes('cost of goods') ||
                       sectionName.toLowerCase().includes('offshore labor');
        if (row.Rows?.Row) processRowsInner(row.Rows.Row, isCOGS);
      }
    }
  }

  function processRowsInner(rows, isCOGS) {
    for (const row of rows) {
      if (row.type === 'Section' && row.Rows?.Row) {
        const sName = row.Header?.ColData?.[0]?.value || '';
        const stillCOGS = isCOGS ||
          sName.toLowerCase().includes('cost of goods') ||
          sName.toLowerCase().includes('offshore labor');
        processRowsInner(row.Rows.Row, stillCOGS);
      }
      if (row.type === 'Data' && row.ColData) {
        const name = row.ColData[0]?.value;
        if (!name) continue;
        monthCols.forEach((col, i) => {
          const val = parseFloat(row.ColData[col.idx + 1]?.value || '0');
          if (isCOGS) {
            monthlyExpense[i][name] = (monthlyExpense[i][name] || 0) + val;
          } else {
            monthlyIncome[i][name] = (monthlyIncome[i][name] || 0) + val;
          }
        });
      }
    }
  }

  processRows(rows);

  // Determine which months are complete (exclude current partial month)
  const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

  const completedMonths = monthCols.filter(col => {
    // col.label is like "Jan 2024" — parse it
    const d = new Date(col.label);
    const colMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    return colMonth < currentMonth;
  });

  const months = completedMonths.map(col => col.label);
  const seriesArrays = {};
  for (const key of Object.keys(ACCOUNT_MAP)) seriesArrays[key] = [];

  completedMonths.forEach((col, i) => {
    const idx = monthCols.findIndex(m => m.label === col.label);
    const agg = aggregateSeries(monthlyIncome[idx], monthlyExpense[idx]);
    for (const key of Object.keys(ACCOUNT_MAP)) {
      seriesArrays[key].push(agg[key] ?? null);
    }
  });

  return { months, series: seriesArrays };
}

// ─── /api/current-period — MTD comparison ────────────────────────────────────
// Returns current month MTD vs same days in prior month, per product line
async function getCurrentPeriodData(tokens, realmId) {
  const today = new Date();
  const dayOfMonth = today.getDate();

  // Current period: 1st of this month → today
  const curStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const curEnd = today;

  // Prior period: 1st of last month → same day last month
  const priorStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const priorEnd = new Date(today.getFullYear(), today.getMonth() - 1, dayOfMonth);

  const fmt = d => d.toISOString().split('T')[0];

  const [curPL, priorPL] = await Promise.all([
    fetchPL(tokens, realmId, fmt(curStart), fmt(curEnd), 'total'),
    fetchPL(tokens, realmId, fmt(priorStart), fmt(priorEnd), 'total'),
  ]);

  function extractTotals(pl, isCOGS = false) {
    const income = {}, expense = {};
    function walk(rows, inCOGS) {
      for (const row of rows) {
        if (row.type === 'Section') {
          const sName = row.Header?.ColData?.[0]?.value || '';
          const nowCOGS = inCOGS ||
            sName.toLowerCase().includes('cost of goods') ||
            sName.toLowerCase().includes('offshore labor');
          if (row.Rows?.Row) walk(row.Rows.Row, nowCOGS);
        }
        if (row.type === 'Data' && row.ColData) {
          const name = row.ColData[0]?.value;
          const val = parseFloat(row.ColData[1]?.value || '0');
          if (!name) continue;
          if (inCOGS) expense[name] = (expense[name] || 0) + val;
          else income[name] = (income[name] || 0) + val;
        }
      }
    }
    walk(pl.Rows?.Row || [], false);
    return { income, expense };
  }

  const cur = extractTotals(curPL);
  const prior = extractTotals(priorPL);

  const currentSeries = aggregateSeries(cur.income, cur.expense);
  const priorSeries = aggregateSeries(prior.income, prior.expense);

  // Build comparison per product line
  const comparison = {};
  for (const [key, config] of Object.entries(ACCOUNT_MAP)) {
    const current = currentSeries[key] || 0;
    const previous = priorSeries[key] || 0;
    const delta = Math.round((current - previous) * 100) / 100;
    comparison[key] = { label: config.label, color: config.color, current, previous, delta };
  }

  return {
    currentPeriod: { start: fmt(curStart), end: fmt(curEnd) },
    priorPeriod: { start: fmt(priorStart), end: fmt(priorEnd) },
    dayOfMonth,
    comparison,
  };
}

module.exports = { getMonthlyData, getCurrentPeriodData };

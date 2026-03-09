const axios = require('axios');
const ACCOUNT_MAP = require('./accounts');

// Set of all account names that ACCOUNT_MAP resolves directly from a QBO Section Summary.
// Used by walk() to decide when a Section's Summary is the authoritative total and
// its children should be skipped (prevents double-counting like Civille).
const KNOWN_SUMMARY_ACCOUNTS = new Set(
  Object.values(ACCOUNT_MAP).flatMap(c => [
    ...(c.accounts || []),
    ...(c.expenseAccounts || []),
  ])
);

const QBO_BASE = {
  production: 'https://quickbooks.api.intuit.com',
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
};

// ─── Aggregate raw account map into our series using ACCOUNT_MAP ──────────────
function aggregateSeries(accountValues, expenseValues = {}) {
  const result = {};
  for (const [key, config] of Object.entries(ACCOUNT_MAP)) {
    if (config.type === 'derived') continue;
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
  // Compute derived series after all source series are resolved
  for (const [key, config] of Object.entries(ACCOUNT_MAP)) {
    if (config.type !== 'derived') continue;
    const sum = (config.sources || []).reduce((acc, src) => acc + (result[src] || 0), 0);
    result[key] = Math.round(sum * 100) / 100;
  }
  return result;
}

// ─── Fetch a P&L report for a date range ─────────────────────────────────────
async function fetchPL(tokens, realmId, startDate, endDate, columns = 'month', accountingMethod = 'Accrual') {
  const env = process.env.QBO_ENVIRONMENT || 'production';
  const base = QBO_BASE[env];

  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    accounting_method: accountingMethod,
  });

  if (columns === 'month') params.set('summarize_column_by', 'Month');

  const url = `${base}/v3/company/${realmId}/reports/ProfitAndLoss?${params}`;

  const res = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: 'application/json',
    },
  });

  return res.data;
}

// ─── /api/monthly — full historical P&L by month ─────────────────────────────
// Returns { months: [...], series: { civille: [...], ... } }
async function getMonthlyData(tokens, realmId, accountingMethod = 'Accrual') {
  const start = '2024-01-01';
  const today = new Date();
  const end = today.toISOString().split('T')[0];

  const pl = await fetchPL(tokens, realmId, start, end, 'month', accountingMethod);

  const cols = pl.Columns?.Column || [];

  // Determine ColData offset for value extraction.
  // QBO sometimes includes an Account-type column as Columns.Column[0].
  // When it does, ColData[k] maps to Columns.Column[k] directly (offset 0).
  // When there is no Account column, ColData[0] is an implicit row label and
  // ColData[k+1] maps to Columns.Column[k] (offset 1).
  const hasAccountCol = cols.some(c => c.ColType === 'Account');
  const colDataOffset = hasAccountCol ? 0 : 1;

  // All Money columns, preserving original array index and extracting MetaData dates.
  const allMoneyCols = cols
    .map((c, i) => {
      const meta = {};
      (c.MetaData || []).forEach(m => { meta[m.Name] = m.Value; });
      return { idx: i, label: c.ColTitle, type: c.ColType, startDate: meta.StartDate, endDate: meta.EndDate };
    })
    .filter(c => c.type === 'Money');

  // Only keep columns whose start/end are in the same calendar month.
  // YTD/Total columns always span multiple months and are excluded.
  const monthCols = allMoneyCols.filter(c =>
    c.startDate && c.endDate &&
    c.startDate.substring(0, 7) === c.endDate.substring(0, 7)
  );

  const rows = pl.Rows?.Row || [];
  const monthlyIncome = monthCols.map(() => ({}));
  const monthlyExpense = monthCols.map(() => ({}));

  function processRows(rows, section = '') {
    for (const row of rows) {
      if (row.type === 'Section') {
        const sectionName = row.Header?.ColData?.[0]?.value || section;
        const nameLower = sectionName.toLowerCase();
        const isIncome = nameLower.includes('income') ||
                         nameLower.includes('revenue') ||
                         nameLower.includes('sales');
        const isCOGS = !isIncome;
        if (row.Rows?.Row) processRowsInner(row.Rows.Row, isCOGS, sectionName);
      }
    }
  }

  function processRowsInner(rows, isCOGS, parentSection = '') {
    for (const row of rows) {
      if (row.type === 'Section') {
        const sName = row.Header?.ColData?.[0]?.value || '';
        const stillCOGS = isCOGS ||
          sName.toLowerCase().includes('cost of goods') ||
          sName.toLowerCase().includes('offshore labor');

        if (row.Rows?.Row) processRowsInner(row.Rows.Row, stillCOGS, sName);

        // Capture section Summary (e.g. "Total Civille") — rolled-up total
        if (row.Summary?.ColData) {
          const summaryName = row.Summary.ColData[0]?.value;
          if (summaryName) {
            monthCols.forEach((col, i) => {
              const val = parseFloat(row.Summary.ColData[col.idx + colDataOffset]?.value || '0');
              if (stillCOGS) {
                monthlyExpense[i][summaryName] = (monthlyExpense[i][summaryName] || 0) + val;
              } else {
                monthlyIncome[i][summaryName] = (monthlyIncome[i][summaryName] || 0) + val;
              }
            });
          }
        }
      }

      if (row.type === 'Data' && row.ColData) {
        const name = row.ColData[0]?.value;
        if (!name) continue;
        monthCols.forEach((col, i) => {
          const val = parseFloat(row.ColData[col.idx + colDataOffset]?.value || '0');
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

  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmtLabel = isoDate => {
    if (!isoDate) return null;
    const [year, mon] = isoDate.split('-');
    return `${MONTH_NAMES[parseInt(mon, 10) - 1]} ${year}`;
  };

  const months = [];
  const seriesArrays = {};
  for (const key of Object.keys(ACCOUNT_MAP)) seriesArrays[key] = [];

  monthCols.forEach((col, i) => {
    const label = fmtLabel(col.startDate) || col.label;
    months.push(label);
    const agg = aggregateSeries(monthlyIncome[i], monthlyExpense[i]);
    for (const key of Object.keys(ACCOUNT_MAP)) {
      seriesArrays[key].push(agg[key] ?? null);
    }
  });

  return { months, series: seriesArrays };
}

// ─── /api/current-period — MTD comparison ────────────────────────────────────
// Returns current month MTD vs same days in prior month, per product line
async function getCurrentPeriodData(tokens, realmId, accountingMethod = 'Accrual') {
  const today = new Date();
  const dayOfMonth = today.getDate();

  const curStart  = new Date(today.getFullYear(), today.getMonth(), 1);
  const curEnd    = today;
  const priorStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const priorEnd   = new Date(today.getFullYear(), today.getMonth() - 1, dayOfMonth);

  const fmt = d => d.toISOString().split('T')[0];

  const [curPL, priorPL] = await Promise.all([
    fetchPL(tokens, realmId, fmt(curStart), fmt(curEnd), 'total', accountingMethod),
    fetchPL(tokens, realmId, fmt(priorStart), fmt(priorEnd), 'total', accountingMethod),
  ]);

  function extractTotals(pl) {
    const income = {}, expense = {};
    function walk(rows, inCOGS) {
      for (const row of rows) {
        if (row.type === 'Section') {
          const sName = row.Header?.ColData?.[0]?.value || '';
          const nowCOGS = inCOGS ||
            sName.toLowerCase().includes('cost of goods') ||
            sName.toLowerCase().includes('offshore labor');

          const summaryName = row.Summary?.ColData?.[0]?.value;

          if (summaryName && KNOWN_SUMMARY_ACCOUNTS.has(summaryName)) {
            // This Section's Summary is a recognized account name (e.g. "Total Civille").
            // Use the Summary as the authoritative total and skip children entirely —
            // recursing would double-count individual Data rows already rolled up here.
            //
            // For income: first-wins. QBO can emit the same Summary name multiple times
            // (e.g. "Total Civille" for the real income entry AND as expense-allocation
            // sub-sections under Merchant fees, Payroll, etc.). The correct income value
            // always appears first in depth-first traversal; later duplicates are skipped.
            const val = parseFloat(row.Summary.ColData[1]?.value || '0');
            if (nowCOGS) {
              expense[summaryName] = val;
            } else if (income[summaryName] === undefined) {
              income[summaryName] = val;
            }
          } else {
            // Unrecognized section (e.g. "Income", "Cost of Goods Sold"): recurse normally
            // to find leaf account values and Data rows within it.
            if (row.Rows?.Row) walk(row.Rows.Row, nowCOGS);
            if (summaryName) {
              const val = parseFloat(row.Summary.ColData[1]?.value || '0');
              if (nowCOGS) expense[summaryName] = (expense[summaryName] || 0) + val;
              else income[summaryName] = (income[summaryName] || 0) + val;
            }
          }
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

  const cur   = extractTotals(curPL);
  const prior = extractTotals(priorPL);

  const currentSeries = aggregateSeries(cur.income, cur.expense);
  const priorSeries   = aggregateSeries(prior.income, prior.expense);

  const comparison = {};
  for (const [key, config] of Object.entries(ACCOUNT_MAP)) {
    const current  = currentSeries[key] || 0;
    const previous = priorSeries[key]   || 0;
    const delta    = Math.round((current - previous) * 100) / 100;
    comparison[key] = { label: config.label, color: config.color, current, previous, delta };
  }

  return {
    currentPeriod: { start: fmt(curStart), end: fmt(curEnd) },
    priorPeriod:   { start: fmt(priorStart), end: fmt(priorEnd) },
    dayOfMonth,
    comparison,
  };
}

module.exports = { getMonthlyData, getCurrentPeriodData };

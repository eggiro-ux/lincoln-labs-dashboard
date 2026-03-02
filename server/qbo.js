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
  // End at last day of previous month so QBO never returns a partial current-month
  // column. new Date(year, month, 0) gives the last day of the previous month.
  const start = '2024-01-01';
  const today = new Date();
  const lastDayPrevMonth = new Date(today.getFullYear(), today.getMonth(), 0);
  const end = lastDayPrevMonth.toISOString().split('T')[0];
  const todayStr = today.toISOString().split('T')[0];

  const pl = await fetchPL(tokens, realmId, start, end, 'month');

  // Extract column headers (month labels)
  const cols = pl.Columns?.Column || [];

  // Log every column as full JSON so we can see exactly what the Total column looks like
  console.log(`[MONTHLY] Raw column count: ${cols.length}`);
  cols.forEach(c => console.log('[COL]', JSON.stringify(c)));

  // All Money columns, preserving original array index and extracting MetaData dates.
  // idx is used as row.ColData[col.idx + 1] so must stay relative to original cols array.
  const allMoneyCols = cols
    .map((c, i) => {
      const meta = {};
      (c.MetaData || []).forEach(m => { meta[m.Name] = m.Value; });
      return { idx: i, label: c.ColTitle, type: c.ColType, startDate: meta.StartDate, endDate: meta.EndDate };
    })
    .filter(c => c.type === 'Money');

  // Safety net: QBO places the YTD Total as the last Money column.
  // If its title doesn't match the strict "MMM YYYY" pattern, flag it for
  // unconditional exclusion regardless of whether other filters also catch it.
  const MONTH_TITLE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+20\d{2}$/;
  const lastMoney = allMoneyCols[allMoneyCols.length - 1];
  const totalColIdx = (lastMoney && !MONTH_TITLE.test(lastMoney.label)) ? lastMoney.idx : -1;
  if (totalColIdx >= 0) {
    console.log(`[MONTHLY] Safety net: excluding last Money col idx=${totalColIdx} label="${lastMoney.label}"`);
  }

  // Keep only columns that:
  //   1. Are not the safety-net Total column
  //   2. Have a year in the label (primary month filter)
  //   3. Have MetaData EndDate strictly before today — a completed month's last day
  //      is always before today; any partial month or YTD Total whose EndDate
  //      equals today (when end_date was today) is excluded here.
  const monthCols = allMoneyCols.filter(c =>
    c.idx !== totalColIdx &&
    /\b20\d{2}\b/.test(c.label) &&
    (!c.endDate || c.endDate < todayStr)
  );

  console.log('[MONTHLY] Included month columns:', JSON.stringify(monthCols));
  console.log('[MONTHLY] Excluded columns:', JSON.stringify(
    allMoneyCols.filter(c => !monthCols.includes(c))
  ));

  // Build per-month account values
  const rows = pl.Rows?.Row || [];
  console.log('[MONTHLY] Top-level row count:', rows.length);
  console.log('[MONTHLY] Top-level row types/headers:', rows.map(r => ({
    type: r.type,
    header: r.Header?.ColData?.[0]?.value,
  })));

  const monthlyIncome = monthCols.map(() => ({}));
  const monthlyExpense = monthCols.map(() => ({}));

  // Collect every unique account name seen, for name-matching diagnostics
  const allSeenIncomeNames = new Set();
  const allSeenExpenseNames = new Set();

  function processRows(rows, section = '') {
    for (const row of rows) {
      if (row.type === 'Section') {
        const sectionName = row.Header?.ColData?.[0]?.value || section;
        const isCOGS = sectionName.toLowerCase().includes('cost of goods') ||
                       sectionName.toLowerCase().includes('offshore labor');
        console.log(`[MONTHLY] Entering section "${sectionName}" isCOGS=${isCOGS}, child rows: ${row.Rows?.Row?.length ?? 0}`);
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

        // Recurse into child rows
        if (row.Rows?.Row) {
          console.log(`[MONTHLY]   Sub-section "${sName}" under "${parentSection}" isCOGS=${stillCOGS}, child rows: ${row.Rows.Row.length}`);
          processRowsInner(row.Rows.Row, stillCOGS, sName);
        }

        // Capture the section Summary (e.g. "Total for Civille") — QBO puts the
        // rolled-up total here, separate from the individual Data rows inside Rows.
        if (row.Summary?.ColData) {
          const summaryName = row.Summary.ColData[0]?.value;
          if (summaryName) {
            const firstColRaw = monthCols[0] ? row.Summary.ColData[monthCols[0].idx + 1] : null;
            console.log(`[MONTHLY]   Summary "${summaryName}" under "${parentSection}" isCOGS=${stillCOGS} | firstMonthCol="${firstColRaw?.value}"`);
            monthCols.forEach((col, i) => {
              const val = parseFloat(row.Summary.ColData[col.idx + 1]?.value || '0');
              if (stillCOGS) {
                monthlyExpense[i][summaryName] = (monthlyExpense[i][summaryName] || 0) + val;
                allSeenExpenseNames.add(summaryName);
              } else {
                monthlyIncome[i][summaryName] = (monthlyIncome[i][summaryName] || 0) + val;
                allSeenIncomeNames.add(summaryName);
              }
            });
          }
        }
      }

      if (row.type === 'Data' && row.ColData) {
        const name = row.ColData[0]?.value;
        if (!name) continue;
        const firstColRaw = monthCols[0] ? row.ColData[monthCols[0].idx + 1] : null;
        console.log(`[MONTHLY]   Data row "${name}" under "${parentSection}" isCOGS=${isCOGS} | ColData length=${row.ColData.length} | firstMonthCol idx=${monthCols[0]?.idx} → ColData[${monthCols[0]?.idx}+1]="${firstColRaw?.value}"`);
        monthCols.forEach((col, i) => {
          const val = parseFloat(row.ColData[col.idx + 1]?.value || '0');
          if (isCOGS) {
            monthlyExpense[i][name] = (monthlyExpense[i][name] || 0) + val;
            allSeenExpenseNames.add(name);
          } else {
            monthlyIncome[i][name] = (monthlyIncome[i][name] || 0) + val;
            allSeenIncomeNames.add(name);
          }
        });
      }
    }
  }

  processRows(rows);

  console.log('[MONTHLY] === ALL SEEN INCOME ACCOUNT NAMES ===');
  console.log([...allSeenIncomeNames].sort().join('\n'));
  console.log('[MONTHLY] === ALL SEEN EXPENSE ACCOUNT NAMES ===');
  console.log([...allSeenExpenseNames].sort().join('\n'));

  // Log the first month's raw extracted maps so we can see actual values
  if (monthlyIncome[0]) {
    console.log('[MONTHLY] First month income map:', JSON.stringify(monthlyIncome[0]));
    console.log('[MONTHLY] First month expense map:', JSON.stringify(monthlyExpense[0]));
  }

  // monthCols already contains only fully completed months (partial month and YTD
  // Total were excluded above). Build the series directly from monthCols.
  const months = monthCols.map(col => col.label);
  const seriesArrays = {};
  for (const key of Object.keys(ACCOUNT_MAP)) seriesArrays[key] = [];

  monthCols.forEach((col, i) => {
    const agg = aggregateSeries(monthlyIncome[i], monthlyExpense[i]);
    if (i === 0) {
      console.log('[MONTHLY] First completed month aggregated series:', JSON.stringify(agg));
      for (const [key, config] of Object.entries(ACCOUNT_MAP)) {
        const found = config.accounts.map(a => `"${a}"=${monthlyIncome[i][a] ?? 'MISSING'}`);
        const foundExp = (config.expenseAccounts || []).map(a => `"${a}"=${monthlyExpense[i][a] ?? 'MISSING'}`);
        console.log(`[MONTHLY] Key "${key}": income[${found.join(', ')}]${foundExp.length ? ` expense[${foundExp.join(', ')}]` : ''} → ${agg[key]}`);
      }
    }
    for (const key of Object.keys(ACCOUNT_MAP)) {
      seriesArrays[key].push(agg[key] ?? null);
    }
  });

  console.log('[MONTHLY] Completed months count:', months.length, '| months:', months);

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

  // Full raw dump so we can see the exact QBO section/row structure
  console.log('[PERIOD] === RAW CURRENT PERIOD Rows ===');
  console.log(JSON.stringify(curPL.Rows, null, 2));

  function extractTotals(pl) {
    const income = {}, expense = {};
    function walk(rows, inCOGS) {
      for (const row of rows) {
        if (row.type === 'Section') {
          const sName = row.Header?.ColData?.[0]?.value || '';
          const nowCOGS = inCOGS ||
            sName.toLowerCase().includes('cost of goods') ||
            sName.toLowerCase().includes('offshore labor');

          // Recurse into child rows
          if (row.Rows?.Row) walk(row.Rows.Row, nowCOGS);

          // Capture section Summary (e.g. "Total for Civille") — rolled-up total
          // QBO keeps this separate from the individual Data rows inside Rows.
          if (row.Summary?.ColData) {
            const summaryName = row.Summary.ColData[0]?.value;
            const val = parseFloat(row.Summary.ColData[1]?.value || '0');
            if (summaryName) {
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

  const cur = extractTotals(curPL);
  const prior = extractTotals(priorPL);

  console.log('[PERIOD] === CURRENT PERIOD INCOME ACCOUNTS ===');
  console.log(JSON.stringify(cur.income, null, 2));
  console.log('[PERIOD] === CURRENT PERIOD EXPENSE ACCOUNTS ===');
  console.log(JSON.stringify(cur.expense, null, 2));
  console.log('[PERIOD] === PRIOR PERIOD INCOME ACCOUNTS ===');
  console.log(JSON.stringify(prior.income, null, 2));
  console.log('[PERIOD] === PRIOR PERIOD EXPENSE ACCOUNTS ===');
  console.log(JSON.stringify(prior.expense, null, 2));

  const currentSeries = aggregateSeries(cur.income, cur.expense);
  const priorSeries = aggregateSeries(prior.income, prior.expense);

  console.log('[PERIOD] Current series aggregated:', JSON.stringify(currentSeries));
  console.log('[PERIOD] Prior series aggregated:', JSON.stringify(priorSeries));

  // For each key, show which source accounts were found vs. missing
  for (const [key, config] of Object.entries(ACCOUNT_MAP)) {
    const found = config.accounts.map(a => `"${a}"=${cur.income[a] ?? 'MISSING'}`);
    const foundExp = (config.expenseAccounts || []).map(a => `"${a}"=${cur.expense[a] ?? 'MISSING'}`);
    console.log(`[PERIOD] Key "${key}": income[${found.join(', ')}]${foundExp.length ? ` expense[${foundExp.join(', ')}]` : ''} → current=${currentSeries[key]}`);
  }

  // Build comparison per product line
  const comparison = {};
  for (const [key, config] of Object.entries(ACCOUNT_MAP)) {
    const current = currentSeries[key] || 0;
    const previous = priorSeries[key] || 0;
    const delta = Math.round((current - previous) * 100) / 100;
    comparison[key] = { label: config.label, color: config.color, current, previous, delta };
  }

  console.log('[PERIOD] Final comparison:', JSON.stringify(comparison));

  return {
    currentPeriod: { start: fmt(curStart), end: fmt(curEnd) },
    priorPeriod: { start: fmt(priorStart), end: fmt(priorEnd) },
    dayOfMonth,
    comparison,
  };
}

module.exports = { getMonthlyData, getCurrentPeriodData };

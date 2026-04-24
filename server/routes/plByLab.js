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

// ── Lab matching ──────────────────────────────────────────────────────────────
// Phantom Copy is a sub-account of Civille — rolls up into Civille.
function matchLab(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/awesome/.test(t))    return 'AwesomeAPI';
  if (/phantom/.test(t))    return 'Civille';   // Phantom Copy is a Civille sub-account
  if (/civille/.test(t))    return 'Civille';
  if (/\bkansas\b/.test(t)) return 'Civille';   // Office Rent - Kansas → Civille
  if (/back.?owed/.test(t)) return 'Lincoln Labs'; // Back-Owed Rent → Lincoln Labs
  if (/lincoln/.test(t))    return 'Lincoln Labs';
  if (/overseas/.test(t))   return 'Truss';     // Overseas Rent & Utilities → Truss
  if (/accomplice/.test(t)) return 'Truss';     // Accomplice is a Truss product line
  if (/\btruss\b/.test(t))  return 'Truss';
  if (/\bapps?\b/.test(t))  return 'Apps';
  return null;
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
function parsePL(pl) {
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

  const getVals = (colData) =>
    monthCols.map(col => parseFloat(colData[col.idx + colDataOffset]?.value || '0'));

  // ── Accumulator structures ─────────────────────────────────────────────────

  // fullPLRows: array of { label, values, type }
  const fullPLRows = [];

  // Per-lab row accumulators
  const LAB_NAMES = ['Civille', 'Truss', 'AwesomeAPI', 'Apps', 'Lincoln Labs'];
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
  function routeDataRow(topSectionType, displayLabel, parentSectionName, rowLabel, vals, groupName) {
    const lab = matchLab(displayLabel) || matchLab(parentSectionName) || matchLab(rowLabel);
    if (topSectionType === 'income') {
      // Unmatched income defaults to Lincoln Labs (catch-all for misc. company income)
      const incLab = lab || 'Lincoln Labs';
      labIncome[incLab] = labIncome[incLab] || [];
      labIncome[incLab].push({ label: displayLabel, values: vals });
      if (buRevByMonth[incLab]) {
        for (let i = 0; i < N; i++) buRevByMonth[incLab][i] += vals[i];
      }
      for (let i = 0; i < N; i++) sumIncome[i] += vals[i];
    } else if (topSectionType === 'cogs') {
      if (lab) {
        labCOGS[lab] = labCOGS[lab] || [];
        labCOGS[lab].push({ label: displayLabel, values: vals });
      } else {
        unassignedExpenses.push({ label: displayLabel, values: vals });
      }
      for (let i = 0; i < N; i++) sumCOGS[i] += vals[i];
    } else {
      // expenses — do NOT accumulate sumExpenses here (top-level totals used)
      // Store group metadata so buildLabRows can emit collapsible sections
      if (lab) {
        labExpenses[lab] = labExpenses[lab] || [];
        labExpenses[lab].push({ label: displayLabel, values: vals, group: groupName, subLabel: parentSectionName });
      } else {
        unassignedExpenses.push({ label: displayLabel, values: vals, group: groupName, subLabel: parentSectionName });
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
            const displayLabel = buildLabel(parentSectionName, header);
            fullPLRows.push({ label: displayLabel, values: headerVals, type: 'row' });
            routeDataRow(topSectionType, displayLabel, parentSectionName, header, headerVals, currentGroup);
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
        const vals         = getVals(row.ColData);
        const displayLabel = buildLabel(parentSectionName, rowLabel);

        fullPLRows.push({ label: displayLabel, values: vals, type: 'row' });

        if (vals.some(v => v !== 0)) {
          routeDataRow(topSectionType, displayLabel, parentSectionName, rowLabel, vals, groupName);
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
  const otherRev          = sumRows(unassignedIncome);
  const otherRevTotal     = otherRev.reduce((a, b) => a + b, 0);
  const unassignedNetIncome = otherRevTotal - unassignedExpForBU;

  const buRows = [
    makeRevRow('Civille', civilleRev, labCOGS['Civille'] || [], labExpenses['Civille'] || []),
    { name: 'Truss', monthRevenue: trussEconRevMo, totalRevenue: trussEconRevTotal,
      totalCOGS: 0, grossProfit: trussEconRevTotal, gmPct: null,
      totalExpenses: trussBUExpTotal, netIncome: trussBUNetIncome, netMarginPct: trussBUMarginPct },
    makeRevRow('AwesomeAPI', awesomeRev, labCOGS['AwesomeAPI'] || [], labExpenses['AwesomeAPI'] || []),
    makeRevRow('Apps', appsRev, labCOGS['Apps'] || [], labExpenses['Apps'] || []),
    makeRevRow('Lincoln Labs Co.', llRev, labCOGS['Lincoln Labs'] || [], labExpenses['Lincoln Labs'] || []),
    { name: 'Unassigned / Other', monthRevenue: otherRev, totalRevenue: otherRevTotal,
      totalCOGS: 0, grossProfit: otherRevTotal, gmPct: null,
      totalExpenses: unassignedExpForBU,
      netIncome: unassignedNetIncome,
      netMarginPct: otherRevTotal ? parseFloat((unassignedNetIncome / otherRevTotal * 100).toFixed(1)) : null,
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
    incRows.forEach(r => rows.push({ label: r.label, values: r.values, type: 'row' }));
    const totalInc = sumRows(incRows);
    rows.push({ label: 'Total Income', values: totalInc, type: 'total_income' });

    // COGS
    if (cogsRows.length > 0) {
      rows.push({ label: 'COST OF GOODS SOLD', type: 'section_header' });
      cogsRows.forEach(r => rows.push({ label: r.label, values: r.values, type: 'row' }));
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
      ungrouped.forEach(r => rows.push({ label: r.label, values: r.values, type: 'row' }));

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
            label:   useSub ? r.subLabel : r.label,
            values:  r.values,
            type:    'group_child',
            groupId: grpId,
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
    const netOp    = gp - totalExp;

    return { revenue: totalInc, cogs: totalCgs, grossProfit: gp, gmPct, totalExpenses: totalExp, netOpIncome: netOp };
  }

  // Truss special KPIs
  function trussKPIs() {
    const serviceFees = sumRows(trussServiceFees).reduce((a,b)=>a+b,0);
    const passThrough = sumRows(trussPassThrough).reduce((a,b)=>a+b,0);
    const totalRev    = serviceFees + passThrough;
    const totalCgs    = sumRows(labCOGS['Truss'] || []).reduce((a,b)=>a+b,0);
    const gp          = totalRev - totalCgs;
    const gmPct       = totalRev ? parseFloat((gp / totalRev * 100).toFixed(1)) : null;
    return {
      totalRevenue:    totalRev,
      serviceFeesRev:  serviceFees,
      passThroughRev:  passThrough,
      totalCOGS:       totalCgs,
      grossProfit:     gp,
      gmPct,
    };
  }

  // Truss P&L rows (all income combined, then all COGS, then expenses)
  function trussRows() {
    const allInc   = (labIncome['Truss'] || []);
    const cogsRows = (labCOGS['Truss']   || []);
    const expRows  = (labExpenses['Truss'] || []);
    const rows = [];

    rows.push({ label: 'INCOME', type: 'section_header' });
    allInc.forEach(r => rows.push({ label: r.label, values: r.values, type: 'row' }));
    const totalInc = sumRows(allInc);
    rows.push({ label: 'Total Income', values: totalInc, type: 'total_income' });

    if (cogsRows.length > 0) {
      rows.push({ label: 'COST OF GOODS SOLD', type: 'section_header' });
      cogsRows.forEach(r => rows.push({ label: r.label, values: r.values, type: 'row' }));
      const totalCOGS = sumRows(cogsRows);
      rows.push({ label: 'Total COGS', values: totalCOGS, type: 'total_cogs' });
      const gp = totalInc.map((v, i) => v - totalCOGS[i]);
      rows.push({ label: 'Gross Profit', values: gp, type: 'gross_profit' });
    }

    if (expRows.length > 0) {
      rows.push({ label: 'OPERATING EXPENSES', type: 'section_header' });
      expRows.forEach(r => rows.push({ label: r.label, values: r.values, type: 'row' }));
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

  return { summary, buRows, fullPLRows, labs, unassigned, N };
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

    const pl = await fetchTotalPL(accessToken, realmId, startDate, endDate, am);
    const { summary, buRows, fullPLRows, labs, unassigned } = parsePL(pl);

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

module.exports = { getPlByLabData };

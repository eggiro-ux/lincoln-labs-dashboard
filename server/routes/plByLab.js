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

function getReportMonths() {
  const today     = new Date();
  const year      = today.getFullYear();
  const thisMonth = today.getMonth() + 1; // 1-indexed
  const months    = [];

  // Completed months (1 through thisMonth-1)
  for (let m = 1; m < thisMonth; m++) {
    const lastDay = new Date(year, m, 0).getDate();
    months.push({
      label:   `${MONTH_ABBR[m - 1]} ${year}`,
      start:   `${year}-${String(m).padStart(2, '0')}-01`,
      end:     `${year}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
      partial: false,
    });
  }

  // Current month as MTD (always include)
  const todayDay = today.getDate();
  const todayStr = `${year}-${String(thisMonth).padStart(2, '0')}-${String(todayDay).padStart(2, '0')}`;
  months.push({
    label:   `${MONTH_ABBR[thisMonth - 1]} ${year}`,
    start:   `${year}-${String(thisMonth).padStart(2, '0')}-01`,
    end:     todayStr,
    partial: true,
  });

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
// Phantom Copy is its OWN lab (not under Civille).
function matchLab(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/awesome/.test(t))    return 'AwesomeAPI';
  if (/phantom/.test(t))    return 'Phantom Copy';
  if (/civille/.test(t))    return 'Civille';
  if (/lincoln/.test(t))    return 'Lincoln Labs';
  if (/\btruss\b/.test(t))  return 'Truss';
  if (/\bapps?\b/.test(t))  return 'Apps';
  // accomplice → unassigned (null)
  return null;
}

// ── Compound label construction ───────────────────────────────────────────────
function buildLabel(parentSectionName, rowLabel) {
  const p = (parentSectionName || '').trim();
  const r = (rowLabel || '').trim();
  if (!p) return r;

  const pl = p.toLowerCase();
  if (pl === 'offshore labor')                   return `Offshore Labor — ${r}`;
  if (pl === 'onshore')                          return `Onshore — ${r}`;
  if (pl.includes('wages'))                      return `Payroll — Wages: ${r}`;
  if (pl.includes('taxes') && pl.includes('payroll')) return `Payroll — Taxes: ${r}`;
  if (pl.includes('health insurance'))           return `Payroll — Health Insurance: ${r}`;
  if (pl.includes('dental') || pl.includes('vision')) return `Payroll — Dental/Vision: ${r}`;
  if (pl.includes('advertising') || pl.includes('marketing')) return `Advertising & Marketing — ${r}`;
  if (pl.includes('internal meetings'))          return `Internal Meetings — ${r}`;
  if (pl.includes('legal') || pl.includes('professional')) return `Legal & Professional — ${r}`;
  if (pl.includes('merchant'))                   return `Merchant Fees — ${r}`;
  if (pl === 'software')                         return `Software — ${r}`;
  if (pl.includes('rent') || pl.includes('lease')) return `Rent — ${r}`;
  if (pl.includes('referral'))                   return `Referral Commissions — ${r}`;
  if (pl === 'lincoln labs')                     return `Lincoln Labs — ${r}`;
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
  const LAB_NAMES = ['Civille', 'Phantom Copy', 'Truss', 'AwesomeAPI', 'Apps', 'Lincoln Labs'];
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
  function walkSection(rows, topSectionType, parentSectionName, depth) {
    for (const row of (rows || [])) {
      if (row.type === 'Section') {
        const header  = row.Header?.ColData?.[0]?.value || '';
        const summary = row.Summary?.ColData?.[0]?.value || '';
        const sName   = header || summary;

        // Emit section header into fullPLRows
        if (header) {
          fullPLRows.push({ label: header, type: 'section_header' });
        }

        // Recurse into children
        if (row.Rows?.Row) {
          walkSection(row.Rows.Row, topSectionType, sName, depth + 1);
        }

        // Emit section summary (subtotal) row
        if (row.Summary?.ColData) {
          const vals    = getVals(row.Summary.ColData);
          const subLbl  = subtotalLabel(sName);
          // Determine row type
          let rowType = 'subtotal';
          const sl = sName.toLowerCase();
          if (sl.includes('income') && depth === 0)        rowType = 'total_income';
          if (sl.includes('cost of goods') || sl === 'cogs') rowType = 'total_cogs';
          if (sl.includes('expense') && depth === 0)       rowType = 'total_expenses';
          if (sl === 'gross profit')                        rowType = 'gross_profit';

          fullPLRows.push({ label: subLbl, values: vals, type: rowType });
        }
      }

      if (row.type === 'Data' && row.ColData) {
        const rowLabel = row.ColData[0]?.value || '';
        const vals     = getVals(row.ColData);

        // Build display label
        const displayLabel = buildLabel(parentSectionName, rowLabel);

        // Classify by lab
        // For income section: match on rowLabel first, then parentSectionName
        // For non-income: match on displayLabel components
        let lab = matchLab(displayLabel) || matchLab(parentSectionName) || matchLab(rowLabel);

        // Emit to fullPLRows
        fullPLRows.push({ label: displayLabel, values: vals, type: 'row' });

        // Route to lab buckets
        if (vals.some(v => v !== 0)) {
          if (topSectionType === 'income') {
            if (lab) {
              labIncome[lab]   = labIncome[lab]   || [];
              labIncome[lab].push({ label: displayLabel, values: vals });
              // Accumulate BU revenue
              if (buRevByMonth[lab]) {
                for (let i = 0; i < N; i++) buRevByMonth[lab][i] += vals[i];
              }
            } else {
              unassignedIncome.push({ label: displayLabel, values: vals });
            }
            for (let i = 0; i < N; i++) sumIncome[i] += vals[i];
          } else if (topSectionType === 'cogs') {
            if (lab) {
              labCOGS[lab] = labCOGS[lab] || [];
              labCOGS[lab].push({ label: displayLabel, values: vals });
            } else {
              // unassigned COGS treated as unassigned expenses for simplicity
              unassignedExpenses.push({ label: displayLabel, values: vals });
            }
            for (let i = 0; i < N; i++) sumCOGS[i] += vals[i];
          } else {
            // expenses
            const expLab = lab;
            if (expLab) {
              labExpenses[expLab] = labExpenses[expLab] || [];
              labExpenses[expLab].push({ label: displayLabel, values: vals });
            } else {
              unassignedExpenses.push({ label: displayLabel, values: vals });
            }
            for (let i = 0; i < N; i++) sumExpenses[i] += vals[i];
          }
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

  function makeRevRow(name, monthRevenue, cogsRows, opts = {}) {
    const totalRevenue = monthRevenue.reduce((a, b) => a + b, 0);
    const totalCOGS    = sumRows(cogsRows).reduce((a, b) => a + b, 0);
    const grossProfit  = totalRevenue - totalCOGS;
    const gmPct        = totalRevenue ? parseFloat((grossProfit / totalRevenue * 100).toFixed(1)) : null;
    return { name, monthRevenue, totalRevenue, totalCOGS, grossProfit, gmPct, ...opts };
  }

  const civilleRev        = sumRows(labIncome['Civille'] || []);
  const phantomRev        = sumRows(labIncome['Phantom Copy'] || []);
  const trussServiceRev   = sumRows(trussServiceFees);
  const trussPassThruRev  = sumRows(trussPassThrough);
  const awesomeRev        = sumRows(labIncome['AwesomeAPI'] || []);
  const appsRev           = sumRows(labIncome['Apps'] || []);
  const llRev             = sumRows(labIncome['Lincoln Labs'] || []);
  const otherRev          = sumRows(unassignedIncome);

  const buRows = [
    makeRevRow('Civille', civilleRev, labCOGS['Civille'] || []),
    makeRevRow('Phantom Copy', phantomRev, labCOGS['Phantom Copy'] || []),
    makeRevRow('Truss (service fees only)', trussServiceRev, [], { trussSubType: 'service_fees' }),
    makeRevRow('Truss (client salaries pass-through)', trussPassThruRev, [], { trussSubType: 'passthrough' }),
    makeRevRow('AwesomeAPI', awesomeRev, labCOGS['AwesomeAPI'] || []),
    makeRevRow('Apps', appsRev, labCOGS['Apps'] || []),
    makeRevRow('Lincoln Labs Co.', llRev, labCOGS['Lincoln Labs'] || []),
    { name: 'Other Income', monthRevenue: otherRev, totalRevenue: otherRev.reduce((a,b)=>a+b,0), totalCOGS: 0, grossProfit: otherRev.reduce((a,b)=>a+b,0), gmPct: null, isOther: true },
  ];

  // Fix Truss COGS distribution for BU rows
  const trussTotalCOGS    = sumRows(labCOGS['Truss'] || []).reduce((a,b)=>a+b,0);
  const trussServiceTotal = trussServiceRev.reduce((a,b)=>a+b,0);
  const trussPassTotal    = trussPassThruRev.reduce((a,b)=>a+b,0);
  const trussTotal        = trussServiceTotal + trussPassTotal;
  if (trussTotal > 0) {
    buRows[2].totalCOGS   = Math.round(trussTotalCOGS * trussServiceTotal / trussTotal);
    buRows[3].totalCOGS   = Math.round(trussTotalCOGS * trussPassTotal    / trussTotal);
    buRows[2].grossProfit = buRows[2].totalRevenue - buRows[2].totalCOGS;
    buRows[3].grossProfit = buRows[3].totalRevenue - buRows[3].totalCOGS;
    buRows[2].gmPct       = buRows[2].totalRevenue ? parseFloat((buRows[2].grossProfit / buRows[2].totalRevenue * 100).toFixed(1)) : null;
    buRows[3].gmPct       = buRows[3].totalRevenue ? parseFloat((buRows[3].grossProfit / buRows[3].totalRevenue * 100).toFixed(1)) : null;
  }

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

    // Expenses
    if (expRows.length > 0) {
      rows.push({ label: 'OPERATING EXPENSES', type: 'section_header' });
      expRows.forEach(r => rows.push({ label: r.label, values: r.values, type: 'row' }));
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

  // Civille tab: includes Phantom Copy
  const civilleWithPhantom = {
    subtitle: 'Including Phantom Copy',
    kpis: labKPIs('Civille', {
      extraIncome:    labIncome['Phantom Copy']   || [],
      extraCOGS:      labCOGS['Phantom Copy']     || [],
      extraExpenses:  labExpenses['Phantom Copy'] || [],
    }),
    rows: buildLabRows('Civille', {
      extraIncome:    labIncome['Phantom Copy']   || [],
      extraCOGS:      labCOGS['Phantom Copy']     || [],
      extraExpenses:  labExpenses['Phantom Copy'] || [],
    }),
  };

  const labs = {
    'Civille':      civilleWithPhantom,
    'Truss':        { subtitle: null, kpis: trussKPIs(), rows: trussRows() },
    'AwesomeAPI':   { subtitle: null, kpis: labKPIs('AwesomeAPI'),   rows: buildLabRows('AwesomeAPI')   },
    'Apps':         { subtitle: null, kpis: labKPIs('Apps'),         rows: buildLabRows('Apps')         },
    'Phantom Copy': { subtitle: null, kpis: labKPIs('Phantom Copy'), rows: buildLabRows('Phantom Copy') },
    'Lincoln Labs': { subtitle: null, kpis: labKPIs('Lincoln Labs'), rows: buildLabRows('Lincoln Labs') },
  };

  // ── Unassigned ─────────────────────────────────────────────────────────────
  const reconciliationItems = unassignedExpenses.filter(r =>
    r.label.toLowerCase().includes('z — over') ||
    r.label.toLowerCase().includes('z - over') ||
    r.label.toLowerCase().includes('qb payment') ||
    r.label.toLowerCase().includes('quickbooks payment')
  );
  const reconciliationTotal = sumRows(reconciliationItems).reduce((a,b)=>a+b,0);

  const untaggedIncomeTotal = sumRows(unassignedIncome).reduce((a,b)=>a+b,0);
  const pureUntaggedExp     = unassignedExpenses.filter(r => !reconciliationItems.includes(r));
  const untaggedExpTotal    = sumRows(pureUntaggedExp).reduce((a,b)=>a+b,0);

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

    const months    = getReportMonths();
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

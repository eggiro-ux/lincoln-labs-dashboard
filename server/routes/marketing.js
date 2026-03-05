'use strict';
// GET /api/marketing-summary
// Fetches HubSpot deals and contacts, transforms them into the shape expected by
// client/marketing/MarketingDash.jsx.  Results are cached for 5 minutes.

const express = require('express');
const router  = express.Router();
const { hubspotDealSearch, hubspotContactSearch } = require('../services/hubspot');
const { cached, bust } = require('../cache');

const PIPELINE  = '705841926';
const STAGE_WON = '1031738768';
const STAGE_LOST = '1031738769';
const TTL_MS    = 5 * 60 * 1000; // 5 minutes

// ── Static channel metadata (editorial content — not stored in HubSpot) ───────
const CHANNEL_META = {
  'Partnerships':   {
    color: '#a855f7',
    sources: 'Grow Law Firm, Clio Portal, Smokeball AU, MeanPug, Atticus',
    note: 'Highest deal volume. Partner-referred contacts arrive with strong intent.',
    verdict: 'Highest total revenue and deal count. Consistent deal flow. Lower relationship age reflects rapid 2025 growth — newer deals, not faster churn.',
    warning: null,
  },
  'Paid Marketing': {
    color: '#22c55e',
    sources: 'FB/Insta Ads, Google Ads, Other',
    note: 'Largest MQL volume. Nurture infrastructure is the key unlock.',
    verdict: 'Largest MQL volume and growing YTD. Lowest win rate — improved nurture sequences and lead scoring would meaningfully lift deal close rate.',
    warning: 'Lowest win rate of any channel. High volume but low conversion efficiency.',
  },
  'Referral':       {
    color: '#f97316',
    sources: 'Client Referral, Internal Referral, Client Upgrade',
    note: 'High-quality channel — highest win rate and above-avg deal size.',
    verdict: 'Best all-around channel. Highest win rate, strong deal size, and above-avg relationship age. Priority for a structured referral program.',
    warning: null,
  },
  'Organic':        {
    color: '#3b82f6',
    sources: 'Search',
    note: 'High-value deals from organic search. Content investment is the primary unlock.',
    verdict: 'High deal value and strong retention. Consistent pipeline. Content investment and site rebuild are the primary unlock.',
    warning: null,
  },
  'Tradeshows':     {
    color: '#e879f9',
    sources: 'WI Small Firm Show, ABA Tech Show, ClioCon, Smokeball AU',
    note: 'Event contacts often close directly without entering MQL/SQL stage.',
    verdict: 'High win rate and longest relationship age among high-volume channels. Strong quality signal — dependent on event calendar.',
    warning: 'No 2026 YTD deals — dependent on event calendar.',
  },
  'Prospecting':    {
    color: '#eab308',
    sources: 'LeadEngine AI, BDR, HeyReach, ZoomInfo',
    note: 'Sales-generated SQLs, not marketing MQLs. Pipeline still maturing.',
    verdict: 'Pipeline is maturing — value depends on sales follow-through as pipeline ages.',
    warning: 'No 2026 YTD closed deals. Pipeline effectiveness still unproven at scale.',
  },
  'Social':         {
    color: '#06b6d4',
    sources: 'Reddit, Facebook',
    note: 'Highest avg deal size of any channel. Path exists but volume not yet established.',
    verdict: 'Highest avg deal size and longest relationship age — but low total deals. Treat as a high-potential, dormant channel.',
    warning: 'Low all-time deal count. Zero 2026 YTD activity. Score reflects quality, not scale.',
  },
  'Email':          {
    color: '#f59e0b',
    sources: 'Email campaigns, sequences',
    note: 'Email-sourced deals.',
    verdict: 'Email-sourced pipeline.',
    warning: null,
  },
};

// Canonical display order
const CHANNEL_ORDER = ['Paid Marketing', 'Partnerships', 'Referral', 'Organic', 'Tradeshows', 'Prospecting', 'Social', 'Email'];
const MONTH_NAMES   = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function meta(ch) {
  return CHANNEL_META[ch] || { color: '#7a7870', sources: '', note: '', verdict: '', warning: null };
}

// ── Date helpers ──────────────────────────────────────────────────────────────
function toDate(str) { return str ? new Date(str) : null; }
function inRange(date, start, end) { return date >= start && date <= end; }
function getYear(str)  { return str ? new Date(str).getFullYear() : null; }

// Strip leading emoji / non-letter characters HubSpot sometimes prepends
// e.g. "🟢Partnerships" → "Partnerships", "🟣Tradeshows" → "Tradeshows"
function normalizeChannel(ch) {
  return (ch || '').replace(/^[^a-zA-Z]+/, '').trim();
}

// ── Group records by channel property ─────────────────────────────────────────
// Deals use `parent_lead_source`; contacts use `parent_lead_channel`.
function groupByChannel(records, prop = 'parent_lead_source') {
  const map = {};
  for (const r of records) {
    const ch = normalizeChannel(r.properties?.[prop]);
    if (!ch) continue;
    if (!map[ch]) map[ch] = [];
    map[ch].push(r);
  }
  return map;
}

// ── Lead series (monthly MQL/SQL counts for 2025 and 2026) ───────────────────
function buildLeadSeries(mqls, sqls) {
  const today        = new Date();
  const currentMonth = today.getMonth(); // 0-indexed

  const mql25 = Array(12).fill(0);
  const sql25 = Array(12).fill(0);
  const mql26 = Array(12).fill(null);
  const sql26 = Array(12).fill(null);

  // Initialise non-null 2026 slots (months up to and including the current month)
  for (let i = 0; i <= currentMonth; i++) { mql26[i] = 0; sql26[i] = 0; }

  for (const c of mqls) {
    const d = toDate(c.properties?.hs_v2_date_entered_marketingqualifiedlead);
    if (!d) continue;
    const m = d.getMonth();
    if (d.getFullYear() === 2025) mql25[m]++;
    if (d.getFullYear() === 2026 && m <= currentMonth) mql26[m]++;
  }
  for (const c of sqls) {
    const d = toDate(c.properties?.hs_v2_date_entered_salesqualifiedlead);
    if (!d) continue;
    const m = d.getMonth();
    if (d.getFullYear() === 2025) sql25[m]++;
    if (d.getFullYear() === 2026 && m <= currentMonth) sql26[m]++;
  }

  return {
    months: MONTH_NAMES,
    mql2025: mql25,
    sql2025: sql25,
    mql2026: mql26,
    sql2026: sql26,
  };
}

// ── Source data for one time period ──────────────────────────────────────────
function buildSourcePeriod(wonDeals, lostDeals, mqls, sqls, startDate, endDate) {
  const wonP  = wonDeals.filter(d  => { const c = toDate(d.properties?.closedate);  return c && inRange(c, startDate, endDate); });
  const lostP = lostDeals.filter(d => { const c = toDate(d.properties?.closedate);  return c && inRange(c, startDate, endDate); });
  const mqlP  = mqls.filter(c => { const cr = toDate(c.properties?.hs_v2_date_entered_marketingqualifiedlead); return cr && inRange(cr, startDate, endDate); });
  const sqlP  = sqls.filter(c => { const cr = toDate(c.properties?.hs_v2_date_entered_salesqualifiedlead);    return cr && inRange(cr, startDate, endDate); });

  const wonByCh  = groupByChannel(wonP);
  const lostByCh = groupByChannel(lostP);
  const mqlByCh  = groupByChannel(mqlP,  'parent_lead_channel');
  const sqlByCh  = groupByChannel(sqlP,  'parent_lead_channel');

  const allChs = new Set([
    ...Object.keys(wonByCh), ...Object.keys(lostByCh),
    ...Object.keys(mqlByCh), ...Object.keys(sqlByCh),
  ]);

  return CHANNEL_ORDER.filter(ch => allChs.has(ch)).map(ch => {
    const won  = wonByCh[ch]  || [];
    const lost = lostByCh[ch] || [];
    const rev  = won.reduce((s, d) => s + (parseFloat(d.properties?.amount) || 0), 0);
    const m    = meta(ch);
    return {
      name: ch, color: m.color,
      mqls: (mqlByCh[ch] || []).length,
      sqls: (sqlByCh[ch] || []).length,
      deals: won.length, revenue: Math.round(rev),
      won: won.length, lost: lost.length,
      sources: m.sources, note: m.note,
    };
  });
}

// ── LTV data (all-time won deals, scored) ─────────────────────────────────────
function buildLtvData(wonDeals, lostDeals) {
  const wonByCh  = groupByChannel(wonDeals);
  const lostByCh = groupByChannel(lostDeals);
  const present  = new Set([...Object.keys(wonByCh), ...Object.keys(lostByCh)]);

  const rows = CHANNEL_ORDER.filter(ch => present.has(ch)).map(ch => {
    const won  = wonByCh[ch]  || [];
    const lost = lostByCh[ch] || [];
    const deals = won.length;
    if (deals === 0) return null;

    const rev      = won.reduce((s, d) => s + (parseFloat(d.properties?.amount) || 0), 0);
    const avg_deal = rev / deals;
    const total    = deals + lost.length;
    const win_rate = total > 0 ? (deals / total) * 100 : 0;

    const daysArr = won
      .filter(d => d.properties?.createdate && d.properties?.closedate)
      .map(d => Math.max(0, (new Date(d.properties.closedate) - new Date(d.properties.createdate)) / 86400000));
    const avg_days = daysArr.length > 0 ? daysArr.reduce((s, v) => s + v, 0) / daysArr.length : 0;

    const y2024 = won.filter(d => getYear(d.properties?.closedate) === 2024).length;
    const y2025 = won.filter(d => getYear(d.properties?.closedate) === 2025).length;
    const y2026 = won.filter(d => getYear(d.properties?.closedate) === 2026).length;

    const m = meta(ch);
    return {
      name: ch, color: m.color,
      deals, rev: Math.round(rev),
      avg_deal: Math.round(avg_deal), win_rate: Math.round(win_rate), avg_days: Math.round(avg_days),
      y2024, y2025, y2026, active_flag: y2026 > 0,
      verdict: m.verdict, warning: y2026 === 0 ? (m.warning || null) : null,
      s_wr: 0, s_deal: 0, s_ret: 0, s_vol: 0, score: 0, // filled below
    };
  }).filter(Boolean);

  const maxWr    = Math.max(...rows.map(r => r.win_rate), 1);
  const maxDeal  = Math.max(...rows.map(r => r.avg_deal), 1);
  const maxDays  = Math.max(...rows.map(r => r.avg_days), 1);
  const maxDeals = Math.max(...rows.map(r => r.deals),    1);

  for (const r of rows) {
    r.s_wr   = Math.round((r.win_rate / maxWr)   * 100);
    r.s_deal = Math.round((r.avg_deal / maxDeal)  * 100);
    r.s_ret  = Math.round((r.avg_days / maxDays)  * 100);
    r.s_vol  = Math.round((r.deals   / maxDeals)  * 100);
    r.score  = Math.round(r.s_wr * 0.30 + r.s_deal * 0.30 + r.s_ret * 0.30 + r.s_vol * 0.10);
  }
  return rows;
}

// ── Current period comparisons ────────────────────────────────────────────────
function buildCurrentPeriod(wonDeals, mqls, sqls) {
  const today = new Date();
  const y = today.getFullYear(), m = today.getMonth(), d = today.getDate();

  function stats(sy, sm, sd, ey, em, ed) {
    const start = new Date(sy, sm, sd);
    const end   = new Date(ey, em, ed, 23, 59, 59);
    const w = wonDeals.filter(x => { const c = toDate(x.properties?.closedate);  return c && inRange(c, start, end); });
    const q = mqls.filter(x     => { const c = toDate(x.properties?.createdate); return c && inRange(c, start, end); });
    const s = sqls.filter(x     => { const c = toDate(x.properties?.createdate); return c && inRange(c, start, end); });
    const rev = w.reduce((sum, x) => sum + (parseFloat(x.properties?.amount) || 0), 0);
    return { mqls: q.length, sqls: s.length, deals: w.length, revenue: Math.round(rev) };
  }

  const prevM    = m === 0 ? 11 : m - 1;
  const prevMY   = m === 0 ? y - 1 : y;
  const prevMEnd = Math.min(d, new Date(prevMY, prevM + 1, 0).getDate());

  return {
    monthToDate: {
      current:   { label: `${MONTH_NAMES[m]} 1–${d}`,                          ...stats(y,    m,    1, y,    m,    d)         },
      lastMonth: { label: `${MONTH_NAMES[prevM]} 1–${prevMEnd}`,               ...stats(prevMY, prevM, 1, prevMY, prevM, prevMEnd) },
      lastYear:  { label: `${MONTH_NAMES[m]} 1–${d} '${String(y-1).slice(2)}`, ...stats(y-1,  m,    1, y-1,  m,    d)         },
    },
    quarters: {
      q1_26_ytd: { label: 'Q1 2026 YTD', sublabel: `Jan 1 – ${MONTH_NAMES[m]} ${d}`, ...stats(2026, 0, 1, y, m, d) },
      q4_25:     { label: 'Q4 2025',     sublabel: 'Oct – Dec',                       ...stats(2025, 9, 1, 2025, 11, 31) },
      q1_25:     { label: 'Q1 2025',     sublabel: 'Jan – Mar',                       ...stats(2025, 0, 1, 2025, 2,  31) },
    },
  };
}

// ── Insight chips ─────────────────────────────────────────────────────────────
function buildInsights(wonDeals, lostDeals, mqls, sqls) {
  const today    = new Date();
  const start26  = new Date(2026, 0, 1);
  const won26    = wonDeals.filter(d => { const c = toDate(d.properties?.closedate); return c && c >= start26; });
  const wonByCh  = groupByChannel(wonDeals);
  const lostByCh = groupByChannel(lostDeals);

  // Largest deal 2026
  const largest26 = won26.reduce((b, d) => {
    const amt = parseFloat(d.properties?.amount) || 0;
    return amt > b.amt ? { amt, name: d.properties?.dealname || '' } : b;
  }, { amt: 0, name: '' });

  // Avg deal size 2026
  const rev26     = won26.reduce((s, d) => s + (parseFloat(d.properties?.amount) || 0), 0);
  const avgDeal26 = won26.length > 0 ? Math.round(rev26 / won26.length) : 0;

  // Best win rate channel (min 3 deals)
  let bestWrCh = '', bestWr = 0;
  for (const ch of CHANNEL_ORDER) {
    const w = (wonByCh[ch] || []).length, l = (lostByCh[ch] || []).length;
    if (w + l < 3) continue;
    const wr = w / (w + l) * 100;
    if (wr > bestWr) { bestWr = wr; bestWrCh = ch; }
  }

  // Best MQL and SQL month
  function bestMonth(contacts, dateProp) {
    const byYM = {};
    for (const c of contacts) {
      const d = toDate(c.properties?.[dateProp]); if (!d) continue;
      const k = `${d.getFullYear()}-${d.getMonth()}`;
      byYM[k] = (byYM[k] || 0) + 1;
    }
    const top = Object.entries(byYM).sort((a, b) => b[1] - a[1])[0];
    if (!top) return { label: '', count: 0 };
    const [yr, mo] = top[0].split('-');
    return { label: `${MONTH_NAMES[+mo]} ${yr}`, count: top[1] };
  }
  const bestMql = bestMonth(mqls, 'hs_v2_date_entered_marketingqualifiedlead');
  const bestSql = bestMonth(sqls, 'hs_v2_date_entered_salesqualifiedlead');

  // Active SQL pipeline 2026
  const sql26Count = sqls.filter(c => { const d = toDate(c.properties?.hs_v2_date_entered_salesqualifiedlead); return d && d >= start26; }).length;

  // Paid marketing win rate
  const paidW = (wonByCh['Paid Marketing'] || []).length;
  const paidL = (lostByCh['Paid Marketing'] || []).length;
  const paidWr = paidW + paidL > 0 ? Math.round(paidW / (paidW + paidL) * 100) : 0;

  // Q1 '26 vs Q4 '25 deals
  const q4start = new Date(2025, 9, 1), q4end = new Date(2025, 11, 31, 23, 59, 59);
  const q4Deals = wonDeals.filter(d => { const c = toDate(d.properties?.closedate); return c && inRange(c, q4start, q4end); }).length;
  const qDelta  = q4Deals > 0 ? Math.round((won26.length - q4Deals) / q4Deals * 100) : 0;

  return [
    { label: 'Largest deal · 2026',    value: `$${largest26.amt.toLocaleString()}`,    sub: largest26.name || '2026 YTD',                   trend: 'up'   },
    { label: 'Best win rate',          value: `${Math.round(bestWr)}%`,                sub: `${bestWrCh} channel · all-time`,               trend: 'up'   },
    { label: 'Avg deal size · 2026',   value: `$${avgDeal26.toLocaleString()}`,         sub: `From ${won26.length} closed deals YTD`,        trend: 'up'   },
    { label: `MQLs · ${bestMql.label}`, value: String(bestMql.count),                  sub: 'Highest single month ever',                    trend: 'up'   },
    { label: `SQLs · ${bestSql.label}`, value: String(bestSql.count),                  sub: 'Highest SQL month on record',                  trend: 'up'   },
    { label: 'Active pipeline · 2026', value: `${sql26Count} SQLs`,                    sub: 'Prospecting channel',                          trend: 'flat' },
    { label: 'Paid mktg win rate',     value: `${paidWr}%`,                            sub: 'Lowest of any channel · high volume',          trend: paidWr < 50 ? 'down' : 'flat' },
    { label: "Q1 '26 vs Q4 '25",      value: `${qDelta >= 0 ? '+' : ''}${qDelta}%`,   sub: `Deals: ${won26.length} vs ${q4Deals} · YTD vs full quarter`, trend: qDelta >= 0 ? 'up' : 'down' },
  ];
}

// ── Top-level builder ─────────────────────────────────────────────────────────
function buildMarketingSummary(wonDeals, lostDeals, mqls, sqls) {
  const today   = new Date();
  const start25 = new Date(2025, 0, 1);
  const end25   = new Date(2025, 11, 31, 23, 59, 59);
  const start26 = new Date(2026, 0, 1);

  return {
    leadSeries:    buildLeadSeries(mqls, sqls),
    sourceData: {
      alltime: buildSourcePeriod(wonDeals, lostDeals, mqls, sqls, new Date('2000-01-01'), today),
      y2025:   buildSourcePeriod(wonDeals, lostDeals, mqls, sqls, start25, end25),
      y2026:   buildSourcePeriod(wonDeals, lostDeals, mqls, sqls, start26, today),
    },
    ltvData:       buildLtvData(wonDeals, lostDeals),
    currentPeriod: buildCurrentPeriod(wonDeals, mqls, sqls),
    insights:      buildInsights(wonDeals, lostDeals, mqls, sqls),
    lastRefresh:   new Date().toISOString(),
  };
}

// ── Route ─────────────────────────────────────────────────────────────────────
router.get('/marketing-summary', async (req, res) => {
  try {
    const summary = await cached('marketing-summary', TTL_MS, async () => {
      const [wonDeals, lostDeals, mqls, sqls] = await Promise.all([
        hubspotDealSearch(
          [
            { propertyName: 'pipeline',  operator: 'EQ', value: PIPELINE  },
            { propertyName: 'dealstage', operator: 'EQ', value: STAGE_WON },
          ],
          ['dealname', 'amount', 'closedate', 'hs_closed_won_date', 'createdate', 'parent_lead_source', 'dealstage', 'pipeline'],
        ),
        hubspotDealSearch(
          [
            { propertyName: 'pipeline',  operator: 'EQ', value: PIPELINE   },
            { propertyName: 'dealstage', operator: 'EQ', value: STAGE_LOST },
          ],
          ['dealname', 'amount', 'closedate', 'createdate', 'parent_lead_source', 'dealstage', 'pipeline'],
        ),
        // HAS_PROPERTY filter only — no lifecyclestage or date range in the API query.
        // HubSpot's date indexes are imprecise when used as filters and cause undercounting.
        // Fetch all contacts who have ever reached this stage, then filter by date in JS.
        hubspotContactSearch(
          [{ propertyName: 'hs_v2_date_entered_marketingqualifiedlead', operator: 'HAS_PROPERTY' }],
          ['hs_v2_date_entered_marketingqualifiedlead', 'parent_lead_channel', 'createdate', 'industry'],
        ),
        hubspotContactSearch(
          [{ propertyName: 'hs_v2_date_entered_salesqualifiedlead', operator: 'HAS_PROPERTY' }],
          ['hs_v2_date_entered_salesqualifiedlead', 'parent_lead_channel', 'createdate', 'industry'],
        ),
      ]);

      // Apply industry filter in JS — keeps API query simple (HAS_PROPERTY only)
      // while still scoping to law firm contacts.
      const LAW_INDUSTRIES = new Set(['Law Practice', 'Legal Partner']);
      const mqlsFiltered = mqls.filter(c => LAW_INDUSTRIES.has(c.properties?.industry));
      const sqlsFiltered = sqls.filter(c => LAW_INDUSTRIES.has(c.properties?.industry));

      return buildMarketingSummary(wonDeals, lostDeals, mqlsFiltered, sqlsFiltered);
    });
    res.json(summary);
  } catch (err) {
    console.error('/api/marketing-summary error:', err.message);
    res.status(500).json({ error: 'Failed to fetch marketing data', detail: err.message });
  }
});

module.exports = router;

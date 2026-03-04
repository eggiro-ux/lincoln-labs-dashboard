const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const QBO_BASE = {
  production: 'https://quickbooks.api.intuit.com',
  sandbox:    'https://sandbox-quickbooks.api.intuit.com',
};

// ─── Anthropic client (created per-request so key changes take effect) ────────
function makeAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Add it to your Railway environment variables.',
    );
  }
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ─── Phase 1 system prompt: decide what QBO calls to make ─────────────────────
function buildPlanningPrompt(accountingMethod = 'Accrual') {
  const today = new Date().toISOString().split('T')[0];
  const [year] = today.split('-');
  return `\
You are a financial data assistant for Lincoln Labs, a technology-services company. \
Given a plain-English question about their QuickBooks Online (QBO) data, produce a JSON \
plan describing which API calls to make and how to visualize the result.

Today's date: ${today}

Lincoln Labs revenue streams (QBO account names):
• Civille + Phantom Copy  →  section summary "Total Civille"
• AwesomeAPI              →  accounts "AwesomeAPI" or "Awesome API"
• Truss Client Salaries   →  income "Truss Client Salaries" MINUS COGS "Truss - Client Salaries Expense"
• Truss Svc Fees + Rec    →  accounts "Truss Service Fees" and "Truss Recruitment"
• Lincoln Labs Total      →  section summary "Total Lincoln Labs"

Available QBO endpoints and their parameters:
1. reports/ProfitAndLoss
   start_date (YYYY-MM-DD), end_date (YYYY-MM-DD), accounting_method ("${accountingMethod}")  ← use this method,
   summarize_column_by ("Month" | "Quarter" | "Year")   ← omit for a single-column total

2. reports/TransactionList
   start_date, end_date, account_type ("Income" | "Expense" | "COGS")

3. reports/AgedReceivableDetail
   as_of_date (YYYY-MM-DD)

4. reports/CustomerBalance
   as_of_date (YYYY-MM-DD)

5. reports/GeneralLedger
   start_date, end_date

6. query  (QBO SQL-like object queries)
   { "query": "SELECT * FROM Invoice WHERE Balance > '0' MAXRESULTS 20" }
   Entities: Invoice, Payment, Bill, Customer, Item, Vendor, Estimate

Return ONLY a JSON object (no markdown, no extra text):
{
  "clarifying_questions": [],
  "qbo_calls": [{"endpoint": "...", "params": {...}}],
  "visualization": "bar",
  "answer_template": "One sentence describing what the answer will show."
}

Rules:
- Put questions in clarifying_questions (and leave qbo_calls empty) ONLY when the question
  is genuinely ambiguous without more detail. Do not ask for info you can infer from context.
- Make at most 3 QBO API calls.
- Default date range: current year ${year}-01-01 through today ${today} unless the user specifies.
- visualization choices:
  "bar"    → compare multiple series across time periods (grouped bars)
  "line"   → a single trend over many months
  "table"  → transaction / invoice lists
  "number" → a single dollar value or count
  "text"   → narrative explanation or when data is not chart-friendly`;
}

// ─── Phase 2 system prompt: interpret QBO results and format the answer ────────
const INTERPRETATION_PROMPT = `\
You are a financial analyst for Lincoln Labs. You have received raw QuickBooks Online API \
results. Extract the relevant data and return a clear, useful answer.

QBO response shapes (so you can parse them correctly):
• ProfitAndLoss with summarize_column_by=Month:
    Columns.Column[k] → time period (ColTitle, MetaData with StartDate/EndDate)
    Rows.Row[] → Section rows (Header, Rows, Summary) and Data rows (ColData).
    In each row, ColData[0].value = label/account name; ColData[k].value = value for Column[k-1]
    (if an Account-type column exists at Column[0], then ColData[k] = value for Column[k]).
    Section Summary rows use Summary.ColData with the same indexing.
    Key account names: "Total Civille", "AwesomeAPI", "Awesome API",
    "Truss Client Salaries", "Truss - Client Salaries Expense",
    "Truss Service Fees", "Truss Recruitment", "Total Lincoln Labs".
• ProfitAndLoss without summarize_column_by: single Money column → ColData[1].value.
• Query results: QueryResponse.Invoice[], .Payment[], .Customer[], etc.
• TransactionList: Rows.Row[] with Data rows.

Lincoln Labs revenue streams:
  Civille + Phantom Copy | AwesomeAPI | Truss Client Salaries delta | Truss Svc Fees + Rec | Lincoln Labs Total

Return ONLY a JSON object (no markdown). Schema by visualization type:

"bar" or "line":
{"visualization":"bar","answer":"1–3 sentence summary","data":[{"label":"Jan 2026","values":{"Civille":45000,"AwesomeAPI":23000}}]}

"table":
{"visualization":"table","answer":"1–3 sentence summary","columns":["Invoice #","Customer","Amount","Date","Status"],"rows":[["INV-001","Acme Corp","$1,234.56","2026-01-15","Unpaid"]]}

"number":
{"visualization":"number","answer":"Brief context sentence.","value":87543.21,"label":"Q1 2026 Total Revenue"}

"text":
{"visualization":"text","answer":"Full explanation, as many sentences as needed."}

Rules:
- For bar/line: include only the accounts that directly answer the question; use clean labels.
- For tables: pick the most useful 4–6 columns; format dollar values as strings with $ and commas.
- For number: value must be a plain JS number (no $).
- Keep "answer" concise (1–3 sentences) except for "text" visualization.
- If results are empty or don't answer the question, use "text" and explain what you found.`;

// ─── Parse JSON from a Claude response that might contain extra prose ──────────
function extractJSON(text) {
  try { return JSON.parse(text.trim()); } catch {}
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (block) try { return JSON.parse(block[1].trim()); } catch {}
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) try { return JSON.parse(obj[0]); } catch {}
  throw new Error('Could not parse JSON from Claude response.');
}

// ─── Execute a single QBO API call ────────────────────────────────────────────
async function executeQBOCall(tokens, realmId, call) {
  const env    = process.env.QBO_ENVIRONMENT || 'production';
  const base   = QBO_BASE[env];
  const headers = {
    Authorization: `Bearer ${tokens.access_token}`,
    Accept: 'application/json',
  };

  if (call.endpoint === 'query') {
    const sql = call.params?.query || '';
    const url = `${base}/v3/company/${realmId}/query?query=${encodeURIComponent(sql)}&minorversion=65`;
    const res = await axios.get(url, { headers });
    return res.data;
  }

  const params = new URLSearchParams(call.params || {});
  const url = `${base}/v3/company/${realmId}/${call.endpoint}?${params}`;
  const res  = await axios.get(url, { headers });
  return res.data;
}

// ─── Trim oversized QBO payloads before sending to Claude ─────────────────────
const MAX_BYTES = 36_000;
function trimResult(result) {
  const json = JSON.stringify(result);
  if (json.length <= MAX_BYTES) return result;
  return {
    _note: `Response trimmed from ${json.length} to ${MAX_BYTES} bytes to fit context window.`,
    _data: json.slice(0, MAX_BYTES),
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────
async function handleAsk(tokens, realmId, question, clarifyingAnswers = null, accountingMethod = 'Accrual') {
  const anthropic  = makeAnthropic();
  const userContent = clarifyingAnswers
    ? `${question}\n\nUser clarification: ${clarifyingAnswers}`
    : question;

  // ── Phase 1: planning ────────────────────────────────────────────────────────
  const planMsg = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 1024,
    system:     buildPlanningPrompt(accountingMethod),
    messages:   [{ role: 'user', content: userContent }],
  });

  const plan = extractJSON(planMsg.content[0].text);

  // Return clarifying questions immediately — do not call QBO yet
  if (plan.clarifying_questions?.length > 0 && !plan.qbo_calls?.length) {
    return { type: 'clarifying', questions: plan.clarifying_questions, question };
  }

  // ── Execute QBO calls ────────────────────────────────────────────────────────
  const qboResults = [];
  for (const call of plan.qbo_calls || []) {
    try {
      const raw = await executeQBOCall(tokens, realmId, call);
      qboResults.push({ call, result: trimResult(raw) });
    } catch (err) {
      qboResults.push({ call, error: err.response?.data || err.message });
    }
  }

  // ── Phase 2: interpretation ──────────────────────────────────────────────────
  const interpMsg = await anthropic.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 2048,
    system:     INTERPRETATION_PROMPT,
    messages: [{
      role: 'user',
      content: [
        `Question: ${userContent}`,
        `Planned visualization: ${plan.visualization}`,
        `Answer template: ${plan.answer_template}`,
        `\nQBO results:\n${JSON.stringify(qboResults, null, 2)}`,
      ].join('\n'),
    }],
  });

  const interp = extractJSON(interpMsg.content[0].text);

  return {
    type:          'answer',
    visualization: interp.visualization || plan.visualization || 'text',
    answer:        interp.answer  || '',
    data:          interp.data    || null,
    columns:       interp.columns || null,
    rows:          interp.rows    || null,
    value:         interp.value   ?? null,
    label:         interp.label   || null,
  };
}

module.exports = { handleAsk };

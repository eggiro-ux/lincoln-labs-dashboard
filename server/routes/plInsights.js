'use strict';
// POST /api/pl-insights — Claude-powered "AI Analysis" for the lab P&L view.
//
// The front-end sends a compact digest of the P&L it already loaded (no extra
// QBO calls), and Claude returns cliff-notes insights: highlights, watch
// items, anomalies, and a bottom line. Responses are cached in memory by
// digest hash so repeated tab clicks within a session don't re-bill.

const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — data only changes when QBO does
const cache = new Map(); // hash → { at, insights }

const SYSTEM_PROMPT = `\
You are the financial analyst for Lincoln Labs, a technology holding company \
with six business units ("labs"): Civille (law-firm websites), Truss (offshore \
staffing — client salary pass-through plus service fees), AwesomeAPI (API \
product), Apps, Lincoln Labs Co. (consulting + corporate), and Caboodle (newly \
acquired, expenses only so far). The owners (Eric and his partner) review \
lab-specific P&Ls where shared expenses are already allocated across labs by \
agreed rules.

You receive a JSON digest of the year-to-date monthly P&L by lab. Produce a \
short, owner-facing analysis. Be specific and quantitative — name the lab, the \
month, and the dollar figure. Focus on what changed, what looks unusual, and \
what deserves attention. Do not restate the whole P&L, do not explain what the \
labs are, and do not hedge.

Truss context: its "revenue" in the digest is economic revenue (pass-through \
salaries netted out), so treat its margins accordingly. The "Unassigned / \
Other" row is excluded bounced-payment reconciliation noise by design — ignore \
it unless it moves materially.

Return ONLY a JSON object, no markdown fences, with this exact shape:
{
  "headline": "one-sentence overall read of the business",
  "highlights": [{"title": "...", "detail": "1-2 sentences with numbers"}],
  "watch": [{"title": "...", "detail": "1-2 sentences with numbers"}],
  "anomalies": [{"title": "...", "detail": "1-2 sentences with numbers"}]
}
3-5 highlights, 2-4 watch items, 0-3 anomalies (only genuinely odd data \
patterns — month-over-month spikes, sign flips, trend breaks).`;

function makeAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set on the server.');
  }
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// Pull the first JSON object out of the model text (mirrors ask.js's parsing).
function parseInsights(text) {
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object in model response');
  return JSON.parse(text.slice(start, end + 1));
}

async function getPlInsights(req, res) {
  try {
    const digest = req.body && req.body.digest;
    if (!digest || typeof digest !== 'object') {
      return res.status(400).json({ error: 'digest (object) is required' });
    }

    const digestJson = JSON.stringify(digest);
    if (digestJson.length > 200_000) {
      return res.status(400).json({ error: 'digest too large' });
    }
    const hash = crypto.createHash('sha256').update(digestJson).digest('hex');

    const hit = cache.get(hash);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return res.json({ insights: hit.insights, cached: true });
    }

    const anthropic = makeAnthropic();
    const response = await anthropic.messages.create({
      model:      'claude-opus-4-8',
      max_tokens: 8000,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: digestJson }],
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
    const insights = parseInsights(text);

    // Evict stale entries opportunistically; the cache stays tiny regardless
    for (const [k, v] of cache) if (Date.now() - v.at > CACHE_TTL_MS) cache.delete(k);
    cache.set(hash, { at: Date.now(), insights });

    console.log(`/api/pl-insights → ${insights.highlights?.length ?? 0} highlights (${response.usage.input_tokens} in / ${response.usage.output_tokens} out tokens)`);
    res.json({ insights, cached: false });
  } catch (err) {
    console.error('/api/pl-insights error:', err.message);
    res.status(500).json({ error: 'Failed to generate insights', detail: err.message });
  }
}

module.exports = { getPlInsights };

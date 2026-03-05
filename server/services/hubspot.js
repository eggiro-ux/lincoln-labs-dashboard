'use strict';
// HubSpot API client — paginated search helpers (Section 3.1 of spec).
// Uses the built-in fetch available in Node 18+.

const HUBSPOT_BASE = 'https://api.hubapi.com';

function authHeaders() {
  return {
    'Authorization': `Bearer ${process.env.HUBSPOT_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Generic paginated CRM search.
 * @param {'deals'|'contacts'} objectType
 * @param {object[]} filters  — flat array; wrapped in one filterGroup
 * @param {string[]} properties
 * @param {number}   limit    — per-page limit (max 200)
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hubspotSearch(objectType, filters, properties, limit = 200) {
  let all = [];
  let after;
  let page = 0;
  do {
    if (page > 0) await sleep(1000); // avoid 429 on multi-page fetches
    const body = { filterGroups: [{ filters }], properties, limit };
    if (after) body.after = after;
    const res = await fetch(`${HUBSPOT_BASE}/crm/v3/objects/${objectType}/search`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HubSpot ${objectType} search ${res.status}: ${text}`);
    }
    const data = await res.json();
    all = all.concat(data.results || []);
    after = data.paging?.next?.after;
    page++;
  } while (after);
  return all;
}

async function hubspotDealSearch(filters, properties, limit = 200) {
  return hubspotSearch('deals', filters, properties, limit);
}

async function hubspotContactSearch(filters, properties, limit = 200) {
  return hubspotSearch('contacts', filters, properties, limit);
}

module.exports = { hubspotDealSearch, hubspotContactSearch };

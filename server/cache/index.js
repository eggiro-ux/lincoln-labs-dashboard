'use strict';
// Simple in-process TTL cache — lives for the lifetime of the Node process.
// On Railway, each deploy starts fresh, so the cache is always warm on first request.

const store = new Map();

/**
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => Promise<any>} fetchFn  called only on cache miss
 */
function cached(key, ttlMs, fetchFn) {
  const hit = store.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return Promise.resolve(hit.data);
  return fetchFn().then(data => {
    store.set(key, { data, ts: Date.now() });
    return data;
  });
}

function bust(key) {
  store.delete(key);
}

function bustAll() {
  store.clear();
}

module.exports = { cached, bust, bustAll };

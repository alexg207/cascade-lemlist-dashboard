// Lightweight in-memory cache for API responses.
//
// HONEST NOTE ON VERCEL: this Map lives in a single serverless instance and only
// survives warm invocations. A cold start is a cache miss — same latency as no
// cache, never worse. The guaranteed fast-paint UX comes from (a) the client-side
// localStorage snapshot in the frontend and (b) CDN Cache-Control headers on the
// open (password-less) demo. This layer's real job is de-duping concurrent hits
// and smoothing bursts within a warm instance.

const { thresholds } = require('./config');

const DEFAULT_TTL_MS = (thresholds.cacheTtlSeconds || 300) * 1000;
const store = new Map(); // key -> { data, fetchedAt, inflight }

// cached(key, fetcher, { ttlMs, fresh })
// - fresh hit (< ttl): returns cached data instantly
// - miss/expired: awaits fetcher; concurrent callers share one inflight promise
// - fetcher throws but a stale entry exists: serves stale (flagged via meta)
// - fresh:true: bypasses the cache and repopulates it
async function cached(key, fetcher, opts = {}) {
  const ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
  const now = Date.now();
  const entry = store.get(key);

  if (!opts.fresh && entry && !entry.inflight && (now - entry.fetchedAt) < ttlMs) {
    return { data: entry.data, fetchedAt: entry.fetchedAt, stale: false };
  }

  if (entry && entry.inflight) {
    // Someone is already fetching this key — piggyback on their request.
    const data = await entry.inflight;
    return { data, fetchedAt: store.get(key)?.fetchedAt || now, stale: false };
  }

  const inflight = (async () => fetcher())();
  store.set(key, { ...(entry || {}), inflight });

  try {
    const data = await inflight;
    store.set(key, { data, fetchedAt: Date.now(), inflight: null });
    return { data, fetchedAt: Date.now(), stale: false };
  } catch (e) {
    // On failure, serve stale data if we have any; otherwise propagate.
    if (entry && entry.data !== undefined) {
      store.set(key, { data: entry.data, fetchedAt: entry.fetchedAt, inflight: null });
      return { data: entry.data, fetchedAt: entry.fetchedAt, stale: true };
    }
    store.delete(key);
    throw e;
  }
}

module.exports = { cached, DEFAULT_TTL_MS };

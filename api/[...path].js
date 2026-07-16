// Vercel serverless catch-all for /api/*.
//
// Transport only — CORS, auth, cache headers, serialisation. All data logic
// lives in lib/handlers.js, shared verbatim with server.js (local dev), so the
// two behave identically.

const { dispatch, HttpError } = require('../lib/handlers');
const { isDemoMode } = require('../lib/demo');

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

module.exports = async (req, res) => {
  const origin = req.headers.origin;
  if (origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'x-dashboard-key, content-type');
  }
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // Vercel exposes catch-all segments at req.query.path as an array.
  const segments = Array.isArray(req.query?.path) ? req.query.path : (req.query?.path ? [req.query.path] : []);
  const apiPath = '/' + segments.join('/');

  // /config is public (the gate screen needs branding before auth). Everything
  // else is gated when a password is configured.
  if (DASHBOARD_PASSWORD && apiPath !== '/config') {
    const provided = req.headers['x-dashboard-key'] || req.query?.key || '';
    if (!provided || !timingSafeEqual(String(provided), DASHBOARD_PASSWORD)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
  }

  // Cache-Control: never let a CDN cache authorised responses (data-leak footgun).
  // Only the open (password-less) demo gets shared CDN caching.
  if (DASHBOARD_PASSWORD) {
    res.setHeader('Cache-Control', 'private, no-store');
  } else if (isDemoMode()) {
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
  }

  try {
    const { status, body, fetchedAt } = await dispatch(apiPath, req.query || {});
    if (fetchedAt) res.setHeader('x-data-fetched-at', new Date(fetchedAt).toISOString());
    res.status(status).json(body);
  } catch (e) {
    if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return; }
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};

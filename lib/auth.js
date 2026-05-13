function checkAuth(req, res) {
  const required = process.env.DASHBOARD_PASSWORD;
  if (!required) return true; // No password set → open (local dev)
  const provided = req.headers['x-dashboard-key']
    || (req.query && req.query.key)
    || extractCookie(req, 'cascade_key');
  if (provided && timingSafeEqual(String(provided), required)) return true;
  res.status(401).setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'unauthorized' }));
  return false;
}

function extractCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v || '');
  }
  return '';
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

module.exports = { checkAuth };

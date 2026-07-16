// Local dev server. Transport only — static files + /api/* dispatch into the
// shared lib/handlers.js (identical logic to the Vercel catch-all api/[...path].js).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { dispatch, HttpError } = require('./lib/handlers');
const { isDemoMode } = require('./lib/demo');

const PORT = process.env.PORT || 3100;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';

// A real key is required unless we're serving baked demo fixtures.
if (!process.env.LEMLIST_API_KEY && !isDemoMode()) {
  console.error('ERROR: Set your API key first:\n  export LEMLIST_API_KEY=your_key_here\n  node server.js\n\n(or run with DEMO_MODE=1 to serve baked fixtures)');
  process.exit(1);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'x-dashboard-key, content-type');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    const apiPath = pathname.replace(/^\/api/, '');

    if (DASHBOARD_PASSWORD && apiPath !== '/config') {
      const provided = req.headers['x-dashboard-key'] || url.searchParams.get('key') || '';
      if (!provided || !timingSafeEqual(String(provided), DASHBOARD_PASSWORD)) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'unauthorized' })); return;
      }
    }

    const query = Object.fromEntries(url.searchParams.entries());
    try {
      const { status, body, fetchedAt } = await dispatch(apiPath, query);
      if (fetchedAt) res.setHeader('x-data-fetched-at', new Date(fetchedAt).toISOString());
      res.writeHead(status);
      res.end(JSON.stringify(body));
    } catch (e) {
      if (e instanceof HttpError) { res.writeHead(e.status); res.end(JSON.stringify({ error: e.message })); return; }
      console.error(e);
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // static
  const filePath = pathname === '/' ? '/index.html' : pathname;
  const fullPath = path.join(__dirname, 'public', filePath);
  const ext = path.extname(fullPath);
  try {
    const content = fs.readFileSync(fullPath);
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.writeHead(200);
    res.end(content);
  } catch {
    res.writeHead(404);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, () => {
  console.log(`✓ Lemlist dashboard running at http://localhost:${PORT}${isDemoMode() ? '  (demo mode)' : ''}`);
});

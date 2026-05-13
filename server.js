const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3100;
const API_KEY = process.env.LEMLIST_API_KEY;

if (!API_KEY) {
  console.error('ERROR: Set your API key first:\n  export LEMLIST_API_KEY=your_key_here\n  node server.js');
  process.exit(1);
}

const AUTH = Buffer.from(`:${API_KEY}`).toString('base64');

function lemlist(p, retries = 6) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.lemlist.com',
      path: '/api' + p,
      headers: { 'Authorization': `Basic ${AUTH}` },
    };
    https.get(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 429) {
          if (retries > 0) {
            const wait = (7 - retries) * 2000;
            setTimeout(() => lemlist(p, retries - 1).then(resolve).catch(reject), wait);
          } else reject(new Error('Rate limited after retries'));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Bad JSON: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

async function allLeads(campaignId) {
  const PAGE = 500;
  let all = [], offset = 0;
  while (true) {
    const page = await lemlist(`/campaigns/${campaignId}/leads?limit=${PAGE}&offset=${offset}`);
    if (!Array.isArray(page) || page.length === 0) break;
    all = all.concat(page);
    if (page.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

async function allActivities(campaignId, type) {
  const LIMIT = 100;
  let all = [], offset = 0;
  while (true) {
    const page = await lemlist(`/activities?version=v2&campaignId=${campaignId}&type=${type}&limit=${LIMIT}&offset=${offset}`);
    if (!Array.isArray(page) || page.length === 0) break;
    all = all.concat(page);
    if (page.length < LIMIT) break;
    offset += LIMIT;
    if (offset > 5000) break; // safety
  }
  return all;
}

const CONTACTED = ['emailsSent', 'emailsOpened', 'emailsClicked', 'emailsReplied',
  'emailsBounced', 'linkedinInviteDone', 'linkedinInviteAccepted', 'linkedinReplied'];

function aggregateStats(leads) {
  const total = leads.length;
  const sent = leads.filter(l => CONTACTED.includes(l.state)).length;
  const byState = {};
  leads.forEach(l => { byState[l.state] = (byState[l.state] || 0) + 1; });
  return {
    total,
    contacted: sent,
    progress: total > 0 ? sent / total : 0,
    sent,
    opened: leads.filter(l => ['emailsOpened', 'emailsClicked', 'emailsReplied', 'linkedinReplied'].includes(l.state)).length,
    clicked: leads.filter(l => l.state === 'emailsClicked').length,
    replied: leads.filter(l => ['emailsReplied', 'linkedinReplied'].includes(l.state)).length,
    bounced: leads.filter(l => l.state === 'emailsBounced').length,
    liInviteDone: leads.filter(l => ['linkedinInviteDone', 'linkedinInviteAccepted', 'linkedinReplied'].includes(l.state)).length,
    liAccepted: leads.filter(l => ['linkedinInviteAccepted', 'linkedinReplied'].includes(l.state)).length,
    liReplied: leads.filter(l => l.state === 'linkedinReplied').length,
    unsubscribed: leads.filter(l => l.state === 'unsubscribed' || l.unsubscribed).length,
    byState,
  };
}

function dayKey(iso) {
  const d = new Date(iso);
  return d.toISOString().slice(0, 10);
}

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'x-dashboard-key, content-type');
  }
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // Password gate for /api/* only (static files load freely so the prompt UI can render)
  if (DASHBOARD_PASSWORD && pathname.startsWith('/api/')) {
    const provided = req.headers['x-dashboard-key'] || url.searchParams.get('key') || '';
    if (!provided || !timingSafeEqual(String(provided), DASHBOARD_PASSWORD)) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
  }

  try {
    // GET /api/campaigns — list w/ stats
    if (pathname === '/api/campaigns') {
      const result = await lemlist('/campaigns');
      const campaigns = Array.isArray(result) ? result : (result.campaigns || []);
      // API key is scoped to Cascade Health team — show every campaign.
      const list = campaigns;

      const BATCH = 3;
      const withStats = [];
      for (let i = 0; i < list.length; i += BATCH) {
        const batch = list.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(async (c) => {
          try {
            const leads = await allLeads(c._id);
            return { ...c, statistics: aggregateStats(leads) };
          } catch (e) {
            console.error(`Stats failed for ${c._id}: ${e.message}`);
            return c;
          }
        }));
        withStats.push(...results);
      }

      res.writeHead(200);
      res.end(JSON.stringify(withStats));

    // GET /api/campaigns/:id/timeline — daily activity for last N days + recent replies
    } else if (pathname.match(/^\/api\/campaigns\/[^/]+\/timeline$/)) {
      const id = pathname.split('/')[3];
      const days = parseInt(url.searchParams.get('days') || '30');

      const types = ['emailsSent', 'emailsOpened', 'emailsReplied', 'emailsBounced',
        'linkedinInviteDone', 'linkedinInviteAccepted', 'linkedinReplied'];

      const results = {};
      for (const t of types) {
        try { results[t] = await allActivities(id, t); }
        catch (e) { console.error(`activities ${t}: ${e.message}`); results[t] = []; }
      }

      const now = Date.now();
      const cutoff = now - days * 24 * 60 * 60 * 1000;

      const buckets = {};
      const ensureDay = k => {
        if (!buckets[k]) buckets[k] = { day: k, sent: 0, opened: 0, replied: 0, bounced: 0, liSent: 0, liAccepted: 0, liReplied: 0 };
        return buckets[k];
      };
      const slotMap = {
        emailsSent: 'sent', emailsOpened: 'opened', emailsReplied: 'replied', emailsBounced: 'bounced',
        linkedinInviteDone: 'liSent', linkedinInviteAccepted: 'liAccepted', linkedinReplied: 'liReplied',
      };
      for (const [t, arr] of Object.entries(results)) {
        for (const a of arr) {
          const d = new Date(a.createdAt).getTime();
          if (isNaN(d) || d < cutoff) continue;
          const k = dayKey(a.createdAt);
          ensureDay(k)[slotMap[t]] += 1;
        }
      }
      // Fill missing days
      for (let i = 0; i < days; i++) {
        const k = new Date(now - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        ensureDay(k);
      }
      const timeline = Object.values(buckets).sort((a, b) => a.day.localeCompare(b.day));

      // Recent replies & accepts (last 10 of each)
      const recentReplies = [...(results.emailsReplied || []), ...(results.linkedinReplied || [])]
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 10)
        .map(a => ({
          type: a.type,
          createdAt: a.createdAt,
          firstName: a.leadFirstName || '',
          lastName: a.leadLastName || '',
          email: a.leadEmail || '',
          company: a.leadCompanyName || '',
          leadId: a.leadId || a.lead?._id || '',
        }));
      const recentAccepts = (results.linkedinInviteAccepted || [])
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 10)
        .map(a => ({
          createdAt: a.createdAt,
          firstName: a.leadFirstName || '',
          lastName: a.leadLastName || '',
          company: a.leadCompanyName || '',
          leadId: a.leadId || a.lead?._id || '',
        }));

      res.writeHead(200);
      res.end(JSON.stringify({ timeline, recentReplies, recentAccepts }));

    // GET /api/campaigns/:id/detail — campaign + leads + stats
    } else if (pathname.match(/^\/api\/campaigns\/[^/]+\/detail$/)) {
      const id = pathname.split('/')[3];
      const [campaign, leads] = await Promise.all([
        lemlist(`/campaigns/${id}`),
        allLeads(id),
      ]);
      const stats = aggregateStats(leads);
      res.writeHead(200);
      res.end(JSON.stringify({ campaign, stats, leads }));

    // GET /api/campaigns/:id/leads-page — paginated enriched leads
    } else if (pathname.match(/^\/api\/campaigns\/[^/]+\/leads-page$/)) {
      const id = pathname.split('/')[3];
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const limit = parseInt(url.searchParams.get('limit') || '25');
      const stateFilter = url.searchParams.get('state') || '';

      let allL = await allLeads(id);
      if (stateFilter) allL = allL.filter(l => l.state === stateFilter);
      const page = allL.slice(offset, offset + limit);

      const BATCH = 3;
      const delay = ms => new Promise(r => setTimeout(r, ms));
      const enriched = [];
      for (let i = 0; i < page.length; i += BATCH) {
        if (i > 0) await delay(300);
        const batch = page.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(async (lead) => {
          try {
            const contact = await lemlist(`/contacts/${lead.contactId}`);
            return {
              _id: lead._id,
              state: lead.state,
              email: contact.email,
              fullName: contact.fullName,
              firstName: contact.fields?.firstName,
              lastName: contact.fields?.lastName,
              jobTitle: contact.fields?.jobTitle,
              company: contact.fields?.companyName || contact.fields?.company,
              industry: contact.fields?.industry,
              linkedinUrl: contact.linkedinUrl,
              firstContactedDate: contact.fields?.firstContactedDate,
              lastContactedDate: contact.fields?.lastContactedDate,
              leadStatus: contact.fields?.leadStatus,
              unsubscribed: contact.unsubscribed,
              is340B: contact.fields?.is340B || contact.fields?.['340B'] || '',
              bucket: contact.fields?.bucket || '',
            };
          } catch {
            return { _id: lead._id, state: lead.state };
          }
        }));
        enriched.push(...results);
      }

      res.writeHead(200);
      res.end(JSON.stringify({ leads: enriched, total: allL.length, offset, limit }));

    // GET /api/campaigns/:id/late-accepts — LI accepts >3d after invite
    } else if (pathname.match(/^\/api\/campaigns\/[^/]+\/late-accepts$/)) {
      const id = pathname.split('/')[3];
      const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

      const [invitesSent, invitesAccepted] = await Promise.all([
        allActivities(id, 'linkedinInviteDone'),
        allActivities(id, 'linkedinInviteAccepted'),
      ]);

      const sentByLead = {};
      for (const a of invitesSent) {
        const key = a.leadId || a.lead?._id;
        if (key) sentByLead[key] = new Date(a.createdAt);
      }

      const lateAccepts = [];
      for (const accept of invitesAccepted) {
        const leadId = accept.leadId || accept.lead?._id;
        if (!leadId) continue;
        const sentDate = sentByLead[leadId];
        if (!sentDate) continue;
        const acceptDate = new Date(accept.createdAt);
        const gapMs = acceptDate - sentDate;
        if (gapMs > THREE_DAYS_MS) {
          let contact = {};
          try { if (accept.contactId) contact = await lemlist(`/contacts/${accept.contactId}`); } catch {}
          lateAccepts.push({
            leadId,
            firstName: accept.leadFirstName || contact.fields?.firstName || '',
            lastName: accept.leadLastName || contact.fields?.lastName || '',
            fullName: contact.fullName || `${accept.leadFirstName || ''} ${accept.leadLastName || ''}`.trim(),
            email: accept.leadEmail || contact.email || '',
            company: accept.leadCompanyName || contact.fields?.companyName || contact.fields?.company || '',
            jobTitle: contact.fields?.jobTitle || '',
            linkedinUrl: contact.linkedinUrl || '',
            inviteSent: sentDate.toISOString(),
            acceptedOn: acceptDate.toISOString(),
            daysToAccept: Math.round(gapMs / (24 * 60 * 60 * 1000)),
          });
        }
      }

      lateAccepts.sort((a, b) => new Date(b.acceptedOn) - new Date(a.acceptedOn));
      res.writeHead(200);
      res.end(JSON.stringify({ lateAccepts, totalInvitesSent: invitesSent.length, totalAccepted: invitesAccepted.length }));

    } else {
      // static
      const filePath = pathname === '/' ? '/index.html' : pathname;
      const fullPath = path.join(__dirname, 'public', filePath);
      const ext = path.extname(fullPath);
      const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
      try {
        const content = fs.readFileSync(fullPath);
        res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
        res.writeHead(200);
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    }
  } catch (e) {
    console.error(e);
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`✓ Cascade Lemlist proxy running at http://localhost:${PORT}`);
});

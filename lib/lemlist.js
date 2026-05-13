const https = require('https');

const AUTH = Buffer.from(`:${process.env.LEMLIST_API_KEY || ''}`).toString('base64');

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
    if (offset > 5000) break;
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
  return new Date(iso).toISOString().slice(0, 10);
}

module.exports = { lemlist, allLeads, allActivities, aggregateStats, dayKey };

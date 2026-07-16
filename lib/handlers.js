// Shared route handlers for the lemlist dashboard.
//
// Every API route's data logic lives here as a pure-ish async function returning
// a plain object. Both entry points consume this module:
//   - server.js          (local dev, raw Node http)
//   - api/[...path].js    (Vercel serverless catch-all)
// Neither entry point contains business logic — only transport (CORS, auth,
// serialisation). This is also where the cache and demo-mode seams live.

const { lemlist, allLeads, allActivities, allActivitiesAllTypes, aggregateStatsFromActivities, dayKey } = require('./lemlist');
const { cached } = require('./cache');
const { config, allowedCampaignIds, isAllowed, thresholds } = require('./config');
const { isDemoMode, serveFixture } = require('./demo');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const DAY_MS = 24 * 60 * 60 * 1000;

// --- campaign list (respects the optional whitelist) ------------------------
async function fetchCampaignList() {
  if (allowedCampaignIds.size === 0) {
    const result = await lemlist('/campaigns');
    return Array.isArray(result) ? result : (result.campaigns || []);
  }
  // Whitelist set: paginate only until every allowed campaign is found.
  const PAGE = 100;
  let all = [], offset = 0;
  while (true) {
    const page = await lemlist(`/campaigns?limit=${PAGE}&offset=${offset}`);
    const arr = Array.isArray(page) ? page : (page.campaigns || []);
    if (arr.length === 0) break;
    all = all.concat(arr);
    const found = new Set(all.filter(c => allowedCampaignIds.has(c._id)).map(c => c._id));
    if (found.size >= allowedCampaignIds.size) break;
    if (arr.length < PAGE) break;
    offset += PAGE;
  }
  return all.filter(c => allowedCampaignIds.has(c._id));
}

// --- individual handlers (return the response body) -------------------------

async function liveCampaigns() {
  const list = await fetchCampaignList();
  const BATCH = 3;
  const withStats = [];
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (c) => {
      try {
        const [leads, activities] = await Promise.all([allLeads(c._id), allActivitiesAllTypes(c._id)]);
        return { ...c, statistics: aggregateStatsFromActivities(activities, leads) };
      } catch (e) {
        console.error(`Stats failed for ${c._id}: ${e.message}`);
        return c;
      }
    }));
    withStats.push(...results);
  }
  return withStats;
}

async function liveTimeline(id, days) {
  const types = ['emailsSent', 'emailsOpened', 'emailsReplied', 'emailsBounced',
    'linkedinInviteDone', 'linkedinInviteAccepted', 'linkedinReplied'];
  const results = {};
  for (const t of types) {
    try { results[t] = await allActivities(id, t); }
    catch (e) { console.error(`activities ${t}: ${e.message}`); results[t] = []; }
  }
  const now = Date.now();
  const cutoff = now - days * DAY_MS;
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
      ensureDay(dayKey(a.createdAt))[slotMap[t]] += 1;
    }
  }
  for (let i = 0; i < days; i++) {
    ensureDay(new Date(now - i * DAY_MS).toISOString().slice(0, 10));
  }
  const timeline = Object.values(buckets).sort((a, b) => a.day.localeCompare(b.day));
  const recentReplies = [...(results.emailsReplied || []), ...(results.linkedinReplied || [])]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 10)
    .map(a => ({ type: a.type, createdAt: a.createdAt, firstName: a.leadFirstName || '', lastName: a.leadLastName || '', email: a.leadEmail || '', company: a.leadCompanyName || '', leadId: a.leadId || a.lead?._id || '' }));
  const recentAccepts = (results.linkedinInviteAccepted || [])
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 10)
    .map(a => ({ createdAt: a.createdAt, firstName: a.leadFirstName || '', lastName: a.leadLastName || '', company: a.leadCompanyName || '', leadId: a.leadId || a.lead?._id || '' }));
  return { timeline, recentReplies, recentAccepts };
}

async function liveDetail(id) {
  const [campaign, leads, activities] = await Promise.all([
    lemlist(`/campaigns/${id}`),
    allLeads(id),
    allActivitiesAllTypes(id),
  ]);
  return { campaign, stats: aggregateStatsFromActivities(activities, leads), leads };
}

function extraFieldsFor(contact) {
  const extra = {};
  for (const f of config.extraLeadFields || []) {
    extra[f.key] = (f.sources || []).map(s => contact.fields?.[s]).find(v => v) || '';
  }
  return extra;
}

async function liveLeadsPage(id, { offset, limit, stateFilter }) {
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
          _id: lead._id, state: lead.state, email: contact.email, fullName: contact.fullName,
          firstName: contact.fields?.firstName, lastName: contact.fields?.lastName,
          jobTitle: contact.fields?.jobTitle,
          company: contact.fields?.companyName || contact.fields?.company,
          industry: contact.fields?.industry, linkedinUrl: contact.linkedinUrl,
          firstContactedDate: contact.fields?.firstContactedDate,
          lastContactedDate: contact.fields?.lastContactedDate,
          leadStatus: contact.fields?.leadStatus, unsubscribed: contact.unsubscribed,
          ...extraFieldsFor(contact),
        };
      } catch { return { _id: lead._id, state: lead.state }; }
    }));
    enriched.push(...results);
  }
  return { leads: enriched, total: allL.length, offset, limit };
}

async function liveLateAccepts(id) {
  const windowMs = (thresholds.lateAcceptDays || 3) * DAY_MS;
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
    if (gapMs > windowMs) {
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
        daysToAccept: Math.round(gapMs / DAY_MS),
      });
    }
  }
  lateAccepts.sort((a, b) => new Date(b.acceptedOn) - new Date(a.acceptedOn));
  return { lateAccepts, totalInvitesSent: invitesSent.length, totalAccepted: invitesAccepted.length };
}

async function liveReplies() {
  const campaigns = (await fetchCampaignList()).filter(c => !c.archived);
  const BATCH = 3;
  const allReplies = [];
  for (let i = 0; i < campaigns.length; i += BATCH) {
    const batch = campaigns.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (c) => {
      try {
        const [emailReplies, linkedinReplies] = await Promise.all([
          allActivities(c._id, 'emailsReplied'),
          allActivities(c._id, 'linkedinReplied'),
        ]);
        const replies = [];
        for (const r of emailReplies) replies.push({ ...r, replyType: 'email', campaignId: c._id, campaignName: c.name });
        for (const r of linkedinReplies) replies.push({ ...r, replyType: 'linkedin', campaignId: c._id, campaignName: c.name });
        return replies;
      } catch (e) {
        console.error(`Replies failed for ${c._id}: ${e.message}`);
        return [];
      }
    }));
    for (const r of results) allReplies.push(...r);
  }
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const enriched = [];
  const ENRICH_BATCH = 5;
  for (let i = 0; i < allReplies.length; i += ENRICH_BATCH) {
    if (i > 0) await delay(300);
    const batch = allReplies.slice(i, i + ENRICH_BATCH);
    const results = await Promise.all(batch.map(async (reply) => {
      let contact = {};
      try { if (reply.contactId) contact = await lemlist(`/contacts/${reply.contactId}`); } catch {}
      return {
        replyType: reply.replyType,
        campaignId: reply.campaignId,
        campaignName: reply.campaignName,
        date: reply.createdAt,
        email: reply.leadEmail || contact.email || '',
        fullName: contact.fullName || `${reply.leadFirstName || ''} ${reply.leadLastName || ''}`.trim(),
        firstName: reply.leadFirstName || contact.fields?.firstName || '',
        lastName: reply.leadLastName || contact.fields?.lastName || '',
        company: reply.leadCompanyName || contact.fields?.companyName || contact.fields?.company || '',
        jobTitle: contact.fields?.jobTitle || '',
        linkedinUrl: contact.linkedinUrl || '',
      };
    }));
    enriched.push(...results);
  }
  enriched.sort((a, b) => new Date(b.date) - new Date(a.date));
  return { replies: enriched, totalCampaigns: campaigns.length };
}

async function liveNeedsFollowup() {
  const campaigns = (await fetchCampaignList()).filter(c => !c.archived);
  const BATCH = 3;
  const items = [];
  for (let i = 0; i < campaigns.length; i += BATCH) {
    const batch = campaigns.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (c) => {
      try {
        const [accepted, liReplied, emReplied] = await Promise.all([
          allActivities(c._id, 'linkedinInviteAccepted'),
          allActivities(c._id, 'linkedinReplied'),
          allActivities(c._id, 'emailsReplied'),
        ]);
        const repliedLeads = new Set();
        for (const r of [...liReplied, ...emReplied]) if (r.leadId) repliedLeads.add(r.leadId);
        const out = [];
        for (const a of accepted) {
          if (a.leadId && repliedLeads.has(a.leadId)) continue;
          out.push({ ...a, campaignId: c._id, campaignName: c.name });
        }
        return out;
      } catch (e) {
        console.error(`Needs-followup failed for ${c._id}: ${e.message}`);
        return [];
      }
    }));
    for (const r of results) items.push(...r);
  }
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const enriched = [];
  const EB = 5;
  for (let i = 0; i < items.length; i += EB) {
    if (i > 0) await delay(300);
    const batch = items.slice(i, i + EB);
    const results = await Promise.all(batch.map(async (a) => {
      let contact = {};
      try { if (a.contactId) contact = await lemlist(`/contacts/${a.contactId}`); } catch {}
      return {
        leadId: a.leadId || '',
        campaignId: a.campaignId,
        campaignName: a.campaignName,
        acceptedOn: a.createdAt,
        email: a.leadEmail || contact.email || '',
        fullName: contact.fullName || `${a.leadFirstName || ''} ${a.leadLastName || ''}`.trim(),
        firstName: a.leadFirstName || contact.fields?.firstName || '',
        lastName: a.leadLastName || contact.fields?.lastName || '',
        company: a.leadCompanyName || contact.fields?.companyName || contact.fields?.company || contact.fields?.organization || a.leadOrganization || '',
        jobTitle: contact.fields?.jobTitle || '',
        linkedinUrl: contact.linkedinUrl || '',
      };
    }));
    enriched.push(...results);
  }
  enriched.sort((a, b) => new Date(b.acceptedOn) - new Date(a.acceptedOn));
  return { followups: enriched, totalCampaigns: campaigns.length };
}

// --- config (public; the gate screen needs branding before auth) ------------
function handleConfig() {
  const { extraLeadFields, ...safe } = config;
  return {
    ...safe,
    extraLeadFields,
    _runtime: {
      demoMode: isDemoMode(),
      passwordRequired: !!process.env.DASHBOARD_PASSWORD,
    },
  };
}

// --- cache wrapper ----------------------------------------------------------
async function withCache(key, query, fetcher) {
  const { data, fetchedAt } = await cached(key, fetcher, { fresh: query.fresh === '1' });
  return { body: data, fetchedAt };
}

function guard(id) {
  if (!isAllowed(id)) throw new HttpError(404, 'not found');
}

// --- dispatcher -------------------------------------------------------------
// Returns { status, body, fetchedAt? }. Throws HttpError for auth/404, other
// errors bubble to the caller's 500 handler.
async function dispatch(apiPath, query = {}) {
  if (apiPath === '/config') return { status: 200, body: handleConfig() };

  const demo = isDemoMode();

  if (apiPath === '/campaigns') {
    if (demo) return { status: 200, body: serveFixture('campaigns'), fetchedAt: Date.now() };
    const { body, fetchedAt } = await withCache('campaigns', query, liveCampaigns);
    return { status: 200, body, fetchedAt };
  }

  let m;
  if ((m = apiPath.match(/^\/campaigns\/([^/]+)\/timeline$/))) {
    const id = m[1]; guard(id);
    const days = parseInt(query.days || String(thresholds.sparklineDays || 30));
    if (demo) return { status: 200, body: serveFixture(`campaigns/${id}/timeline`), fetchedAt: Date.now() };
    const { body, fetchedAt } = await withCache(`timeline:${id}:${days}`, query, () => liveTimeline(id, days));
    return { status: 200, body, fetchedAt };
  }

  if ((m = apiPath.match(/^\/campaigns\/([^/]+)\/detail$/))) {
    const id = m[1]; guard(id);
    if (demo) return { status: 200, body: serveFixture(`campaigns/${id}/detail`), fetchedAt: Date.now() };
    const { body, fetchedAt } = await withCache(`detail:${id}`, query, () => liveDetail(id));
    return { status: 200, body, fetchedAt };
  }

  if ((m = apiPath.match(/^\/campaigns\/([^/]+)\/leads-page$/))) {
    const id = m[1]; guard(id);
    const offset = parseInt(query.offset || '0');
    const limit = parseInt(query.limit || '25');
    const stateFilter = query.state || '';
    if (demo) {
      let all = serveFixture(`campaigns/${id}/leads-page`).leads || [];
      if (stateFilter) all = all.filter(l => l.state === stateFilter);
      return { status: 200, body: { leads: all.slice(offset, offset + limit), total: all.length, offset, limit }, fetchedAt: Date.now() };
    }
    const { body, fetchedAt } = await withCache(`leads-page:${id}:${offset}:${limit}:${stateFilter}`, query, () => liveLeadsPage(id, { offset, limit, stateFilter }));
    return { status: 200, body, fetchedAt };
  }

  if ((m = apiPath.match(/^\/campaigns\/([^/]+)\/late-accepts$/))) {
    const id = m[1]; guard(id);
    if (demo) return { status: 200, body: serveFixture(`campaigns/${id}/late-accepts`), fetchedAt: Date.now() };
    const { body, fetchedAt } = await withCache(`late-accepts:${id}`, query, () => liveLateAccepts(id));
    return { status: 200, body, fetchedAt };
  }

  if (apiPath === '/replies') {
    if (demo) return { status: 200, body: serveFixture('replies'), fetchedAt: Date.now() };
    const { body, fetchedAt } = await withCache('replies', query, liveReplies);
    return { status: 200, body, fetchedAt };
  }

  if (apiPath === '/needs-followup') {
    if (demo) return { status: 200, body: serveFixture('needs-followup'), fetchedAt: Date.now() };
    const { body, fetchedAt } = await withCache('needs-followup', query, liveNeedsFollowup);
    return { status: 200, body, fetchedAt };
  }

  return { status: 404, body: { error: 'not found', apiPath } };
}

module.exports = { dispatch, handleConfig, HttpError };

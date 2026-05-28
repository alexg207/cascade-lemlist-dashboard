const { lemlist, allActivities } = require('../lib/lemlist');
const { setCors } = require('../lib/cors');
const { checkAuth } = require('../lib/auth');

module.exports = async (req, res) => {
  setCors(req, res);
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!checkAuth(req, res)) return;

  try {
    const result = await lemlist('/campaigns');
    const campaigns = (Array.isArray(result) ? result : (result.campaigns || []))
      .filter(c => !c.archived);

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
    res.status(200).json({ followups: enriched, totalCampaigns: campaigns.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

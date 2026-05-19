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
          for (const r of emailReplies) {
            replies.push({ ...r, replyType: 'email', campaignId: c._id, campaignName: c.name });
          }
          for (const r of linkedinReplies) {
            replies.push({ ...r, replyType: 'linkedin', campaignId: c._id, campaignName: c.name });
          }
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
        try {
          if (reply.contactId) contact = await lemlist(`/contacts/${reply.contactId}`);
        } catch {}
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

    res.status(200).json({ replies: enriched, totalCampaigns: campaigns.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

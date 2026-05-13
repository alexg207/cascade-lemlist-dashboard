const { lemlist, allLeads } = require('../../../lib/lemlist');
const { setCors } = require('../../../lib/cors');
const { checkAuth } = require('../../../lib/auth');

module.exports = async (req, res) => {
  setCors(req, res);
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!checkAuth(req, res)) return;

  const id = req.query.id;
  const offset = parseInt(req.query.offset || '0');
  const limit = parseInt(req.query.limit || '25');
  const stateFilter = req.query.state || '';

  try {
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

    res.status(200).json({ leads: enriched, total: allL.length, offset, limit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

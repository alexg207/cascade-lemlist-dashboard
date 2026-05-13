const { lemlist, allActivities } = require('../../../lib/lemlist');
const { setCors } = require('../../../lib/cors');
const { checkAuth } = require('../../../lib/auth');

module.exports = async (req, res) => {
  setCors(req, res);
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!checkAuth(req, res)) return;

  const id = req.query.id;
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

  try {
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
    res.status(200).json({ lateAccepts, totalInvitesSent: invitesSent.length, totalAccepted: invitesAccepted.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

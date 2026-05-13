const { allActivities, dayKey } = require('../../../lib/lemlist');
const { setCors } = require('../../../lib/cors');
const { checkAuth } = require('../../../lib/auth');

module.exports = async (req, res) => {
  setCors(req, res);
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!checkAuth(req, res)) return;

  const id = req.query.id;
  const days = parseInt(req.query.days || '30');

  const types = ['emailsSent', 'emailsOpened', 'emailsReplied', 'emailsBounced',
    'linkedinInviteDone', 'linkedinInviteAccepted', 'linkedinReplied'];

  try {
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
        ensureDay(dayKey(a.createdAt))[slotMap[t]] += 1;
      }
    }
    for (let i = 0; i < days; i++) {
      const k = new Date(now - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      ensureDay(k);
    }
    const timeline = Object.values(buckets).sort((a, b) => a.day.localeCompare(b.day));

    const recentReplies = [...(results.emailsReplied || []), ...(results.linkedinReplied || [])]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 10)
      .map(a => ({
        type: a.type, createdAt: a.createdAt,
        firstName: a.leadFirstName || '', lastName: a.leadLastName || '',
        email: a.leadEmail || '', company: a.leadCompanyName || '',
        leadId: a.leadId || a.lead?._id || '',
      }));
    const recentAccepts = (results.linkedinInviteAccepted || [])
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 10)
      .map(a => ({
        createdAt: a.createdAt,
        firstName: a.leadFirstName || '', lastName: a.leadLastName || '',
        company: a.leadCompanyName || '', leadId: a.leadId || a.lead?._id || '',
      }));

    res.status(200).json({ timeline, recentReplies, recentAccepts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

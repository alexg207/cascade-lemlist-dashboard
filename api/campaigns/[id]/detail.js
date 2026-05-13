const { lemlist, allLeads, aggregateStats } = require('../../../lib/lemlist');
const { setCors } = require('../../../lib/cors');
const { checkAuth } = require('../../../lib/auth');

module.exports = async (req, res) => {
  setCors(req, res);
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!checkAuth(req, res)) return;

  const id = req.query.id;
  try {
    const [campaign, leads] = await Promise.all([
      lemlist(`/campaigns/${id}`),
      allLeads(id),
    ]);
    res.status(200).json({ campaign, stats: aggregateStats(leads), leads });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

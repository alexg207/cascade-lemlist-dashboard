const { lemlist, allLeads, allActivitiesAllTypes, aggregateStatsFromActivities } = require('../lib/lemlist');
const { setCors } = require('../lib/cors');
const { checkAuth } = require('../lib/auth');

module.exports = async (req, res) => {
  setCors(req, res);
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!checkAuth(req, res)) return;

  try {
    const result = await lemlist('/campaigns');
    const campaigns = Array.isArray(result) ? result : (result.campaigns || []);

    const BATCH = 3;
    const withStats = [];
    for (let i = 0; i < campaigns.length; i += BATCH) {
      const batch = campaigns.slice(i, i + BATCH);
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

    res.status(200).json(withStats);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

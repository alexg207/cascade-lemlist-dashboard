// Single source of truth for everything company-specific.
// Loaded from config.json (statically required so Vercel bundles it).
// Nothing else in lib/ or api/ should hardcode a company name, campaign id,
// bucket regex, threshold, or colour — it all lives in config.json.

const raw = require('../config.json');

// Compile bucket / variant patterns once (case-insensitive), preserving array
// order — order is match precedence in classify().
const buckets = (raw.buckets || []).map(b => ({ ...b, regex: new RegExp(b.pattern, 'i') }));
const variants = (raw.variants || []).map(v => ({ ...v, regex: new RegExp(v.pattern, 'i') }));

const allowedCampaignIds = new Set(raw.allowedCampaignIds || []);
const thresholds = Object.assign({ lateAcceptDays: 3, sparklineDays: 30, cacheTtlSeconds: 300 }, raw.thresholds || {});

const config = { ...raw, buckets, variants, thresholds };

// Whether a campaign id is visible given the whitelist. Empty whitelist = show all
// (the key is team-scoped and only sees this company's campaigns).
function isAllowed(id) {
  return allowedCampaignIds.size === 0 || allowedCampaignIds.has(id);
}

module.exports = { config, buckets, variants, allowedCampaignIds, thresholds, isAllowed };

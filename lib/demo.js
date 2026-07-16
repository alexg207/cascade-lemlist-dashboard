// Demo-mode seam.
//
// When there is no real lemlist key (or DEMO_MODE=1 is set) AND a data/fixtures
// directory is present, the handlers serve baked fixtures instead of hitting the
// lemlist API. This is what powers the public playbook demo and lets a freshly
// cloned template render immediately, before any key is configured.
//
// In the live Cascade instance there is no data/fixtures dir, so isDemoMode()
// is false and this module is inert.

const fs = require('fs');
const path = require('path');

const FIXTURES_DIR = path.join(__dirname, '..', 'data', 'fixtures');

let fixturesPresent = null;
function hasFixtures() {
  if (fixturesPresent === null) {
    try { fixturesPresent = fs.existsSync(FIXTURES_DIR); }
    catch { fixturesPresent = false; }
  }
  return fixturesPresent;
}

function isDemoMode() {
  if (process.env.DEMO_MODE === '1') return true;
  if (!process.env.LEMLIST_API_KEY && hasFixtures()) return true;
  return false;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Recursively convert { "$daysAgo": N } markers into ISO timestamps relative to
// now, so fixture sparklines / recent-activity never decay into "no activity".
function rehydrate(value) {
  if (Array.isArray(value)) return value.map(rehydrate);
  if (value && typeof value === 'object') {
    if (typeof value.$daysAgo === 'number') {
      return new Date(Date.now() - value.$daysAgo * DAY_MS).toISOString();
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = rehydrate(v);
    return out;
  }
  return value;
}

// Load a fixture by relative name, e.g. "campaigns" or "campaigns/<id>/timeline".
function serveFixture(name) {
  const file = path.join(FIXTURES_DIR, name + '.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return rehydrate(raw);
}

module.exports = { isDemoMode, serveFixture, hasFixtures, FIXTURES_DIR };

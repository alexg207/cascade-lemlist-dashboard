#!/usr/bin/env node
// Deterministic fake-data generator for demo mode.
//
// Reads ../config.json and produces a full set of fixtures under data/fixtures/
// plus demo public/meetings.json + public/lead-index.json, so the dashboard
// renders a realistic-looking instance with ZERO setup and no lemlist key.
//
// Dates are emitted as { "$daysAgo": N } markers; lib/demo.js rehydrates them to
// ISO timestamps relative to now at serve time, so the demo never goes stale.
//
// Deterministic (seeded) — no Math.random / Date.now — so output is reproducible
// and diff-friendly.

const fs = require('fs');
const path = require('path');
const cfg = require('../config.json');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(ROOT, 'data', 'fixtures');
const CAMP_DIR = path.join(FIX, 'campaigns');

// --- tiny seeded PRNG (mulberry32) -----------------------------------------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(1337);
const pick = arr => arr[Math.floor(rand() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const FIRST = ['Jordan', 'Casey', 'Morgan', 'Riley', 'Avery', 'Quinn', 'Reese', 'Sydney', 'Parker', 'Rowan', 'Emerson', 'Sawyer', 'Blake', 'Hayden', 'Marlowe', 'Tatum', 'Elliot', 'Kai', 'Remy', 'Sasha'];
const LAST = ['Chen', 'Patel', 'Nguyen', 'Kim', 'Garcia', 'Okafor', 'Silva', 'Rossi', 'Novak', 'Hassan', 'Larsen', 'Meyer', 'Costa', 'Ali', 'Park', 'Ford', 'Reyes', 'Blum', 'Vance', 'Ito'];
const COMPANIES = ['Northwind', 'Acme Labs', 'Globex', 'Initech', 'Umbra Systems', 'Vertex Care', 'Lumen Group', 'Cedar Health', 'Pillar Bio', 'Anvil Digital', 'Beacon Ops', 'Harbor Analytics'];
const TITLES = ['VP Engineering', 'Director of Ops', 'Head of Platform', 'Chief Medical Officer', 'VP Growth', 'Director, Data', 'SVP Product', 'Head of RevOps'];

const STATES = ['emailsSent', 'emailsOpened', 'emailsClicked', 'emailsReplied', 'emailsBounced', 'linkedinInviteDone', 'linkedinInviteAccepted', 'linkedinReplied'];

const buckets = cfg.buckets || [];
const variants = cfg.variants || [];
const company = cfg.company || 'Acme';

function personName(i) {
  return { firstName: FIRST[i % FIRST.length], lastName: LAST[(i * 7) % LAST.length] };
}

// Build campaign definitions: first 2 buckets × available variants (cap 4).
function campaignDefs() {
  const defs = [];
  const bks = buckets.slice(0, 2).length ? buckets.slice(0, 2) : [{ label: 'Outbound' }];
  const vrs = variants.length ? variants : [{ label: 'Default', sender: 'Team' }];
  let n = 0;
  for (const b of bks) {
    for (const v of vrs) {
      if (n >= 4) break;
      // Name embeds the bucket label + variant sender so classify() tags it.
      const name = `${company} - ${b.label} - ${v.sender || v.label}`;
      defs.push({ _id: `cam_demo${n + 1}`, name, bucket: b, variant: v });
      n++;
    }
  }
  return defs;
}

function makeLead(idx, state) {
  const { firstName, lastName } = personName(idx);
  const company = pick(COMPANIES);
  return {
    _id: `lead_${idx}`,
    contactId: `con_${idx}`,
    state,
    firstName, lastName,
    fullName: `${firstName} ${lastName}`,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${company.toLowerCase().replace(/[^a-z]/g, '')}.com`,
    company,
    jobTitle: pick(TITLES),
    industry: 'Technology',
    linkedinUrl: `https://linkedin.com/in/${firstName.toLowerCase()}-${lastName.toLowerCase()}`,
  };
}

function statsFromLeads(leads) {
  const by = s => leads.filter(l => l.state === s).length;
  const inSet = arr => leads.filter(l => arr.includes(l.state)).length;
  const total = leads.length;
  const contacted = inSet(STATES);
  return {
    total, contacted,
    progress: total ? contacted / total : 0,
    sent: inSet(['emailsSent', 'emailsOpened', 'emailsClicked', 'emailsReplied', 'emailsBounced']),
    opened: inSet(['emailsOpened', 'emailsClicked', 'emailsReplied']),
    clicked: by('emailsClicked'),
    replied: by('emailsReplied') + by('linkedinReplied'),
    bounced: by('emailsBounced'),
    liInviteDone: inSet(['linkedinInviteDone', 'linkedinInviteAccepted', 'linkedinReplied']),
    liAccepted: inSet(['linkedinInviteAccepted', 'linkedinReplied']),
    liReplied: by('linkedinReplied'),
    unsubscribed: int(0, 3),
  };
}

function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function main() {
  fs.rmSync(FIX, { recursive: true, force: true });
  const defs = campaignDefs();
  const campaignsOut = [];
  const allReplies = [];
  const allFollowups = [];
  const meetings = [];
  const leadIndex = {};

  let leadCounter = 0;
  defs.forEach((def, ci) => {
    const nLeads = int(120, 260);
    const leads = [];
    for (let i = 0; i < nLeads; i++) {
      // Weighted state distribution: most sent/opened, few replied/bounced.
      const r = rand();
      let state;
      if (r < 0.28) state = 'emailsSent';
      else if (r < 0.52) state = 'emailsOpened';
      else if (r < 0.58) state = 'emailsClicked';
      else if (r < 0.63) state = 'emailsReplied';
      else if (r < 0.66) state = 'emailsBounced';
      else if (r < 0.82) state = 'linkedinInviteDone';
      else if (r < 0.94) state = 'linkedinInviteAccepted';
      else state = 'linkedinReplied';
      leads.push(makeLead(leadCounter++, state));
    }
    // Populate any configured extra lead fields (e.g. bucket, 340B) so the demo
    // leads table renders those columns.
    leads.forEach(l => {
      for (const f of cfg.extraLeadFields || []) {
        if (f.key === 'bucket') l.bucket = def.bucket.key || def.bucket.label || '';
        else l[f.key] = pick(['Yes', '', '', 'No']);
      }
    });
    const stats = statsFromLeads(leads);
    const createdDaysAgo = 40 + ci * 3;

    campaignsOut.push({
      _id: def._id,
      name: def.name,
      status: pick(['running', 'running', 'paused']),
      archived: false,
      createdAt: { $daysAgo: createdDaysAgo },
      statistics: stats,
    });

    // Timeline: last 30 days of activity
    const days = cfg.thresholds?.sparklineDays || 30;
    const timeline = [];
    for (let d = days - 1; d >= 0; d--) {
      timeline.push({
        day: `d-${d}`, // display-only label; charts use array order
        sent: int(0, 12), opened: int(0, 8), replied: int(0, 2), bounced: int(0, 1),
        liSent: int(0, 6), liAccepted: int(0, 3), liReplied: int(0, 1),
      });
    }
    const repliedLeads = leads.filter(l => l.state === 'emailsReplied' || l.state === 'linkedinReplied').slice(0, 10);
    const acceptedLeads = leads.filter(l => l.state === 'linkedinInviteAccepted').slice(0, 10);
    const recentReplies = repliedLeads.map((l, k) => ({
      type: l.state, createdAt: { $daysAgo: int(0, 20) }, firstName: l.firstName, lastName: l.lastName,
      email: l.email, company: l.company, leadId: l._id,
    }));
    const recentAccepts = acceptedLeads.map((l, k) => ({
      createdAt: { $daysAgo: int(0, 25) }, firstName: l.firstName, lastName: l.lastName, company: l.company, leadId: l._id,
    }));
    writeJSON(path.join(CAMP_DIR, def._id, 'timeline.json'), { timeline, recentReplies, recentAccepts });

    // detail + leads-page (full enriched list)
    writeJSON(path.join(CAMP_DIR, def._id, 'detail.json'), { campaign: campaignsOut[ci], stats, leads });
    writeJSON(path.join(CAMP_DIR, def._id, 'leads-page.json'), { leads });

    // late accepts
    const lateAccepts = acceptedLeads.slice(0, int(2, 5)).map(l => ({
      leadId: l._id, firstName: l.firstName, lastName: l.lastName, fullName: l.fullName,
      email: l.email, company: l.company, jobTitle: l.jobTitle, linkedinUrl: l.linkedinUrl,
      inviteSent: { $daysAgo: 20 }, acceptedOn: { $daysAgo: int(1, 10) }, daysToAccept: int(4, 14),
    }));
    writeJSON(path.join(CAMP_DIR, def._id, 'late-accepts.json'), {
      lateAccepts, totalInvitesSent: stats.liInviteDone, totalAccepted: stats.liAccepted,
    });

    // global replies + followups + meetings + lead-index
    repliedLeads.forEach(l => allReplies.push({
      replyType: l.state === 'linkedinReplied' ? 'linkedin' : 'email',
      campaignId: def._id, campaignName: def.name, date: { $daysAgo: int(0, 20) },
      email: l.email, fullName: l.fullName, firstName: l.firstName, lastName: l.lastName,
      company: l.company, jobTitle: l.jobTitle, linkedinUrl: l.linkedinUrl,
    }));
    acceptedLeads.forEach(l => allFollowups.push({
      leadId: l._id, campaignId: def._id, campaignName: def.name, acceptedOn: { $daysAgo: int(0, 15) },
      email: l.email, fullName: l.fullName, firstName: l.firstName, lastName: l.lastName,
      company: l.company, jobTitle: l.jobTitle, linkedinUrl: l.linkedinUrl,
    }));

    // A few booked meetings matched to replied leads
    repliedLeads.slice(0, int(1, 3)).forEach(l => meetings.push({
      id: `evt_${l._id}`,
      title: (cfg.meetings?.titlePattern || '{firstName} <> ' + company).replace('{firstName}', l.firstName),
      firstName: l.firstName,
      start: { $daysAgo: int(0, 12) }, end: { $daysAgo: int(0, 12) },
      externalEmails: [l.email], htmlLink: 'https://calendar.google.com/',
    }));

    leads.forEach(l => { leadIndex[l.email] = { firstName: l.firstName, campaignId: def._id }; });
  });

  writeJSON(path.join(FIX, 'campaigns.json'), campaignsOut);
  allReplies.sort(() => 0); // keep deterministic order
  writeJSON(path.join(FIX, 'replies.json'), { replies: allReplies, totalCampaigns: defs.length });
  writeJSON(path.join(FIX, 'needs-followup.json'), { followups: allFollowups, totalCampaigns: defs.length });

  // Demo aux data for the meetings feature
  writeJSON(path.join(ROOT, 'public', 'meetings.json'), { syncedAt: { $daysAgo: 0 }, source: 'demo', meetings });
  writeJSON(path.join(ROOT, 'public', 'lead-index.json'), leadIndex);

  console.log(`✓ Generated ${defs.length} demo campaigns, ${allReplies.length} replies, ${meetings.length} meetings under data/fixtures/`);
}

main();

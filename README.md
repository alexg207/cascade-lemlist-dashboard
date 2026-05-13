# Cascade Lemlist Dashboard

Big-card outbound analytics for Cascade Health's lemlist campaigns. Primary × Cascade.

Built off the Lyric dashboard (`alexg207/lemlist-dashboard`) but redesigned for Cascade's smaller, A/B-structured campaign set:

- **Larger cards, fewer campaigns** — each card holds hero metrics, full email + LinkedIn funnel, 30-day sparkline, recent replies/accepts, and a footer summary.
- **A/B comparison module** — Direct (Kate · Cascade) vs Advisory (Alex · Primary) head-to-head per bucket, with reply-rate-edge winner.
- **Bucket / variant / channel auto-classification** — derived from campaign names.
- **Recent activity feed** — last 3 replies + last 2 LinkedIn accepts inline on each card.
- **Late LinkedIn accepts watcher** — surfaces accepts >3 days after the invite (re-engagement signal).

## Naming convention (so auto-classification works)

Recommended pattern:

```
Cascade — <Bucket> — <Variant> — <Channel>
```

- **Bucket** — `Health Systems`, `Community Onc`, `Clinical Leaders`, `Pharma`
- **Variant** — `Direct (Kate)` or `Advisory (Alex)`
- **Channel** — `Email`, `LinkedIn`, or `LI + Email`

Example campaign names:

- `Cascade — Health Systems — Direct (Kate) — Email`
- `Cascade — Health Systems — Advisory (Alex) — Email`
- `Cascade — Community Onc — Direct (Kate) — LI + Email`
- `Cascade — Clinical Leaders — Advisory (Alex) — Email`

The Lemlist API key for this dashboard is **team-scoped to the Cascade Health workspace** (`tea_pCguuTj4E8vruZ6ej`), so every campaign returned by the API belongs to Cascade — no name-based filtering needed server-side. Auto-classification chips are name-driven for the in-app filters.

## Run locally

```bash
cd ~/cascade-lemlist-dashboard
export LEMLIST_API_KEY=<cascade-team-key>
node server.js
```

Open http://localhost:3100

Override port with `PORT=3200 node server.js` if 3100 is taken.

## API endpoints

- `GET /api/campaigns` — campaigns + aggregated stats (filtered to Cascade/Chorus)
- `GET /api/campaigns/:id/detail` — campaign + all leads + aggregated stats
- `GET /api/campaigns/:id/leads-page?offset=&limit=&state=` — enriched leads page
- `GET /api/campaigns/:id/timeline?days=30` — daily activity buckets + recent replies + recent accepts
- `GET /api/campaigns/:id/late-accepts` — LinkedIn accepts >3 days after the invite

## Design notes

The Lyric dashboard was tuned for 30+ small campaigns split across 5 owners; the card was deliberately compact. Cascade will run a small number of larger campaigns (~2–6) with a structured A/B test on top, so this version goes the other direction:

- Cards are 560px min, two-column on wide screens.
- Each card is a self-contained dashboard with its own funnel, sparkline, and activity feed.
- An A/B comparison module sits above the grid and is the single highest-density view of whether the Direct or Advisory framing is winning.
- Reply-rate is the headline metric (not opens) because Kate's KPI is reply-to-meeting conversion.

# Garden Companion — web app

The web-app slice of the architecture in the project's
`garden-companion-iphone-app-architecture.md` doc: plain JS frontend,
Vercel Functions API, Vercel Sandbox running the Claude Agent SDK,
Neon Postgres, Vercel Cron. No native/iOS layer yet — that's Capacitor on
top of this, later.

## What's here

```
public/            static frontend (index.html, css/, js/app.js)
api/
  plants/index.js       GET (list), POST (create)
  plant-detail.js        GET/PATCH/DELETE a plant, plus its research/
                          details/issue/photo sub-actions — consolidated
                          into one Function (see "Function count" below);
                          vercel.json rewrites route to it
  plant-extract.js        POST — onboarding/quick-add plant extraction
  tasks/index.js         GET (list), POST (create)
  task-detail.js          GET/PATCH a task, plus its photo sub-action —
                          same consolidation as plant-detail.js
  settings.js             GET, PATCH
  ask.js                   POST — the "Ask your gardener" panel
  weather.js               GET — latest weather snapshot
  cron/daily.js            Vercel Cron target — weather check + weekly check-in
lib/
  db.js              Neon client (HTTP driver, no connection pooling)
  mappers.js          snake_case <-> camelCase, DB row <-> API JSON
  care-templates.js    ported from garden-companion.html unchanged
  dates.js             ported date/id helpers
  schedule.js           ported materializeScheduledTasksForYear()
  sandbox-agent.js       runs the Agent SDK inside a Vercel Sandbox
  vision.js              photo analysis via the Anthropic Messages API
  plant-photo.js          shared photo-analysis pipeline
  issue-diagnosis.js       shared diagnosis -> status/task pipeline
  weather.js               Open-Meteo forecast -> friendly weather-card shape
  handlers/               the actual per-action logic for plant-detail.js /
                          task-detail.js (see "Function count" below)
schema.sql             Neon Postgres schema
vercel.json             cron config + the rewrites that back plant-detail.js
                        and task-detail.js
```

### Function count

Vercel's Hobby plan caps a deployment at 12 Serverless Functions. Giving
every route its own file (as `api/plants/[id].js`,
`api/plants/[id]/research.js`, `api/plants/[id]/details.js`, etc.) came to
14 and got rejected at deploy time (`exceeded_serverless_functions_per_deployment`).
`api/plant-detail.js` and `api/task-detail.js` each fold several routes
into one physical Function: `vercel.json`'s `rewrites` map
`/api/plants/:id` and `/api/plants/:id/:action` (same for `tasks`) onto
them with `id`/`action` as query params, and the file dispatches to the
matching handler in `lib/handlers/`. The handler logic itself is
unchanged — only the file that owns the `module.exports = async function
handler(req, res)` entry point moved. `plants/extract` was also renamed to
the top-level `plant-extract` so its literal path can never collide with
the `/api/plants/:id` rewrite pattern. Current count: 9 Functions
(`plants/index`, `plant-detail`, `plant-extract`, `tasks/index`,
`task-detail`, `settings`, `ask`, `weather`, `cron/daily`) — 3 of
headroom before hitting the cap again.

## What's ported vs. not

The frontend (`public/`) is a full port of `garden-companion.html`: the CSS
and page shell are copied verbatim, and `public/js/app.js` is the original
script with only its storage/AI calls swapped for `fetch('/api/...')`.
Onboarding wizard, dashboard (weather, This week, Upcoming, Your garden,
Recently done), Yearly plan calendar, plant detail (Overview / Care guide /
Issues), get-to-know wizard, Report a problem, Ask panel, and photo
analysis are all ported. Live `onSnapshot` updates are approximated with a
45-second poll.

AI touchpoints and where they run:

| Endpoint | Runs via |
|---|---|
| `POST /api/plants/:id/research` | Sandbox + Agent SDK |
| `POST /api/plant-extract` (onboarding + quick-add) | Sandbox + Agent SDK |
| `POST /api/plants/:id/details` (get-to-know answer normalization) | Sandbox + Agent SDK |
| `POST /api/ask` | Sandbox + Agent SDK |
| `POST /api/plants/:id/issue` (text only) | Sandbox + Agent SDK |
| `POST /api/plants/:id/photo`, `POST /api/plants/:id/issue` (with photo), `POST /api/tasks/:id/photo` | Anthropic Messages API directly (`lib/vision.js`), **needs `ANTHROPIC_API_KEY`** |

Without `ANTHROPIC_API_KEY`, photos are still saved, just not analyzed.

## Setup

1. **Neon Postgres**: in the Vercel dashboard, add the Neon integration
   (Marketplace tab) to a project, which sets `DATABASE_URL` automatically.
   Then run `schema.sql` against it once (Neon's SQL editor, or `psql
   $DATABASE_URL -f schema.sql`).
2. **Claude auth**: either run `claude setup-token` locally and add the
   result as `CLAUDE_CODE_OAUTH_TOKEN`, or generate a key at
   console.anthropic.com and add it as `ANTHROPIC_API_KEY` (Project
   Settings → Environment Variables). Either is passed into each Sandbox
   by `lib/sandbox-agent.js` — OAuth token wins if both are set.
   `ANTHROPIC_API_KEY` is also required for photo analysis (`lib/vision.js`).
3. **Cron security** (optional but recommended): set a `CRON_SECRET` env
   var to any random string — Vercel automatically sends it as a bearer
   token on cron-triggered requests, and `api/cron/daily.js` checks it.
4. **Cron schedule**: `vercel.json` currently runs the daily job at
   `13:00 UTC` — adjust to your timezone (remember Hobby cron fires
   sometime within that hour, not on the exact minute).
5. Install dependencies and deploy:
   ```
   npm install
   vercel link          # connect to your Vercel project
   vercel env pull       # pull DATABASE_URL etc. for local dev
   vercel dev             # local dev server
   vercel deploy           # ship it
   ```

## Known gaps / things to double-check before relying on this

- **No auth on the API yet.** Per the architecture doc's plan, a
  single-user long-lived bearer token is enough — not implemented here
  yet, so right now anyone with the deployment URL can read/write the
  data. Add before this is anything but a private testing URL.
- **Photos are stored as base64 data URLs in Postgres jsonb** (resized to
  480px JPEG client-side, max 6 per plant, same as the Artifact). Vercel
  Blob is the intended long-term destination. Until then, each 45s poll of
  `/api/plants` re-downloads every plant's photos.
- **The weather/cron endpoint is a fresh implementation, not a port** —
  the original daily logic lived in the external Claude Code Remote
  trigger's own instructions, which weren't available to port from. The
  weather-alert prompt in `api/cron/daily.js` is a reasonable first draft;
  review and adjust it.
- **One-time data migration** from the current Artifact (`read_db` dump →
  import into this schema) hasn't been done — this is a fresh, empty
  database until that happens.

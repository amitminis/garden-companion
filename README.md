# Garden Companion — web app

The web-app slice of the architecture in the project's
`garden-companion-iphone-app-architecture.md` doc: plain JS frontend,
Vercel Functions API, Neon Postgres, Vercel Cron, and the Anthropic
Messages API called directly for every AI touchpoint (`lib/ai.js`). No
native/iOS layer yet — that's Capacitor on top of this, later.

## What's here

```
public/            static frontend (index.html, css/, js/app.js, js/i18n.js)
api/
  plants/index.js       GET (list), POST (create)
  plant-detail.js        GET/PATCH/DELETE a plant, plus its research/
                          details/issue/photo/build-card sub-actions —
                          consolidated into one Function (see "Function
                          count" below); vercel.json rewrites route to it
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
  ai.js                   every AI call in the app — direct Anthropic
                          Messages API requests (text, JSON, multi-turn
                          chat, optionally with photos as image blocks)
  plant-photo.js          shared photo-analysis pipeline
  issue-diagnosis.js       shared diagnosis -> status/task pipeline
  handlers/plant-build-card.js  the "Add a plant" wizard's single AI call —
                          care guide + (if photos given) size/health, in one
                          request; see api/plant-detail.js's build-card action
  weather.js               Open-Meteo forecast -> friendly weather-card shape
  language.js              settings.language (he | en) + the "write in X"
                          instruction every AI prompt gets
  messages.js              the few strings the server writes itself, per language
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

## Phone-first UI & garden tips

- **Layout**: on phones (≤640px) the section tabs become a bottom tab bar,
  modals become bottom sheets (drag the handle down to dismiss), the Ask
  panel goes full screen, and safe-area insets are respected. Touch devices
  get 44px tap targets and 16px form text (so iOS doesn't zoom on focus).
  `public/manifest.webmanifest` + `public/icons/` make it installable to the
  home screen.
- **Dashboard**: greeting hero (weather-tinted, with a week-progress ring
  and a plain-language weather hint), a "Your garden" avatar row, garden
  tips, This week grouped by day (swipe a row right to mark it done, with
  Undo), and a weekly "Nice work" summary with a streak.
- **Garden tips**: written per month by the model for this garden's
  location, climate and plants (`GET /api/tips`, see the AI section below),
  plus forecast-driven weather tips (`public/js/tips.js`). "Add as task" creates a task with
  `kind: "tip"` through `POST /api/tasks` — no new Function. "Not now" is
  remembered per device in `localStorage`.
- **My garden** (the plant library tab): photo-first cards with a growth level (Seedling → Sprout →
  Bloom, from the knowledge score) and the plant's next task; search (6+
  plants), filter chips, sort, and a grid / "By spot" shelves view. Plant
  detail has a photo hero, a "next step" button, a growth journal and a
  first-vs-latest photo comparison slider.
- **Care guide readiness**: a care guide needs the plant's spot — where
  it's planted, sun exposure, watering and soil ("Not sure" counts as an
  answer). Until those four are in, the Care guide tab shows a checklist
  with a 4-step meter and a locked (greyed, 🔒) Build button that says
  what's missing; tapping it walks through the missing questions as
  tap-an-option chips. The wizard saves a plant without a guide when they're
  missing. Both the wizard's build-card call and "Build / Update care
  guide" (`/research`) now send those details to the model
  (`lib/care-prompt.js`).
- **My garden tiles**: each plant is a round tile — photo/emoji in a
  circle, a ring that fills with the knowledge %, the level along the top
  of the rim and what's next along the bottom (SVG `textPath`), on a
  "garden bed" panel. Phone-style red count badges (`plantAlerts()`:
  overdue tasks + a tracked problem + missing care-guide details) sit on
  the tiles, the Home plant avatars, the plant page ("N things need
  you" list with a fix button per item) and the Tasks / My garden tabs.
- **Tasks screen** (4th tab; Home is the dashboard): every task with
  search, Open/Done/All, kind chips (mine, care guide, problems,
  check-ins, tips) and a plant filter, grouped Overdue / Today / This week
  / by month. "+ New task" creates `kind: "manual"` tasks; any task can be
  edited or deleted (`DELETE /api/tasks/:id`, two-tap confirm) from its
  detail. Editing a future care-guide (`scheduled`) task is allowed, but
  "Update care guide" rebuilds those.
- **All tips sheet**: "All tips (N) →" on Home lists every tip for the
  month, including ones hidden with "Not now" (with "Show on Home"), and a
  month picker to browse the year; a tip added from another month is due
  early that month.
- **Knowledge score** (the level %): spot/sun/watering/soil/age 10 each (5
  for "Not sure"), species 5, care guide 25, a photo 15, a recent photo 5.

## Languages (Hebrew / English)

The whole app works in Hebrew (the default, right-to-left) or English,
chosen on onboarding's first screen or in Settings and saved as
`settings.language` (column added lazily by `lib/language.js`).

- **UI**: every string in `app.js` / `tips.js` is English source text
  passed through `tr()` / `trn()` (plurals, with a Hebrew dual "#2" form)
  from `public/js/i18n.js`, which holds the Hebrew dictionary. Constant
  tables mark strings with `N_()` and translate where they render, so
  switching language re-renders without a reload. `I18N.setLang()` sets
  `<html lang dir>`; CSS uses logical properties (`inset-inline-end`,
  `text-align:start`, …) so the layout mirrors. Swipe-to-complete goes
  leftward in Hebrew; the calendar's arrows and the before/after photo
  slider are direction-aware. Hebrew fonts: Heebo / Frank Ruhl Libre as
  fallbacks after the Latin fonts.
- **Saved values stay English**: preset answers (sun, watering, soil, age,
  spot), plant types, task `reason`s and weekday names are stored as
  English keys (the server and "Not sure" checks rely on them) and shown
  translated (`optLabel()`, `typeLabel()`).
- **AI output**: `getGardenContext().text` ends with "write everything
  for the gardener in Hebrew/English" (`languageInstruction()`), and every
  advice prompt includes that text — care guides, schedules, tips (cached
  per language), photo/problem diagnoses, weather alerts, Ask. Strings
  the server writes itself (diagnosis follow-up tasks, weekly check-in,
  fallbacks) come from `lib/messages.js`.
- **Existing content** (written before a language switch, or typed in
  another language) is translated in place by `POST /api/translate`
  (`lib/handlers/translate-garden.js`, sharing `api/settings.js`): one call
  per plant — name, care guide, schedule, photo notes, details and all its
  tasks together, so the new name is used consistently — and one for
  everything else (tasks without a plant, the location name, the weather
  alert). Only foreign-language strings are sent; preset answers stay
  English keys. Home shows a "still in English — translate everything"
  banner whenever any such content exists; Settings offers the same, plus
  "Rebuild all N care guides" to rewrite guides from scratch.
- `index.html` and the web app manifest default to Hebrew (name
  "שותף לגינה"), so nothing English shows before the app loads.
- **Adding a string**: write it in English inside `tr("…")`, add the
  Hebrew to `i18n.js`. Anything missing simply shows in English.

## What's ported vs. not

The frontend (`public/`) is a full port of `garden-companion.html`: the CSS
and page shell are copied verbatim, and `public/js/app.js` is the original
script with only its storage/AI calls swapped for `fetch('/api/...')`.
Onboarding wizard, dashboard (weather, This week, Upcoming, Your garden,
Recently done), Yearly plan calendar, plant detail (Overview / Care guide /
Issues), get-to-know wizard, Report a problem, Ask panel, and photo
analysis are all ported. Live `onSnapshot` updates are approximated with a
45-second poll.

Every AI touchpoint goes through `lib/ai.js` — one direct Anthropic Messages
API caller for the whole app, all requiring `ANTHROPIC_API_KEY`. Model:
**Claude Sonnet 5.5** (`claude-sonnet-5-5`) with adaptive thinking — effort
`low` by default, `medium` for care guides, photo/problem diagnoses and
garden tips; `max_tokens` 16000 (thinking counts toward it); replies are
read from `text` blocks by type; JSON replies for care guides and tips use
structured outputs (`output_config.format`); declines (`stop_reason:
"refusal"`) are retried server-side on another model (`fallbacks: "default"`,
beta `server-side-fallback-2026-07-01`).

Advice is grounded in the garden's real location: `lib/garden-context.js`
builds a short context for every advice prompt (care guides, tips, photo and
problem diagnoses, Ask, the daily weather alert) — the place name from
Settings (a GPS-only "Current location" goes in as coordinates alone), coordinates, and
month-by-month highs/lows/rain plus frost nights measured over the past year
(Open-Meteo archive API) — with an instruction to time everything to the
local climate (no frost protection where it doesn't freeze). The climate
summary is cached in the `garden_cache` table (created on first use; also
in `schema.sql`), climate refreshed every 90 days.

Care guides ask for 6-12 schedule entries covering the whole year, and
`lib/schedule.js` turns them into tasks over a **rolling 12 months** (next
occurrence of each month, this year or next), topped up daily by the cron.

Garden tips are generated per month for the garden (`GET /api/tips?month=N`,
rewritten to `api/ask.js?mode=tips` → `lib/handlers/garden-tips.js` to stay
within the Function cap) and cached per month + garden signature
(location + plants) in `garden_cache`, so each month costs one AI call until
the garden changes. `public/js/tips.js` now only holds the forecast-driven
weather tips.

| Endpoint | Calls |
|---|---|
| `POST /api/plants/:id/research` | `completeJson()` |
| `GET /api/tips?month=N` (garden tips) | `completeJson()`, cached per month |
| `POST /api/plants/:id/build-card` (the "Add a plant" wizard) | `completeJson()`, with photos if given |
| `POST /api/plant-extract` (onboarding + quick-add) | `completeJson()` |
| `POST /api/plants/:id/details` (get-to-know answer normalization) | `complete()` |
| `POST /api/ask` | `chat()` — real multi-turn, not a flattened prompt |
| `POST /api/plants/:id/issue` | `completeJson()`, with the photo if one was attached |
| `POST /api/plants/:id/photo`, `POST /api/tasks/:id/photo` | `completeJson()` / `complete()` with a photo |
| `GET /api/cron/daily` (weather-alert reasoning) | `completeJson()` |

Without `ANTHROPIC_API_KEY`, every one of these degrades gracefully instead
of failing the request: photos are still saved without analysis, plants
stay "unresearched," Ask returns a fallback message, and so on — see each
handler's catch block, which pattern-matches on `AI_UNAVAILABLE`.

This app previously ran text-only touchpoints through a Vercel Sandbox
running the Claude Agent SDK (`lib/sandbox-agent.js`, now removed) so they
could authenticate with a personal Claude subscription
(`CLAUDE_CODE_OAUTH_TOKEN`) instead of a metered API key. That only ever
made sense for a single personal user — a subscription token authenticates
as one person, not as a product serving other people — and none of the
touchpoints used the Agent SDK's actual point (tool use, multi-step
agency): every one was a single prompt in, one reply out. Calling the
Messages API directly is faster (no sandbox cold start), removes a whole
dependency, and puts the app on the right footing for real usage: metered
billing under one API key, with normal cost controls (see "Known gaps"
below).

## Setup

1. **Neon Postgres**: in the Vercel dashboard, add the Neon integration
   (Marketplace tab) to a project, which sets `DATABASE_URL` automatically.
   Then run `schema.sql` against it once (Neon's SQL editor, or `psql
   $DATABASE_URL -f schema.sql`).
2. **Claude auth**: generate a key at console.anthropic.com and add it as
   `ANTHROPIC_API_KEY` (Project Settings → Environment Variables). Required
   for every AI touchpoint (`lib/ai.js`) — without it they degrade
   gracefully rather than fail (see above), but nothing gets AI-generated.
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
- **No AI cost controls yet.** Every touchpoint in `lib/ai.js` calls the
  Messages API with no rate limiting, no per-user budget, and no usage
  tracking — fine for a single-user testing deployment, not for a real
  product with other people's traffic on your API key. Before that: a
  spend alert in the Anthropic console at minimum, and likely per-user rate
  limits once there's real auth (see the first gap above).

<!-- verifying git-triggered deploy -->

# Hexstory: design & operations

> **Every place has a story.** A world map of connected, sourced history: anyone can discover what happened
> where and when, follow events as they develop, connect them, and help correct the record.

This file is the single source of truth for how Hexstory works: what it is built with, why it is built that
way, and how to run and change it. **Every change to behaviour, schema, tooling, policy or procedures must
update this file in the same change**, including a line in the [Changelog](#changelog).

---

## 1. Product overview

| Name | What it is |
|---|---|
| **Hexstory** | The site. Tagline: "Every place has a story." |
| **The Map** | Full-screen globe, always visible: one dot per story at its precise place, a timeline slider, category filters and optional layers (density, category, period, developing). The H3 hexagon grid is how the map groups and lets you browse places, not how stories are stored. |
| **Discover** (home) | The panel beside the map on `/`: featured stories, developing events, newly documented history, recent events, on this day, collections, and "Surprise me" / "Explore a random event" / "History near me" / "On this day". |
| **Stories** | User-written, sourced accounts of events. Each has a date, a precise place (and optionally a wider area), a short summary, 1–3 categories, sources, connections to other stories and the people involved, then the full account. |
| **Timeline** | An event's chronological feed of **developments**, each with its own date, place and sources (instead of a new story per development). |
| **Corrections** | Readers dispute a quoted statement, propose a fix with counter-evidence; reviewers decide with a public note. The disputed version stays in the history. |
| **Collections** | Narratives grouping stories, hand-picked and/or gathered by rules (an area, categories, years): "The history of Manhattan", "The Arab Spring". |
| **Versions** | The append-only edit history of a story. Nothing is ever overwritten. |
| **Watchtower** | The review queue for Reviewers: pending edits, new stories, held timeline developments, open corrections, reports. |
| **Moderation** | The Moderators' screen: ban requests from Reviewers, every user with their level, the audit log. |
| **Your account** (`/me`) | Your role, your (private) reputation and progress toward the next level, today's limits, everything you started or edited. |

Principles:

- **Map first, guided, no sign-up wall.** Visitors land on the globe with something to read straight away
  (the Discover panel); clicking hexagons still works but is no longer the main way in. Signing in (Google)
  is only needed to write, edit, correct or report.
- **Calm UI that suits a young site.** One floating panel at a time, a quiet palette, no live presence
  counts, public rankings or "nobody here" rooms. Features that need a large community to be useful are left
  out until there is one.
- **Connected records, not isolated articles.** Stories link to causes, consequences, the larger events they
  belong to, people and places; ongoing events grow a timeline instead of spawning near-duplicate stories.
- **Opinions welcome, sources required.** Every story needs at least one source. Sources are *not*
  verified yet; the source count is shown on every story so readers can judge at a glance.
- **Trolls can add noise but can't destroy anything.** Append-only revisions, trust levels, held edits, reports.
- **Quality over quantity.** Reputation rewards accepted, well-sourced and corrected work, not volume.
- **Cheap to run until it's popular.** Everything fits free tiers: no WebSockets, Redis optional, the map
  and home page served from the CDN cache, map filtering done in the browser.

## 2. Repository layout

```
├── api/index.js             Vercel Function entry: re-exports the bundled API server
├── apps/
│   ├── api/                 Fastify server (REST), serves index.html for page navigations
│   │   ├── migrations/      Numbered SQL migrations (never edit an applied one)
│   │   ├── src/
│   │   │   ├── index.ts     Long-running server (local dev, single machine): config → checks → listen
│   │   │   ├── serverless.ts  Vercel entry: builds the app once per instance, exports its Node server
│   │   │   ├── runtime.ts   Wires the app to Postgres, Redis/memory coordination and storage; DB guard
│   │   │   ├── app.ts       Fastify assembly: security headers, CSRF check, session, rate limits, routes
│   │   │   ├── config.ts    Env var schema (fails fast on bad config; Vercel-specific defaults)
│   │   │   ├── migrate.ts   The migrate command, its lock, the environment marker and the startup check
│   │   │   ├── coordination.ts  Cross-instance state: Redis (rate limits, cooldowns, caches) or in-memory
│   │   │   ├── policy.ts    ALL anti-abuse numbers & rules (rate limits, promotion, auto-flags)
│   │   │   ├── auth/        Google OAuth flow, sessions
│   │   │   ├── routes/      Thin HTTP layer: parse input → call a service
│   │   │   ├── services/    Business logic + SQL (stories, developments, corrections, collections, discover, users, reports, modlog)
│   │   │   ├── storage/     Image storage interface: local disk (dev) and Cloudflare R2 (`r2.ts`)
│   │   │   ├── import.ts    Bulk import command (docs/IMPORT.md); logic in import/ (format, link/place checks, run)
│   │   │   └── seed.ts      Dev-only sample stories
│   │   └── test/            Integration tests (real Postgres) and `*.unit.test.ts` (no services)
│   └── web/                 React SPA (Vite)
│       └── src/
│           ├── main.tsx     Routes
│           ├── api/         fetch client + React Query hooks (all query keys in one place)
│           ├── map/         MapLibre globe, layers, timeline/filter controls, map↔panel shared state
│           ├── views/       One file per panel/page
│           ├── components/  Small shared UI pieces
│           ├── content/     About page markdown
│           ├── features.ts  Feature flags (ads etc.)
│           └── styles/      global.css (design tokens at the top)
├── packages/shared/         Types, Zod schemas, hex, date & history helpers (categories, relations, ranges) used by BOTH api and web
├── legal/                   Terms of Service, Privacy Policy (rendered in-app at /terms, /privacy)
├── docs/DESIGN.md           This file
├── docs/DEPLOYMENT.md       Vercel + Neon + R2 + Redis Cloud + Google setup, step by step
├── docs/IMPORT.md           Bulk import: the file format, research rules for gathering events, how to import
├── data/import/             Import files (events-NNN.jsonl) and their photos/
├── scripts/vercel-build.mjs The Vercel build: web app, API bundle, static output, database check
├── vercel.json              Vercel project config: build, Function settings, routing
├── doppler.yaml             Doppler project/config binding
└── .env.example             Every environment variable (no values)
```

Shared validation lives in `packages/shared/src/schemas.ts`: the editor validates with exactly the same
rules the API enforces, so client hints and server errors never disagree.

## 3. Tools & stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere (strict) | One language, shared types between client and server |
| Workspace | npm workspaces | No extra tooling |
| Frontend | React 19, React Router 8, TanStack Query 5, Vite 8 | Mainstream, well-documented |
| Map | MapLibre GL 6 (globe projection) + OpenFreeMap "positron" tiles | Free, no API key, quiet basemap |
| Hex grid | Uber H3 (`h3-js`) | Hierarchical hexes; cell IDs are plain strings, no geometry storage |
| Backend | Fastify 5 | Fast, plugin-based, good security plugins |
| Database | PostgreSQL (14+) via `postgres` (postgres.js 4), plain SQL | Transparent queries, no ORM magic |
| Validation | Zod 4 | Shared schemas |
| Auth | Google OAuth via `arctic` (PKCE + state), own session table | Small, auditable |
| Story editor | TipTap 3 (ProseMirror) | Reliable document-style editing; its output is converted to our own format |
| Images | `sharp` (re-encode to WebP, strip metadata) | Removes GPS/EXIF from protest photos |
| Secrets | Doppler (`doppler run --`) locally; Vercel environment variables in deployments | No secrets in files |
| Hosting | Vercel: CDN for built assets and cacheable public API responses, one Node Function (Fluid compute) for everything else | Same origin for app, API and auth |
| Production database | Neon PostgreSQL (Vercel Marketplace), pooled URL for the app, direct URL for migrations | Serverless-friendly Postgres; plain SQL unchanged |
| Image storage | Cloudflare R2 via its S3 API, signed with `aws4fetch` | Cheap egress, custom-domain CDN; tiny fetch-based client |
| Shared state (optional) | Redis Cloud (Vercel Marketplace) via `ioredis` | Atomic counters and small caches shared by Function instances |
| Tests | Vitest (shared unit tests, API integration tests, `ioredis-mock` for two-instance tests) | |
| Map data | One cached list of story points, filtered/coloured/counted in the browser | Timeline and layer changes cost no requests |

Locally the API runs TypeScript directly with `tsx`. For Vercel, `scripts/vercel-build.mjs` bundles
`apps/api/src/serverless.ts` (plus `packages/shared`) into one ES module with esbuild; npm packages stay
external so Vercel traces them (and sharp's native binaries) into the Function.

## 4. Running it

### First-time setup (local)

1. **Postgres**: create a role and database (once):
   ```bash
   sudo -u postgres psql -c "CREATE ROLE hexstory LOGIN PASSWORD 'choose-a-password'" \
                         -c "CREATE DATABASE hexstory OWNER hexstory"
   ```
2. **Doppler**:
   ```bash
   doppler projects create hexstory        # once per workspace
   doppler setup                           # in the repo; uses doppler.yaml (project hexstory, config dev)
   doppler secrets set DATABASE_URL="postgres://hexstory:choose-a-password@localhost:5432/hexstory"
   doppler secrets set APP_ORIGIN="http://localhost:5173"
   doppler secrets set ADMIN_EMAILS="you@example.com"     # becomes a Moderator on sign-in
   ```
3. **Google sign-in** (optional for dev; without it the site is read-only):
   Google Cloud Console → APIs & Services → OAuth consent screen (External, scopes `openid email profile`,
   add the Privacy Policy and Terms URLs) → Credentials → *OAuth client ID* (Web application) with
   authorised redirect URI `http://localhost:5173/auth/google/callback` (and later
   `https://<your-domain>/auth/google/callback`). Then:
   ```bash
   doppler secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
   ```
4. `npm install`, then `npm run dev`. It runs `migrate` (marking the database as `development` the first
   time), then starts the API on :3000 and the web app on :5173 (Vite proxies `/api`, `/auth`, `/media`,
   to the API, so everything is one origin). Local development needs no cloud services: images go to
   `UPLOAD_DIR`, and without `REDIS_URL` rate limits and caches stay in the process.
   The API itself never migrates; if it says migrations are pending, rerun `npm run dev` or `npm run migrate`.
5. Optional sample content: `doppler run -- npm run seed -w @hexstory/api` (refuses to run in production):
   eleven stories with places, summaries, categories, people and connections, an ongoing war with two
   timeline developments, and three collections (a theme by rule, a theme by hand, a place by area).

### Configuration (environment variables)

Locally they come from Doppler; on Vercel from the project's environment variables (some injected by the
Neon and Redis integrations). The complete reference, with which are secrets and where each comes from, is
in [DEPLOYMENT.md §7](DEPLOYMENT.md#7-environment-variable-reference). The important ones:

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string (Neon: the **pooled** one) |
| `DATABASE_URL_UNPOOLED` | for migrations on Neon | Direct connection; `migrate` refuses pooled URLs |
| `APP_ORIGIN` | yes | Public origin, e.g. `https://hexstory.example`. Used for OAuth redirect and CSRF origin checks |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for sign-in | Without them sign-in is disabled (read-only site) |
| `ADMIN_EMAILS` | no | Comma-separated emails of Moderators (promoted at sign-in; removing an email revokes it on their next request) |
| `GEOCODER_URL` | no | Photon geocoder for the place search (default `https://photon.komoot.io`; set your own instance for heavy use) |
| `STORAGE_BACKEND` | no | `local` (default; `UPLOAD_DIR`) or `r2` (default and required on Vercel) |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_STAGING_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_BASE_URL` | with `r2` | See DEPLOYMENT.md §3 |
| `REDIS_URL` | no | Rate limits, cooldowns and caches shared by all instances. Without it each instance keeps its own (fine for a small site; daily limits live in Postgres regardless) |
| `DB_POOL_MAX` | no | Connections per process (default 10; 5 on Vercel) |
| `USAGE_*` | no | Moderators' resource usage dashboard: optional monitoring credentials (`USAGE_CLOUDFLARE_API_TOKEN`, `USAGE_NEON_API_KEY` + `USAGE_NEON_PROJECT_ID`), `USAGE_LIMIT_*` allowances (never assumed), thresholds and cache time. See [DEPLOYMENT.md, Resource usage dashboard](DEPLOYMENT.md#resource-usage) |
| `TRUST_PROXY` | no | `true` when behind a proxy that overwrites `X-Forwarded-For` (default `true` on Vercel) |
| `PORT`, `NODE_ENV`, `UPLOAD_DIR` | no | Local server settings (`NODE_ENV` defaults to `production` on Vercel) |
| `STRIPE_SUPPORT_URL`, `PAYPAL_SUPPORT_URL` | no (public, runtime) | Support page links (Stripe Payment Link on `buy.stripe.com`; PayPal.Me on `www.paypal.com/paypalme/…` or `paypal.me`). Validated at startup; an invalid value hides that option and logs a warning. Redeploy on Vercel after changing. See [DEPLOYMENT.md](DEPLOYMENT.md#support-links) |
| `VITE_MAP_STYLE_URL` | no (build-time) | Alternative MapLibre style; also add its origin to `MAP_ORIGINS` in `apps/api/src/app.ts` (CSP) |
| `VITE_FEATURE_ADS` | no (build-time) | `true` renders ad slots (see Extension points) |

`VERCEL` and `VERCEL_ENV` are set by Vercel. `VERCEL_ENV` (`production`/`preview`) decides which database
the deployment may use (see "Environments" below); locally it is `development`.

### Deployment (Vercel)

Full, click-by-click setup is in **[docs/DEPLOYMENT.md](DEPLOYMENT.md)**. The shape:

- **One Vercel project** at the repo root (framework preset *Other*), configured by `vercel.json`.
  The build (`scripts/vercel-build.mjs`) builds the web app, copies it **minus `index.html`** to
  `apps/web/dist-static` (the CDN output), and bundles the API to `apps/api/dist/vercel.mjs`.
- **One Function**, `api/index.js`, exports Fastify's Node server. A single rewrite sends every path except
  `/assets/*` to it, so `/api`, `/auth` and page navigations all reach Fastify with their original paths.
  Static files (`/assets/*`, `favicon.svg`) are served by the CDN first; a missing asset is a plain 404.
- `index.html` is deliberately **not** a static file: Fastify serves it so every page gets the same Helmet
  headers, including a CSP whose image/upload origins come from the R2 settings at runtime.
  On Vercel it reads the HTML once per instance and sends it directly. `@fastify/static` is loaded only
  for local/self-hosted file serving: its CommonJS dependency chain requires an ESM-only package and
  fails with `ERR_REQUIRE_ESM` in runtimes that disable synchronous `require(ESM)`.
- Module scope in `serverless.ts` runs once per Function instance: one database pool and (with `REDIS_URL`)
  one Redis connection per instance, never per request.
- Functions run up to `maxDuration` (60 s in `vercel.json`; no request needs more, and a low cap bounds the
  cost of a stuck one).
- Public, viewer-independent responses (`/api/map/points`, `/api/discover`) send
  `Cache-Control: s-maxage=60, stale-while-revalidate=600`, so the CDN answers most of them without invoking
  the Function or waking the database.
- A Vercel Function accepts at most 4.5 MB per request, so image originals (up to 6 MB) are uploaded by the
  browser straight to R2 (§8, "Malicious uploads").

### Environments and migrations

- **Migrations never run while serving.** `npm run migrate` (locally) or `npm run migrate:production` /
  `migrate:preview` (`scripts/migrate-remote.mjs`, which asks for the direct connection string) applies them over the **direct** connection, holding a
  session-level advisory lock so a second concurrent run fails immediately. Each file runs in its own
  transaction with `lock_timeout = 15s`.
- **Environment marker.** `migrate --env <name>` records the environment in `app_meta`. Migrating a database
  marked for another environment fails (unless `--retarget`, for deliberate copies such as a Neon branch).
- **Startup and build checks.** The API refuses to start unless the database is marked for this deployment's
  environment (`VERCEL_ENV`, else `development`) and has every migration in `apps/api/migrations`; it never
  applies them itself. Production and preview builds run the same read-only check (`migrate --check`) so a
  deployment that couldn't start is never promoted. A preview deployment pointed at the production database
  therefore fails to build and to start, instead of writing to it.
- Redis keys are prefixed `hx:<environment>:`, so environments sharing one Redis database don't collide.

### Tests

```bash
npm run typecheck
npm test                       # shared unit tests + API unit tests (*.unit.test.ts)
TEST_DATABASE_URL=postgres://.../hexstory_test npm test -w @hexstory/api   # + integration tests
TEST_REDIS_URL=redis://localhost:6379 TEST_DATABASE_URL=... npm test -w @hexstory/api  # two-instance tests on a real Redis
```

API tests **wipe** the database in `TEST_DATABASE_URL` (`DROP SCHEMA public CASCADE`). Never point it at real
data. `test/moderation.test.ts` covers private newcomer stories, levels, ban requests, bans with and without
clean-up, account deletion, removed versions, user pages and the audit log. `test/history.test.ts` covers
precise locations, connections in both directions, list filters and orderings, event timelines,
corrections, quality-based reputation, collections and the discovery endpoints. `test/instances.test.ts`
runs two app instances sharing Postgres and Redis (ioredis-mock unless `TEST_REDIS_URL` is set) and checks
shared rate limits.

## 5. Architecture

```
                         ┌── /assets/* ─────────── Vercel CDN (built JS/CSS)
Browser ── React SPA ────┼── /api/map/points, /api/discover ── Vercel CDN cache (s-maxage 60) ─┐
   (MapLibre globe)      ├── pages, /api, /auth ───────────────────────────────────────────────┼── Fastify (N Function instances)
                         │                                                                     │      ├── Neon Postgres (pooled; durable data)
                         │                                                                     │      ├── Redis Cloud, optional (rate limits, cooldowns, caches)
                         │                                                                     │      └── R2 (write processed images, read staged originals)
                         ├── PUT original ─────────────── R2 staging bucket (pre-signed URL, private)
                         ├── <img> ────────────────────── R2 public bucket via custom domain
                         └── tiles ────────────────────── OpenFreeMap
```

- Locally the same app runs as one process (`npm run dev`): images on disk at `/media`, rate limits and caches in memory.
- On Vercel each Function instance runs the whole Fastify app; nothing an instance keeps in memory is relied
  on across requests except connection pools and short-lived caches.
- The SPA keeps the map mounted permanently; every route renders into a single floating **panel**
  (`components/Panel.tsx`): a right-hand card on desktop and a bottom sheet under 720px.
- Map ↔ panel communication goes through `map/MapContext.tsx`: active hex, the story being read (point,
  area, development markers), highlighted stories (a list or collection being read), the layer, the
  time/category filters (which lists follow too), the editors' select mode (`point` or `area` tool), and
  `focusCells()` / `focusPoints()` (which wait for the map to load and only move the camera when the target
  is hidden under the panel).

### Places and the hex model

- **Every story has a precise point** (`lat`, `lng`, optional `place_name` such as "Tahrir Square, Cairo"),
  picked by searching a place or clicking the map. That is where the map draws it. A story **may** also mark a
  wider area (e.g. a war front or a march route); without one, it is indexed at the hexagon its point falls
  in. Hexagons are a way to browse and visualise places, not the only way an event is located. Stories from
  before migration 007 have no point; the map uses the centre of their area (`cellsCenter`).
- Developments in a timeline have their own optional point, so an event's map shows where each step happened.
- Areas are stored at **base resolution 5** (~253 km² per hex).
- The map shows resolution **2/3/4/5** depending on zoom (`resForZoom` in `packages/shared/src/hex.ts`).
- `story_cells` indexes every story under its base cells **and all their parents** (res 2–5), so "stories in
  this hex" is a single indexed lookup at any zoom, and place collections match stories by intersecting it.
- The map's density layer counts story **points** per display hexagon in the browser; a story covering a
  continent counts once, where it happened, rather than in every hexagon it touches.
- Revisions store the selection **compacted** (`compactCells`) to keep rows small; the index is rebuilt
  from the current revision whenever it changes.
- A story may cover up to **5,000 base cells (~1.26M km²)**. The size check uses `baseCellCount()` *before*
  expanding, because expansion is exponential in resolution.
- In the editor, clicking a hex at the current zoom adds or removes all of its base cells, so zoomed out one
  click covers a large area and zoomed in gives precision. The UI shows the area in km², not a hex count.

### Data model (`apps/api/migrations/001_init.sql`)

| Table | Purpose |
|---|---|
| `users` | Google `sub`, email (private), public `display_name` (unique, case-insensitive), `trust_level` 0–3, `trust_locked` (level set by a Moderator), `terms_accepted_at`, `banned_at`, `deleted_at` |
| `sessions` | `id` = SHA-256 of the cookie token (raw token never stored), expiry (30 days, sliding) |
| `stories` | Identity + pointer `current_revision_id`, `status` (unreviewed/active/hidden), `protection_level`, `cell_count`, `published_at` + `published_revision_id` (when it first became public, and with which version; migration 006), `last_update_at` (latest accepted version or development) and `featured_at` (reviewers' pick for the home page; migration 007), `import_key` (unique; the event's key in an import file) and `import_batch` (migration 008) |
| `story_revisions` | Append-only content: title, `summary`, `content` (rich document, jsonb), `body` (plain text derived from content), `image_key`/`image_credit` (the first image, used as thumbnail), `categories` (text[]), point `lat`/`lng` + `place_name`, compact `cells` (the area, or the point's cell), dates, sources (jsonb, ≥1 enforced by CHECK), `people` (text[]), `links` (jsonb `[{storyId, relation}]`), `status` (pending/accepted/rejected), `flags`, `hidden_at` (removed from the history), `origin` (create/edit/restore/rollback: copies aren't counted as the copier's edits), generated `source_count` and `sort_key` |
| `story_cells` | Derived index of the current revision's cells at res 2–5 |
| `story_links` | Derived index of the current revision's `links` (from, to, relation), rebuilt with `story_cells`, so a story can list what links **to** it (migration 007) |
| `story_developments` | An event's timeline: date parts + generated `sort_key`, headline, optional details, optional point, sources, `status` (pending/accepted/rejected), `hidden_at`. Not edited after posting (migration 007); `import_key` for imported ones (migration 008) |
| `corrections` | A disputed statement: the `revision_id` read, the exact `quote`, `problem`, `proposal`, `evidence` (sources), `status` (open/accepted/rejected), public `resolution_note`, `resolved_by/at`, optional `fixed_revision_id`, `hidden_at` (migration 007) |
| `collections`, `collection_items` | Narratives: title, description, `kind` (place/theme), rules (`cells` compacted at res 2–5, `categories`, `from_year`/`to_year`), `status` (active/hidden), `featured_at`; hand-picked items with `position` and a note (migration 007) |
| `comments` | The retired Square's messages. Dormant: no longer read or written; kept so no data is destroyed (drop it in a later release if wanted) |
| `reports` | User reports on stories, revisions, users, developments, corrections or collections (old ones about chat messages were closed by migration 007) |
| `mod_actions` | Append-only audit log of every moderation action, with optional `details` (jsonb) |
| `ban_requests` | Reviewers asking Moderators to ban someone; resolved as banned/declined/deleted (migration 004) |
| `site_settings` | Runtime settings Moderators change, e.g. `rules` overrides (migration 005) |
| `uploads` | One row per photo upload slot: declared original size, stored WebP size; daily quotas; each slot is completed at most once (migration 005) |
| `banned_subjects` | SHA-256 of the Google account of banned people whose account was deleted, so they can't sign up again (migration 006) |
| `app_meta` | Facts about the database itself; `environment` = which deployment environment owns it (migration 003) |
| `schema_migrations` | Applied migration files |

**Story content.** Bodies are stored as a small, flat document format of our own
(`packages/shared/src/richtext.ts`): paragraphs, headings, quotes, bulleted/numbered lists and images,
with text that may be bold, italic or a link. It is deliberately *not* the editor's internal format:
the web app converts TipTap JSON to it (`apps/web/src/lib/richtext.ts`), dropping anything unsupported,
and the API validates it strictly (links must be http(s); images may only reference our own uploads by key
and must exist; ≤ 12 images, ≤ 400 blocks, 40–10,000 characters of text). The server derives `body` (plain
text, images as `[Image: caption]`) for diffs, the large-removal check and link counting, and adds a `url` to
image blocks when sending them. Revisions from before migration 002 have `content = NULL` and are rendered
from `body` (`legacyDoc`).

**Dates.** Stored as separate year/month/day parts (historical years: negative = BCE, no year 0), plus
`is_ongoing` and `is_approx` ("c. 1848"). An event covers a span of comparable keys (`year*10000 +
month*100 + day`): missing parts widen it ("1848" = 1 January to 31 December 1848) and ongoing events never
end (`eventRange` in `packages/shared/src/history.ts`, mirrored in SQL by `loKeySql`/`hiKeySql` in
`services/stories.ts`). Time filters (the map's timeline, lists' `from`/`to` years, collections' years) keep
every event whose span overlaps the chosen years.

**Orderings** (`?sort=` on every list; `STORY_SORTS`):

| Sort | Meaning |
|---|---|
| `occurred` (default) | When it happened: latest date touched first, ongoing events first |
| `published` | When it was published on Hexstory, newest first |
| `updated` | Latest accepted version or timeline development first |
| `significance` | "Most connected": 3 × published stories linking to it + 2 × developments (max 10) + sources (max 5) + 10 if featured. A record of how the community has connected it, never how many stories a place has |
| `relevance` | With a search: title starts with / contains the words first. In a region: stories about that place specifically (a point or small area) before wide ones. Otherwise as `significance` |

**New events vs newly documented history.** A story is a *historical account* (`isHistorical`) when the
latest date it touches is more than a year (`HISTORICAL_GAP_DAYS`) before it was published; otherwise it was
written as it happened. Lists filter with `?kind=new|historical`, and the home page keeps the two apart
("Recent events" vs "Newly documented history").

**Categories** (`CATEGORIES`, 1–3 per story): war & conflict, protest, political decision, science &
discovery, disaster, cultural movement, historical landmark, local event. **Connections** (`LINK_RELATIONS`):
a version names other stories it was *preceded by*, *led to*, is *part of*, *includes*, or is *related* to;
each link shows on both stories, with the inverse relation on the other one. Links may point at published
stories or at your own unpublished ones; at most 20 per version. **People** are names (up to 20) that link
to every story mentioning the same person.

## 6. Trust & moderation

The numbers users see (daily limits, reputation points, promotion thresholds, held-edit thresholds) live in
`RULES` and `REPUTATION` (`packages/shared/src/rules.ts`), so the About and account pages always show what the API enforces;
the rest are in `apps/api/src/policy.ts`. Change them there and update this section. The About page explains
all of this to users (`apps/web/src/content/about.md`, with `{{…}}` tokens filled from `RULES`).

Thresholds below are the defaults; Moderators can change them (see "Rules Moderators can change").

| Level | Name | How you get it | What changes |
|---|---|---|---|
| 0 | Newcomer | Sign in + accept terms | New stories are **private until a Reviewer approves them** (only you and Reviewers see them; you can keep editing them meanwhile). Edits to other people's stories are **held for review** |
| 1 | Member | Account ≥ 3 days **and** reputation ≥ 15 (e.g. three published stories, or one well-sourced story plus an accepted correction) | Stories, edits and timeline developments go live immediately (unless auto-flagged or the story is protected); can start collections |
| 2 | Reviewer | Account ≥ 30 days, reputation ≥ 150, **≥ 10 published stories started by someone else that they improved or corrected**, accepted work in **≥ 4 different weeks** | Watchtower: approve new stories, accept/reject held edits and developments, decide corrections, restore or remove versions, remove developments and open corrections (not their own, nor on stories they started), hide stories and collections, feature stories and collections, resolve reports, **ask Moderators to ban someone**; see anyone's contributions |
| 3 | Moderator | Email in `ADMIN_EMAILS` | Everything above + Moderation screen: ban (keeping or removing posts), unban, set levels, delete accounts, decline ban requests, read the audit log; protect and unhide stories and collections, put back removed versions, decide (and remove) corrections to stories they started, remove decided corrections |

**Reputation (quality, not quantity).** Computed on demand from what happened to someone's work
(`reputationOf` in `services/users.ts`, points in `REPUTATION`), never stored, never public: only the person
and reviewers see it, and there are no rankings or leaderboards.

| What | Points |
|---|---|
| A published story you started | +5 |
| Each linked (URL) source on your published stories, up to 3 per story | +1 |
| Each published story by someone else you improved with an accepted edit (**once per story**, however many edits) | +3 |
| Each accepted timeline development, up to 5 per story | +2 |
| Each of your corrections a reviewer accepted | +8 |
| Each week with something of yours accepted (steady participation), up to 52 | +1 |
| Each of your corrections turned down | −2 |
| Each of your edits or new stories turned down | −2 |
| Each accepted correction to a story you started | −2 |
| Each version, development or correction of yours removed, and each published story of yours hidden | −15 |

The total never goes below 0. Drafts nobody published earn nothing, so repeatedly editing your own story or
writing unreviewed drafts can't farm it (tested).

**Rules Moderators can change** (Moderation → Settings, no deploy): the Member and Reviewer promotion
thresholds: days since joining (i.e. how long the Newcomer period lasts), minimum reputation, and for
Reviewers the stories by others improved or corrected and the active weeks. They are stored as overrides in `site_settings` (key
`rules`), validated by `editableRulesSchema` (whole numbers; Reviewer requirements ≥ Member ones), merged
over the code defaults by `effectiveRules()`, served publicly at `GET /api/rules` (the About page uses it)
and cached per instance for 30 s (`services/settings.ts`), so every Vercel instance applies a change within
a minute. Nobody is re-evaluated on the spot: promotion is re-checked at each person's next accepted
contribution or sign-in; lowering a requirement never demotes, and levels set by hand are untouched. Every
change is in the audit log (`settings:rules`, with before/after values). Daily limits and size limits stay
in code on purpose: they protect hosting costs.

Promotion is automatic, by reputation (above), and never demotes. Overrides saved before migration 007 for
the old story-count thresholds are ignored.

**Manual levels.** A Moderator can set anyone's level to Newcomer, Member or Reviewer. That sets
`users.trust_locked`, which pauses automatic promotion for them (so a demotion sticks); "Automatic" clears it
and re-runs promotion, which may raise them again but never lowers them. Moderator access can't be granted or
removed in the UI: it follows `ADMIN_EMAILS` both ways. Someone taken off the list is treated as a Reviewer
from their next request (checked per request in `app.ts`) and stored as one at their next sign-in.
Moderators can't ban, delete or re-level other Moderators or themselves.

**Rules that make overwriting useless:**

1. **Append-only revisions.** An edit inserts a new revision; `stories.current_revision_id` points to the
   live one. Restoring an old version copies it into a *new* revision, keeping history linear.
2. **New stories.** A Member's story is `active` (public) at once. A Newcomer's is `unreviewed`: visible only
   to its creator and Reviewers, listed in its hex only for them, never counted on the map. A Reviewer
   publishes it ("Approve and publish", sent with the version they read: 409 `stale` if the creator changed
   it since) or hides it. Accepting a held *first* version of an unreviewed story also publishes it. Nobody
   can approve their own story.
3. **Held edits and developments.** A timeline development follows the same rule as an edit (without the
   auto-flags), except that a Newcomer's developments on their own still-unreviewed story are always held:
   approving the story checks the version the reviewer read, not its timeline. An edit goes live only if the author's trust ≥ `max(Member, story.protection_level)`
   (or they created the still-unreviewed story) **and** it has no auto-flags (unless the author is a Reviewer).
4. **Auto-flags** (`detectFlags`): removing > 60% of the body (`large-removal`); newcomer adding > 2 links,
   counting both linked text and typed URLs (`many-links`).
5. **Optimistic concurrency.** Edits carry `baseRevisionId`; if the story moved on, the API returns 409
   `stale` and the user must reload, so concurrent editors never silently overwrite each other.
6. **No self-review.** Nobody can accept their own held edit or approve their own story. Restore only
   accepts versions that were once accepted (and not removed) and respects protection, so it can't be used
   to sneak a held edit live.
7. **Visibility.** Pending and rejected versions (which may contain abuse) are visible only to Reviewers
   and their author. Hidden stories are visible only to Reviewers; only Moderators can unhide (and not while
   the current version is removed).
8. **Removed versions.** A Reviewer can remove a version from the history (`story_revisions.hidden_at`), e.g.
   one that exposed someone's address: it is then visible to Reviewers only and can never be restored. The
   current version can't be removed (restore an earlier one first). Only Moderators can put one back.
9. **Daily limits** per trust level (stories 3/10/100/1000, edits and timeline developments together
   10/20/300/5000, corrections 5/20/100/1000, collections 0/3/20/100, photo uploads
   10/30/100/300 and 20/80/250/1000 MB of originals, reports 30), enforced inside the write transaction under
   a per-user advisory lock so parallel requests can't exceed them. Photo uploads also keep the hourly limit
   (20/hour); every upload slot counts, completed or not, because an abandoned original still sat in staging.
   **Size limits** bound what one troll can store: story text 10,000 characters, ≤ 12 photos, ≤ 20 sources,
   and at most 64 KB of stored content per version (`LIMITS.contentBytesMax`, so heavy formatting or hundreds
   of long links can't inflate it; every edit stores a full copy); JSON request bodies ≤ 256 KB; image
   originals ≤ 6 MB, re-encoded to ≤ 1600 px WebP. Worst case per Member per day: 20 edits × 64 KB of text
   and 80 MB of photo originals (published WebP is much smaller).
10. **Reports** from any signed-in user, about a story, a version, a development, a correction, a collection
    or a person (once per item while open), go to the Watchtower. Hiding a story or collection, removing a
    version, development or correction, or banning a user closes the reports about it.
11. **Ban requests.** Reviewers can't ban; they ask (`ban_requests`, one open request per reviewer per user,
    with a reason). Requests queue on the Moderation screen until a Moderator bans (resolves them as
    `banned`), declines (`declined`) or deletes the account (`deleted`).
12. **Bans** (Moderators) delete the user's sessions and block all writing immediately. The Moderator chooses:
    - **Keep posts:** stories and edits stay up. Unbanning restores the account (and their messages).
    - **Remove posts** (`removeContent`, also available later for someone already banned): stories they
      started are hidden; stories whose current version is theirs roll back to the latest accepted version by
      someone else (hidden if there is none); their held edits are rejected; **all** their versions are
      removed from the history, so nothing of theirs can be viewed or restored; their timeline developments
      and corrections are removed and their collections hidden; reports they filed are dismissed and reports
      about their content closed. Changes others made on top of
      their edits stay (Reviewers can restore further back by hand). Unbanning does not bring any of it back.
13. **Deleting an account** (Moderators) anonymises it exactly like self-deletion ("Deleted user", signed out,
    email removed), optionally removing posts first as above. The person can sign up again as a new
    Newcomer; to keep someone out, ban them instead.
14. **Audit log.** Every moderation action is in `mod_actions` (actor, action, target, reason and, for bans
    and deletions, `details` with what a clean-up removed), shown to Moderators on the Moderation screen.
    Action codes: `accept`, `reject`, `approve`, `hide`, `unhide`, `restore`, `rollback`, `protect:N`,
    `remove-version`, `restore-version`, `report:dismissed|actioned`, `ban-request`, `ban-request:declined`,
    `ban`, `ban:clean-up`, `unban`, `trust:0|1|2|auto`, `delete-user`, `settings:rules`, `feature`,
    `unfeature` (stories and collections), `development:accept|reject`, `remove-development`,
    `correction:accepted|rejected`, `remove-correction`, `edit-collection` (by a reviewer, not its creator).
    Older entries may include `hide` on a `comment` (the retired chat).

**Publication and decisions.** A story records when it first became public and with which version
(`published_at`, `published_revision_id`). Non-reviewers see only accepted versions from that point on, so
a newcomer's earlier drafts, which no reviewer read, stay visible to their author and reviewers only.
Decisions are not repeatable: approving needs a story still waiting (409 `already-decided` otherwise, so a
stale card can't undo another reviewer's rejection), hiding an already hidden story is refused, and Unhide
puts a never-published story back in the review queue instead of publishing it. Restores carry the version
that was current (409 if it moved, so a double click doesn't make two copies). Accepting a held edit respects
protection like editing and restoring do. Hiding a story closes the reports about it; held edits to hidden
stories and from banned people stay out of the review queues. A person's promotion is also re-checked when
they open their own page. Someone stored as a Moderator but no longer in `ADMIN_EMAILS` is corrected to
Reviewer on their next request or when a Moderator acts on them, and deleting a banned account keeps them out
(`banned_subjects`).

**Contributions.** Everyone has a page (`/u/:id`): name, role and join date are public; the lists of stories
they started and versions they wrote (with status, including private and removed ones) and their reputation
are shown to them and to Reviewers only, to avoid making it easy to profile or rank people. Your own page is
`/me` (role, reputation and how it adds up, progress toward the next level, today's usage against the
limits, contributions).

## 7. Timelines, corrections, collections and discovery

**Event timelines.** Instead of a new story for every development in a war, protest or crisis, an event gets a
chronological feed: `POST /api/stories/:id/developments` with a date, headline, optional details, optional
place and at least one source. Developments go live under the same rule as edits (Members, protection levels; but not the
Newcomer creator of a story still waiting for approval), otherwise they wait in the Watchtower. They are not
edited after posting: a mistake is fixed by a newer development, a correction, or a reviewer removing it
(`hidden_at`, reviewers only). A live development bumps the story's `last_update_at`; a story with one in the
last 30 days (`DEVELOPING_DAYS`), or marked ongoing, counts as **developing** (map layer, home page,
`?ongoing=1`).

**Corrections.** A reader quotes a statement from the version on screen (title, summary or text; whitespace is
normalised, and the API refuses quotes that aren't there), says what is wrong (factually wrong, missing
context, not supported by the sources, out of date), proposes a fix and gives counter-evidence (≥ 1 source).
Corrections are public from the start (reportable, removable by reviewers). A reviewer accepts or rejects
with a **public note**; accepting doesn't edit the story by itself: the fix is a normal edit, which can be
linked as `fixed_revision_id`, so the history shows the disputed version, the fix and the decision. Nobody
decides their own correction, and only moderators decide corrections to stories they started. Readers see
every outcome and whether the quoted text is still in the current version. Accepted corrections count +8 for
the corrector and −2 for the story's creator (§6).

**Collections.** Members and above can start collections (3 a day); the creator and reviewers can change
them, reviewers hide (moderators unhide) and feature them. A collection is hand-picked stories in an
arranged order with notes, and/or rules that gather published stories automatically: an area (place
collections; stored compacted at res 2–5 so it matches `story_cells`, up to `collectionCellsMax` base
cells), categories, a span of years. Rule matches are listed oldest first, so a collection reads as a
narrative; the map highlights its stories and draws its area. A story page lists the collections it belongs
to.

**Discovery.** `GET /api/discover` (CDN-cached) fills the home panel: featured stories (reviewers' picks;
until there are three, the most connected stand in), developing events, newly documented history, recent
events, on this day (the visitor's local date) and collections. Sections the site can't fill yet are left out
rather than shown empty. "Surprise me" (`/api/stories/random?mode=surprise`: featured, ≥ 2 sources or
connected) and "Explore a random event" (`mode=any`) open a random published story. **"History near me"
runs entirely in the browser**: it asks for the device's location and picks the nearest stories from the
map's point list, so the location never reaches Hexstory; only the chosen stories' ids are sent to fetch
their summaries.

**The map's point list.** `GET /api/map/points` returns every published story as `{id, title, lat, lng,
categories, lo, hi, year, developing}` (cached 30 s per instance and 60 s by the CDN). The browser filters it
by time and category, colours it per layer and counts it into hexagons, so the timeline slider and the layer
switcher never make requests. Up to `MAP_POINTS_MAX` (20,000) stories, most recently updated first; see §13.

**The Square was removed (2026-11-01).** The live chat per hexagon needed an already-busy site to be useful
(most regions showed "Just you here right now") and kept WebSockets and Redis Pub/Sub running. Its code
(Socket.IO server and client, presence, pub/sub) is gone; the `comments` table remains as dormant data.

## 8. Security

| Threat | Mitigation |
|---|---|
| CSRF | `SameSite=Lax` session cookie + every non-GET `/api` and `/auth` request must carry `Origin: APP_ORIGIN` (`app.ts`) |
| Session theft | httpOnly cookie, `Secure` in production, only a SHA-256 of the token stored, 30-day sliding expiry |
| OAuth | State + PKCE (arctic); email must be verified; `returnTo` only accepts plain same-site paths (no `//`, backslashes, control chars or spaces) |
| XSS | React escaping; story content is a validated document rendered element by element (`RichContent.tsx`), never as HTML; no `dangerouslySetInnerHTML`; markdown only for bundled legal pages, without raw HTML; story and source links must be `http(s)` and render with `rel="nofollow ugc noopener noreferrer"`; images in stories can only be our own re-encoded uploads |
| Content injection | Strict CSP (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`; allow-listed: tiles origin, the R2 image domain in `img-src`, the R2 S3 endpoint in `connect-src`), `nosniff`, Helmet defaults. `index.html` is always served by Fastify so these headers apply on Vercel too |
| SQL injection | Only parameterised postgres.js queries; identifiers only from fixed maps; `sql.unsafe` only runs migration files |
| Malicious uploads | Originals (max 6 MB) go to a **private staging bucket** through a pre-signed PUT that is valid for 5 minutes and signs the exact byte count and `application/octet-stream`; the key is `<userId>/<uploadId>` and completion rebuilds it from the session, so nobody can claim another user's upload. The API then reads the original (size re-checked), decodes and **re-encodes to WebP** with sharp (strips EXIF/GPS, accepts only JPEG, PNG and WebP, 50 MP cap), publishes full + thumbnail, and deletes the original. If either write fails both are removed and the client gets an error. Staged leftovers expire by an R2 lifecycle rule (1 day). No URL fetching. 20 upload slots/hour/user. R2 credentials never reach the browser |
| Resource abuse | 300 req/min/IP global and the upload limits (shared across instances when Redis is configured; fail open if Redis is down; the daily limits in Postgres always apply), per-user daily limits for stories, edits + developments, corrections, collections, uploads and reports, area size checked before expansion (stories and collections), 256 KB body limit, 60 s Function duration, CDN caching of public data |
| Disputes used for abuse | Corrections must quote real text of the version read; one open dispute per person per statement; daily limits; reportable; reviewers remove abusive ones; nobody decides their own or (non-moderators) one about their own story |
| Spoofed client IPs | Fastify trusts `X-Forwarded-For` only with `TRUST_PROXY=true` (default on Vercel, which overwrites the header with the real client IP) |
| Environment mix-ups | Database environment marker checked at build and start; migrations only by explicit command over a direct connection; Redis keys prefixed per environment (§4) |
| Privacy | Emails and Google IDs never leave the API; Google profile pictures and full names are never stored; account deletion anonymises the user and deletes sessions; "History near me" uses the device's location only in the browser (never sent); reputation is visible only to the person and reviewers |

## 9. UI design decisions

- **Visual language:** warm paper background (`--bg #f6f4f0`), white floating cards with soft shadow,
  one accent colour (terracotta `#c2410c`) for actions and developing events, blue (`#1d4ed8`) only for
  "this story's place/area / your selection". Category and period colours live in `apps/web/src/lib/palette.ts`
  (periods are a sequential purple ramp, so they read as an order; density is a neutral grey ramp, never the
  accent). Serif (`Iowan Old Style`/Georgia) for story titles and bodies, system sans for UI. Tokens are at
  the top of `apps/web/src/styles/global.css`; each area has its own stylesheet (`discover.css`,
  `story.css`, `collections.css`).
- **Home = guided discovery** (`views/Home.tsx`, `/`): the Discover panel beside the map with four quick
  actions (Surprise me, Random event, History near me, On this day) and sections (Featured, Developing now,
  Newly documented history, Recent events, On this day, Places and collections), each left out when empty and
  each linking to the matching Explore view. With fewer than 8 published stories an invitation to write
  replaces anything that would look empty; nothing ever says "nobody here". × / Escape collapses the panel to
  a "Discover stories" pill (remembered for the visit in `sessionStorage`); the map stays interactive.
- **Guided tour** (`components/Tour.tsx`): a "?" button in the top bar (always available) and a one-time
  "New here? Take the tour" invitation at the top of the Discover panel (dismissal remembered in
  `localStorage` as `hexstory:tour-seen`; safe when storage is blocked). Nine short steps on the home page:
  welcome, the quick actions, a story row, the map (dots, clicking a region), place search, the timeline and
  "Categories & layers", Collections, signing in to contribute, done. Each step dims the page except one
  element (the first visible match of its selectors, so phones and desktops can point at different elements;
  steps whose element isn't on screen show a centred card), with Back / Next / Skip, arrow keys and Escape.
  Starting the tour goes to `/` and reopens a collapsed Discover panel. No library.
- **Globe** (`map/WorldMap.tsx`): MapLibre globe; a faint res-2 hex grid covers the world when zoomed out,
  finer grids appear as you zoom. Stories are **dots at their precise places** (the old orange "occupied
  hexagon" tint is gone). Clicking a dot opens the story (5 px tolerance for fingers); clicking anywhere else
  opens that region's hexagon, so manual exploration still works but isn't the main way in. Hovering a dot
  shows its title. While a list, a collection or "near me" is open, its stories are highlighted and the rest
  fade. While reading a story, its point (blue pin), its wider area (if any) and its developments' places
  (white markers with a blue ring) are drawn.
- **Map controls** (`map/MapControls.tsx`, hidden while editing): a timeline with All time / Year / Decade /
  Range, a slider on a non-linear year scale (3000 BCE → 1 BCE → 1500 → 1900 → today, so recent centuries get
  most of the width), exact year boxes (negative = BCE), a label ("The 1960s", "1914–1918") and how many events
  match; "Categories & layers" opens the category filter, the layer choice (Events, Density, Category,
  Historical period, Developing, each with a one-line description; **Category** by default, and the
  browser remembers a change) and the legend. The density legend says it
  shows where people have written so far, not how important a place is. Everything is filtered in the browser
  (`lib/discover.ts`), so dragging costs no requests; the map filters also apply to region lists and Explore.
  On phones a "Filters · …" pill opens all of this as a bottom sheet with "Show N events".
- **Lists** (Explore, a region, collections): rows show title, date, place, Ongoing/Developing and "Newly
  documented" labels, a two-line summary, category chips and the source-count badge (neutral grey for 1,
  darker for 2–3, teal for 4+). Sort and kind selects (`components/SortControls.tsx`) sit above region and
  Explore lists; "Most relevant" is offered only with a search or in a region.
- **Explore** (`/explore`): one view for search (`q`), a person, on this day (`on`), developing events
  (`ongoing=1`), newly documented history and recent events, with a title per mode and notes for the URL and
  map filters in force, each clearable. **History near me** (`/near`) asks for the location on arrival, lists
  the 20 nearest matching stories with distances and says plainly that the location never leaves the browser;
  if refused it offers the place search and Explore.
- **Hex panel:** title "This region" + coordinates, the region's stories (default "Most relevant": stories
  about that place specifically before wide ones) following the map filters, and a sticky "Write a story
  here" button. Its empty state points to near me, Explore and Discover.
- **Story view** (`components/StoryContent.tsx`): context before the long account. Title and labels
  (Featured, Ongoing/Developing, Newly documented history); a When / Where / Kind facts box ("Show on map");
  a notice when statements are disputed; the summary as a lead paragraph; sources; connected events grouped
  by relation; people (each linking to every story mentioning them); collections it belongs to; the event
  timeline (latest first, "Show the whole timeline", "Add a development"); then **The full account**, byline,
  **Corrections** and the disclaimer; then Edit · Versions · Share · Report. Reviewer tools (approve, hide,
  feature, protection) are folded in a `<details>`. Versions render through the same component.
- **Corrections:** select text in a story and choose **Dispute a statement**; the selection becomes the quote.
  Every correction shows the quote, the problem, whether the quote is still in the current text, the proposal,
  the evidence and the outcome (note, who decided, a link to the version that fixed it). Reviewers decide with
  a required public note and can link the current version as the fix (pre-ticked when the story changed after
  the dispute); the buttons are hidden where the server would refuse.
- **Editor** (`views/StoryEditor.tsx`, wide panel; the map switches to *select mode*): Title, **Summary**
  (live counter), When (defaults to **today**; One date / Has an end / Still ongoing; approximate), **Where**
  (search a place or click the map to drop the pin, an editable place name, coordinates, and an optional
  "Also mark the wider area it covers" that switches clicks between moving the pin and picking hexagons),
  **Categories** (1–3), **The full account**, Sources (title + optional link, at least one), **Connections**
  ("This event led to / was preceded or caused by / is part of / includes / is related to…" + a story search),
  **People** (type a name, Enter), and "What did you change?" for edits. The licence notice sits above the
  Publish button; leaving with unsaved changes asks first. **Development editor** (`/s/:id/develop`): date,
  headline, details, optional place (pin only), sources.
- **Collections** (`/collections`, `/c/:id`, editor at `/collections/new`, `/c/:id/edit`): Places / Themes /
  All tabs, featured first, then by latest change; story counts are plain counts, not a ranking. A collection
  page states its rules in words and reads "As arranged" (hand-picked stories with the curator's notes, then
  the rest by date) or "By date" (oldest first, under decade headings, or century headings when the stories
  span more than 300 years). The editor picks a place's area on the map (up to `LIMITS.collectionCellsMax`,
  about 15M km²; removing hexagons always works), optional categories and years, and hand-picked stories
  with notes and up/down ordering.
- **The story editor** (`components/RichEditor.tsx`) is a document-style surface (serif, top to bottom, like a
  word processor) with one toolbar: **B**, *I*, Heading, Quote, bulleted and numbered lists, **Link** and
  **Photo**. Link opens an inline address field (with no selection, the address itself is inserted as the
  link). Photo uploads and inserts the image where the cursor is; a selected photo shows a caption/credit
  field and "Remove photo". The first photo becomes the story's thumbnail in lists.
- **BCE dates** are fully supported by the data model, but the era picker is hidden for new stories and only
  appears when editing a story whose date is already BCE. Revisit after user testing.
- **Sign-in:** never a wall. Write, edit and dispute actions show an inline "Sign in with Google" prompt and return
  you to the same page afterwards. The first sign-in shows a one-time **Welcome** dialog: choose a public name
  (pre-filled with the Google first name only; the field can be cleared and retyped freely) and accept the Terms, Privacy Policy and CC BY-SA licence.
- **Your account** (`/me`, the avatar button): your role in plain words, **your reputation** with a points
  table of how it adds up (private: only you and reviewers see it; no public rankings), progress bars toward
  the next level showing only the requirements above zero, today's usage against the daily limits, your stories and edits with their status (Live, Waiting for review,
  Not accepted, Removed, Story waiting for approval), name, sign out, delete. **User pages** (`/u/:id`): name,
  role, join date and Report for everyone; contributions and moderation tools for Reviewers/Moderators.
- **Moderation** (`/moderation`, Moderators): Ban requests, Users (search, level and status filters), Audit
  log, Settings (editable rules) and Resource usage tabs; the tab row scrolls sideways on phones. Bans and deletions open a dialog with an explicit "keep posts" / "remove posts" choice that spells
  out what removal does. On phones, Moderators' brand pill shrinks to the logo so the staff buttons fit.
- **Support** (`/support`, footer link): a modal page asking for voluntary contributions, with "Support with
  card" (Stripe Payment Link) and "Support with PayPal" buttons, each an ordinary link to the provider's page
  and hidden when its URL isn't configured or fails validation (exact host allowlist, `packages/shared/src/support.ts`).
  Contributions buy nothing; no payment data, SDKs or webhooks touch Hexstory.
- **Resource usage** (Moderators): per-provider cards separating "Now" (capacity) from "This period"
  (cumulative), each metric with scope, source, whether it is our own measurement or provider data, freshness,
  and a percentage only when a comparable allowance is known (warnings at 75 % / 90 %). Readings are cached
  in Redis for 15 min, refresh is limited to once a minute site-wide, providers are fetched independently with
  4 s timeouts, and the last good reading is kept and marked stale. Details: DEPLOYMENT.md "Resource usage
  dashboard" (`apps/api/src/usage/`).
- **Place search** (`components/PlaceSearch.tsx`): a combobox in the top bar. Suggestions after 2 characters
  (250 ms debounce); arrow keys move, Enter opens the highlighted (by default the top) result, Escape closes
  then clears. Choosing a place opens `/h/<cell>` and always flies the map there, with "Around <place>" in
  the panel subtitle. Exactly one hexagon per place: towns, cities and anything smaller → the finest display
  hexagon (res 5); counties → res 4; states → res 3; countries → res 2; other features (lakes, parks) by the
  size of their extent (`services/places.ts`). Lookups go through `GET /api/places` to a Photon geocoder
  (`GEOCODER_URL`, default komoot's public instance, OpenStreetMap data): browsers never contact it, results
  are cached in Redis for a day, and each address gets 60 searches a minute.
- **Watchtower** (`/watchtower`): tabs Pending edits · New stories · Timelines (held developments) ·
  Corrections (open disputes, decided with a note) · Reports (with links to the story, collection or person).
- **Required legal text in the UI:** the Welcome checkbox, the disclaimer under every story, the licence
  notice in the editor, and About · Terms · Privacy links bottom-left (with Collections and Support).
- **About page** (`content/about.md`): `{{…}}` tokens are filled from the live rules (`/api/rules`) and
  `REPUTATION` (`{{reputation.x}}`, and `{{reputation.less.x}}` for a negative weight without its sign), so the
  numbers shown are the ones enforced.

### Routes

| Path | View |
|---|---|
| `/` | Discover panel beside the map (collapsible; place search top-left, on phones a bar under the top row) |
| `/explore` (`?q&person&on=MM-DD&ongoing=1&categories&sort&kind`) | Story lists: search, a person, on this day, developing, newly documented, recent |
| `/near` | History near me (computed in the browser) |
| `/h/:cell` | Region panel: its stories, sortable, following the map filters |
| `/s/:id` | Story |
| `/s/:id/edit`, `/new?cell=` | Editor (lazy-loaded) |
| `/s/:id/develop` | Add a development to the story's timeline |
| `/collections`, `/c/:id` | Collections list (Places / Themes / All), one collection |
| `/collections/new`, `/c/:id/edit` | Collection editor (lazy-loaded) |
| `/s/:id/versions`, `/v/:revisionId` | Versions list, single version with word diff and review actions |
| `/watchtower` | Review queue (Reviewers): pending edits, new stories, timelines, corrections, reports |
| `/moderation` (`?tab=requests|users|log|settings|usage`) | Moderators: ban requests, users, audit log, editable rules, resource usage |
| `/me` (`?tab=overview|stories|edits`) | Your account: role, reputation, progress, limits, contributions, name, delete |
| `/u/:id` | Someone's page; contributions and moderation tools for Reviewers/Moderators |
| `/about`, `/terms`, `/privacy` | Modal pages (markdown) |
| `/support` | Modal page: voluntary contributions via Stripe Payment Link / PayPal.Me (options from `GET /api/support`) |

## 10. API reference

All JSON. Errors are `{ error: code, message }`, and `message` is always safe to show.

| Method & path | Who | Purpose |
|---|---|---|
| `GET /api/session` | anyone | `{ user, signInEnabled }` |
| `GET /api/support` | anyone | `{ stripe: string \| null, paypal: string \| null }` validated Support page links (`Cache-Control: max-age=300`) |
| `PATCH /api/me` | signed in | `{ displayName?, acceptTerms? }` |
| `DELETE /api/me` | signed in | Delete account (anonymise) |
| `GET /auth/google?returnTo=`, `GET /auth/google/callback`, `POST /auth/logout` | | Sign-in flow |
| `GET /api/map/points` | anyone | Every published story as a `MapPoint` (CDN-cached 60 s) |
| `GET /api/discover?m=&d=` | anyone | Home panel sections (`DiscoverData`; `m`/`d` = visitor's month/day; CDN-cached 60 s) |
| `GET /api/stories?sort=&kind=&categories=&from=&to=&q=&person=&ongoing=1&on=MM-DD&offset=` | anyone | Any story list (`storyListQuerySchema`), 30 per page |
| `GET /api/cells/:cell/stories?…` | anyone | Stories in a region, same filters and orderings (plus the viewer's own/reviewers' unpublished ones) |
| `GET /api/stories/summaries?ids=` | anyone | Up to 50 published stories by id, in order (e.g. the nearest map points) |
| `GET /api/stories/random?mode=surprise\|any` | anyone | `{ id }` of a random published story (`null` if none) |
| `GET /api/stories/:id` | anyone | Story + current revision + point, connections (both directions), latest developments, open corrections count, collections, `can` permissions |
| `POST /api/stories` | writer | Create → `{ storyId, revisionId, status: live|pending, storyStatus }` |
| `PUT /api/stories/:id` | writer | Edit (needs `baseRevisionId`) |
| `GET /api/stories/:id/revisions`, `GET /api/revisions/:id` | anyone* | History (*unaccepted only for reviewers/author, removed only for reviewers) |
| `POST /api/revisions/:id/removed` | reviewer | `{ removed, reason? }` remove from history (put back: moderator) |
| `POST /api/revisions/:id/review` | reviewer | `{ decision: accept|reject }` |
| `POST /api/stories/:id/restore` | reviewer | `{ revisionId }` |
| `POST /api/stories/:id/status` | reviewer | `{ status: active|hidden, revisionId?, reason? }` approve/hide (unhide: moderator) |
| `POST /api/stories/:id/protection` | moderator | `{ level: 0..3 }` |
| `POST /api/stories/:id/featured` | reviewer | `{ featured, reason? }` |
| `GET /api/stories/:id/developments?offset=` | anyone* | The event's timeline, newest first (*held ones for author/reviewers, removed ones for reviewers) |
| `POST /api/stories/:id/developments` | writer | `{ date, title, body?, location?, sources }` → `{ id, status: live\|pending }` |
| `POST /api/developments/:id/review` | reviewer | `{ decision: accept\|reject, reason? }` |
| `POST /api/developments/:id/remove` | reviewer | `{ reason? }` |
| `GET /api/stories/:id/corrections` | anyone | All corrections with outcomes (removed ones for reviewers) |
| `POST /api/stories/:id/corrections` | writer | `{ revisionId, quote, problem, proposal, evidence }` (400 `quote-not-found`) |
| `POST /api/corrections/:id/resolve` | reviewer | `{ decision: accepted\|rejected, note, fixedRevisionId? }` |
| `POST /api/corrections/:id/remove` | reviewer | `{ reason? }` |
| `GET /api/collections?kind=&offset=` | anyone | Active collections, featured first |
| `GET /api/collections/:id` | anyone* | `CollectionDetail` (*hidden: reviewers) |
| `POST /api/collections`, `PUT /api/collections/:id` | member / creator or reviewer | `collectionSchema` |
| `POST /api/collections/:id/status` | reviewer (unhide: moderator) | `{ status: active\|hidden, reason? }` |
| `POST /api/collections/:id/featured` | reviewer | `{ featured }` |
| `POST /api/uploads` | writer | `{ size }` → `{ id, upload: { url, method: 'PUT', headers } }` (20/hour, plus the daily quota) |
| `PUT <upload.url>` | browser | The original's bytes. Pre-signed R2 URL in production; locally `PUT /api/uploads/:id/original` |
| `POST /api/uploads/:id/complete` | writer (same user) | Validate, re-encode, publish → `{ imageKey, imageUrl, thumbUrl }` |
| `POST /api/reports` | writer | `{ targetType: story\|revision\|user\|development\|correction\|collection, targetId, reason, details? }` |
| `GET /api/watchtower` | reviewer | `{ pending, unreviewed, reports, developments, corrections }` |
| `POST /api/reports/:id/resolve` | reviewer | `{ resolution: dismissed|actioned }` |
| `GET /api/users/:id` | anyone* | Profile (*`details` for self/reviewers, `moderation` for reviewers) |
| `GET /api/users/:id/stories`, `/revisions` (`?offset=`) | self, reviewer | Contributions |
| `POST /api/users/:id/ban-requests` | reviewer | `{ reason }` ask Moderators to ban |
| `POST /api/users/:id/ban-requests/decline` | moderator | `{ reason? }` |
| `POST /api/users/:id/ban` | moderator | `{ banned, reason?, removeContent? }` → `{ cleanup }` |
| `POST /api/users/:id/delete` | moderator | `{ removeContent, reason? }` → `{ cleanup }` |
| `POST /api/users/:id/trust` | moderator | `{ level: 0|1|2|'auto', reason? }` |
| `GET /api/moderation/users` | moderator | `?q=&level=&filter=all|banned|requested|reported&offset=` |
| `GET /api/moderation/ban-requests` | moderator | Users with open ban requests |
| `GET /api/moderation/log` | moderator | Audit log `?action=&actorId=&targetType=&targetId=&offset=` |
| `GET /api/moderation/usage` | moderator | Hosting usage per provider (`UsageReport`, `packages/shared/src/usage.ts`); readings cached ~15 min across instances |
| `POST /api/moderation/usage/refresh` | moderator | Re-read every provider now; once a minute site-wide (429 + `Retry-After` otherwise) |
| `GET /api/rules` | anyone | The rules in force (defaults + Moderator overrides) |
| `GET /api/places?q=&lang=` | anyone | Place search → `[{ name, detail, kind, lat, lng, cell }]` (60/min/IP, cached a day) |
| `GET`, `PUT /api/moderation/settings` | moderator | `{ rules: EditableRules, reason? }` |

"Writer" = signed in, terms accepted, not banned.

## 11. Extension points

Designed so features can be added without touching unrelated code:

- **New API feature:** add `services/<thing>.ts` (logic + SQL) and `routes/<thing>.ts` (a Fastify plugin
  taking `Deps`), register it in `app.ts`. Put shared input schemas/types in `packages/shared`.
- **New view:** add `views/<View>.tsx` rendering a `<Panel>`, add a route in `main.tsx` (use `lazy` if it's
  not on the main path), and add query hooks/keys in `api/queries.ts`.
- **More formatting in stories:** add the TipTap extension in `RichEditor.tsx`, a block/mark to `richDocSchema`
  and both converters, and a case in `RichContent.tsx`. All four must agree, or the server rejects the content.
- **Ads / sponsorship:** `<AdSlot placement="story-list-end" | "story-end" />` is already placed and renders
  nothing unless `VITE_FEATURE_ADS=true`. Before turning it on: add the ad network's origins to the CSP in
  `app.ts`, update the Privacy Policy (third-party trackers), add a consent banner for EU/UK visitors, and
  keep placements to those two slots (no ads on the map itself, to keep it calm).
- **Another image store:** implement the `Storage` interface (`storage/index.ts`) like `storage/r2.ts`;
  set `imageOrigin`/`uploadOrigin` and the CSP follows automatically.
- **Source verification (planned):** add a `source_checks` table keyed by URL, a background job, and a
  per-source status in `StoryContent`. The neutral source badge can then reflect verified counts.
- **New map layer:** add an id to `MAP_LAYERS` (`map/MapContext.tsx`), a paint style in `WorldMap.tsx` and a
  legend in `MapControls.tsx`. Anything derivable from `MapPoint` costs no server work; add fields to
  `MapPoint` (and `mapPoints()`) sparingly, since every visitor downloads the list.
- **New category or relation:** add it to `CATEGORIES`/`LINK_RELATIONS` (`packages/shared/src/history.ts`),
  its label and colour (`lib/palette.ts`), and for relations its inverse. Story links' CHECK constraint lists
  the relations, so a new relation also needs a migration.
- **Large map datasets:** when `/api/map/points` grows too big, add a bbox/zoom query (or vector tiles) and
  move density counts server-side, keeping the response CDN-cacheable per tile.
- **Dark mode:** add dark tokens in `global.css` and a dark basemap style URL.
- **Realtime features (none today):** the Square's Socket.IO + Redis Pub/Sub design is in git history
  (before 2026-11-01). Bring it back only when there is enough concurrent activity to make it worthwhile.

## 12. Procedures

- **Bulk import of events:** see [docs/IMPORT.md](IMPORT.md) (Part 1 is the brief for gathering events,
  Part 2 for importing). In short: `npm run import:check -- data/import/*.jsonl --check-urls`, then
  `npm run import -- dry-run|apply … --env development [--batch name]`; for preview/production
  `doppler run -c prd -- npm run import:remote -- apply … --env production`; undo with
  `remove-batch <name>`. How it works:
  - **Format:** JSON Lines, one event per line with a stable `key`, the story fields, sources (each with a
    link), connections by key, an optional freely licensed photo (Wikimedia Commons; licence, author and file
    page required) and a timeline of developments. Validated by `apps/api/src/import/format.ts` with the
    site's own schemas plus import rules; `check` needs no database.
  - **Checks:** every source and photo link is fetched (404/410/unknown domain = error, so invented URLs
    are caught; blocked or slow sites = warning); `--check-places` looks up every place (the event's and its
    developments') with OpenStreetMap's Nominatim, one request a second as its usage policy requires
    (`IMPORT_GEOCODER_URL` to use another Nominatim instance), and warns when the coordinates lie more
    than 10 km outside the area it knows for that place (its bounding box, so a province or a lake gets
    more room than a town) or the place isn't found; lookups that fail are reported as a warning, never
    passed silently. The site's own place search still uses Photon (`GEOCODER_URL`). Results are cached
    for 30 days in `.import-cache.json` next to the files (git-ignored).
  - **Writing** (`import/run.ts`): as the **Hexstory Archive** account (`google_sub`
    `system:hexstory-archive`: can't sign in; Reviewer level, locked; exempt from daily limits through an
    internal option no HTTP route passes), through `createStory`/`editStory`/`addDevelopment`, so indexes,
    links and timelines are built as for any story. Photos are re-encoded exactly like uploads
    (`services/images.ts`) and stored under a key derived from their bytes, then shown first in the story
    with "Photo: author, licence" and their file page added as a source. Connections between stories created
    in the same run are filled into those just-created versions once all exist (`fillImportedLinks`), so no
    extra versions are made. Re-running is idempotent (by `import_key`); a changed line becomes a new version;
    stories someone edited on the site since are left alone unless `--update-edited`; developments are
    added once (by a hash of date and title).
  - **On the site:** imported stories are published at once (bulk review isn't realistic) and labelled
    "Imported from public sources" while the Archive's version is current (an edit by anyone else drops the label); `remove-batch` hides a whole batch (audit log: `hide` by Hexstory
    Archive), and moderators can unhide single stories.

- **Schema change:** add `apps/api/migrations/NNN_description.sql` (next number). Apply it with
  `npm run migrate` (local), then `npm run migrate:preview` / `migrate:production` **before** deploying code
  that needs it (DEPLOYMENT.md §6). Keep migrations backward compatible (add, then remove in a later
  release), because the previous deployment keeps serving until the new one is promoted. Never edit an
  applied migration.
- **Change a policy number:** edit `apps/api/src/policy.ts`, update §6 here, run the tests.
- **Make someone a Moderator:** add their email to `ADMIN_EMAILS` (Doppler locally, Vercel in production); it
  applies at their next sign-in. Removing it takes effect on their next request.
- **Promote or demote someone (up to Reviewer):** Moderation → Users → their page → Level. Choose
  "Automatic" to hand them back to the promotion rules.
- **Ban someone:** their page (`/u/:id`) → Ban…, choosing keep or remove posts. Reviewers use "Request a
  ban" there instead; requests wait under Moderation → Ban requests.
- **Production deploy:** Vercel, see [DEPLOYMENT.md](DEPLOYMENT.md).
- **Alternative: single server:**
  1. Doppler config `prd` with `NODE_ENV=production`, `APP_ORIGIN=https://<domain>`, `TRUST_PROXY=true`,
     `UPLOAD_DIR=/var/lib/hexstory/uploads`, real Google credentials (add the production redirect URI).
  2. `npm ci && npm run build` (builds the SPA into `apps/web/dist`).
  3. `doppler run --config prd -- npm run start:local` under systemd (or `npm start` from the root, which runs
     it through Doppler); it migrates, then starts.
  4. Put Caddy or nginx in front for TLS, proxying everything to :3000.
- **Backups:** on Neon, point-in-time restore within the plan's history window plus a periodic `pg_dump -Fc`
  of `DATABASE_URL_UNPOOLED` kept elsewhere; R2 objects are durable but not versioned (DEPLOYMENT.md §2). On a
  single server: nightly `pg_dump -Fc` and a copy of `UPLOAD_DIR`, both off the server. Test a restore.
- **Before launch:** the Terms are governed by New Jersey law (courts in Hudson County or the District of
  New Jersey; operated from Jersey City). Remaining: decide whether to
  delete the retired chat's dormant messages, which the Privacy Policy now describes as kept only as moderation
  records; the date and the contact address hexstory.world@gmail.com are
  filled in, and the "Last updated" dates must change whenever the text does); have a lawyer review; the DMCA designated agent is registered (DMCA-1084967, 2 November
  2026); Terms section 10 gives its name and email and points to the Copyright Office directory for the
  rest. The postal address and phone are deliberately left off the site (they are the operator's home);
  § 512(c)(2) expects them on the site, so add them once there is a non-home mailing address (and amend
  the registration to match); **renew it every 3 years** at dmca.copyright.gov (by November 2029)
  or the safe harbour lapses, and update the Terms and the registration together if the address changes; publish the
  Privacy/Terms URLs on the Google OAuth consent screen.

## 13. Known limitations / follow-ups

- Processed images are public as soon as an upload completes and never garbage-collected if unused
  (rate-limited to 20/hour/user). Follow-up: track uploads, serve only once referenced, sweep orphans.
  (Unprocessed originals are private and expire after a day.)
- Locally, abandoned staged originals stay in `<UPLOAD_DIR>-staging` until deleted by hand.
- Reviewers are auto-promoted by activity; Moderators can demote them and pin the level (`trust_locked`).
- Removing someone's posts can't remove what others built on top of their edits, and images they uploaded
  stay reachable by URL (see the image follow-up above). Unbanning doesn't undo a clean-up; Moderators
  bring back individual stories with Unhide.
- There's no notification system: reviewers aren't told when a ban request is decided (it shows on the
  person's page), and users aren't told when their story is approved.
- The map downloads every published story's point (`MAP_POINTS_MAX` = 20,000, least recently updated drop
  off beyond that); fine for thousands of stories, but switch to viewport queries or tiles before then.
- Significance is a simple, explainable formula over links, developments, sources and featuring; it can be
  gamed a little by linking many stories to one. Reviewers can unfeature; links are versioned and reviewable.
- Corrections are decided by reviewers; there is no voting or discussion thread yet (on purpose while the
  community is small).
- Developments can't be edited, only removed and re-added.
- Without `REDIS_URL`, rate limits and the usage dashboard's caches are per Function instance.
- Expired sessions are not deleted (they are ignored); a periodic cleanup could be added as a Vercel cron.
- Grid lines are only drawn when ≤ 8,000 cells would be visible; at very wide res-3+ views only occupied
  hexes are drawn.
- Search is `ILIKE` over titles, summaries, places and people: fine for thousands of stories; Postgres
  `tsvector` (or `pg_trgm`) is the intended next step.
- Map tiles depend on the public OpenFreeMap service; self-host or switch provider via `VITE_MAP_STYLE_URL`.

## Changelog

- **2026-11-02**: Fixes from a security and UI review. Security: collection years capped at 10,000 and the
  rule SQL made overflow-safe (a huge year made every story page fail); a Newcomer's developments on their own
  unreviewed story are held for review; removing a correction follows the deciding rules (not your own, not on
  your own story unless a Moderator, decided ones by Moderators only) and removed corrections cost reputation;
  names containing "hexstory", "Deleted user" and staff titles are reserved (lookalikes included); the
  Imported label shows only while the imported version is current; uploads accept only JPEG/PNG/WebP; sign-in
  requires Google's `email_verified: true`. UI: tablets (721–1100 px) put the panel below the top row so
  the account buttons aren't covered by the place search; held-edit reviews show summary, category, place,
  people and connection changes; the Watchtower shows loading and errors instead of "All clear", and hides
  correction decisions on stories the reviewer started; category dots use a shown category when filtered and
  uncategorised stories get their own colour and legend entry; the tour reopens a collapsed home panel; the
  Welcome screen offers "sign out"; the audit log names the newer actions and links their targets; editors
  show load errors; year boxes accept a minus sign on iOS.
- **2026-11-02**: Terms of Service and Privacy Policy updated: governed by New Jersey law (operated from
  Jersey City); imported stories (Hexstory Archive, third-party photo licences); voluntary contributions;
  DMCA designated agent (DMCA-1084967) and counter-notices; hosting providers and US data location; people named in stories. The map's
  default layer is now Category (was Events).
- **2026-11-02**: Import place check (`import/checks.ts`) now uses OpenStreetMap's Nominatim (1 request a
  second) instead of Photon, also checks developments' locations, compares against the place's bounding box
  (10 km margin) rather than a flat 100 km, and reports failed lookups instead of passing silently (Photon
  was unreachable from a development machine and the check had reported no problems having checked nothing).
- **2026-11-02**: Bulk import of events (`docs/IMPORT.md`, `npm run import:check | import | import:remote`):
  JSON Lines files with sources, places, connections, timelines and freely licensed photos; validation with
  the site's schemas, live link and place checks, idempotent re-runs, batch removal; stories written by the
  Hexstory Archive account and labelled "Imported from public sources". Image re-encoding moved to
  `services/images.ts` (shared by uploads and imports). Fixed: the "Nothing changed" check compared JSON
  read back from `jsonb` (which reorders keys) with the submitted JSON, so a re-save of identical content
  counted as a change. Migration `008_imports.sql`.

- **2026-11-01**: Guided tour: a "?" button in the top bar and a one-time invitation on the home panel walk
  new visitors through the main features in nine steps (§9).

- **2026-11-01**: Connected history and guided discovery. **Removed the Square** (live chat, presence,
  Socket.IO, Redis Pub/Sub; the `comments` table stays dormant); Redis is now optional and each instance holds
  one connection; `maxDuration` 300 → 60 s. **Stories** gain a precise point and place name (the hex area is
  optional), a required summary, 1–3 categories, people and connections to other stories (preceded by / led
  to / part of / includes / related, shown on both stories), and read context-first (date, place, summary,
  sources, connections before the full account). New **event timelines** (developments with their own date,
  place and sources), **corrections** (dispute a quoted statement with counter-evidence; public outcomes;
  history kept), **collections** (place and theme; hand-picked and rule-based), **featured** stories. **Lists**
  sort by occurrence, publication, latest updates, significance or relevance, and separate events reported as
  they happened from newly documented history. **Discovery:** home panel on `/` (featured, developing, newly
  documented, recent, on this day, collections), Surprise me, random event, History near me (location stays in
  the browser), On this day. **Map:** dots at precise places, a timeline slider (year, decade, range),
  category filters and layers (events, density, category, period, developing) computed in the browser from
  one CDN-cached point list; the orange "occupied hexagon" tint and the "tap a hexagon" hint are gone.
  **Reputation** replaces story-count promotion: quality-based points (published, sourced, improved others'
  stories once per story, accepted corrections, steady weeks; minus rejected, removed, corrected), private to
  the person and reviewers; Moderators' editable rules changed accordingly (old overrides ignored). New daily
  limits for corrections and collections; developments count as edits. `GET /api/cells` and the chat routes
  are gone. Migration `007_connected_history.sql`. Terms, Privacy Policy and About page updated.

- **2026-11-01**: Place search on the map: type a place, pick a suggestion (or press Enter for the top one),
  and the map flies to its hexagon (finest for towns/cities, one larger hexagon for regions/countries).
  `GET /api/places` proxies a Photon geocoder (`GEOCODER_URL`), cached and rate-limited. Privacy Policy and
  About page mention it.
- **2026-11-01**: Security and flow review fixes. Security: a malformed session cookie on a Socket.IO
  connection could crash the process (now parsed safely, setup errors contained); Socket.IO connection limits
  per address; chat sends gated before database work; newcomer drafts no longer become public when the story
  is approved; upload slots complete once (no replacing a published image); moderators taken off
  ADMIN_EMAILS can be acted on; deleted banned accounts stay out; reviewers can't accept edits on stories
  protected above their level; the API/CSRF check uses the routed path; patched `glob`/`minimatch` via an npm
  override. Flows: editor keeps the version it opened (no silent overwrite) and asks before discarding a
  draft; repeat/stale approve, hide and restore refused; Unhide returns never-approved stories to review;
  version pages refresh after review; restore hidden where it would fail; reviewers aren't offered their own
  items; rejected new stories read "Not accepted"; new stories don't use up the edit allowance and restore
  copies aren't counted as edits; promotion re-checked on your own page; inline confirmations with reasons
  for hide, reject and remove; title/other-change hints in the Watchtower; load errors distinguished from
  "not found"; richer audit details. Migration `006_publication.sql`. Terms and Privacy Policy dated
  1 November 2026 with the contact address hexstory.world@gmail.com.
- **2026-11-01**: Support page (`/support`, `GET /api/support`; `STRIPE_SUPPORT_URL`, `PAYPAL_SUPPORT_URL`
  validated against exact provider hosts, invalid values hidden with a startup warning) and a moderator-only
  Resource usage dashboard (`/api/moderation/usage`, `/refresh`): Neon database size and Redis INFO from our
  own connections; Neon project usage and R2 storage/operations via optional read credentials; Vercel
  dashboard-only. Optional `USAGE_*` settings for allowances and thresholds; the coordinator gained `info()`
  and a shared JSON cache. Privacy Policy mentions Stripe/PayPal.
- **2026-11-01**: Moderators can change the promotion thresholds (Newcomer period, Member/Reviewer day and
  story requirements) and the new-account chat wait at runtime (Moderation → Settings; `site_settings`,
  `GET /api/rules`, audit `settings:rules`); the About page shows the live values. Cost guards: 64 KB cap on
  a version's stored content, 256 KB JSON body limit (was 512 KB), daily photo-upload quotas by count and
  size per trust level (`uploads` table). Migration `005_settings_uploads.sql`.
- **2026-11-01**: Moderation and accounts. Newcomer stories are private until a Reviewer approves them
  (approval checks the version read; accepting a held first version publishes); only published stories count
  toward promotion. Member daily limits lowered to 10 stories / 20 edits. Contribution rules moved to shared
  `RULES` and shown on a rewritten About page. New: Moderation screen (ban requests, users, audit log); ban
  with "keep posts" or "remove posts" (hide/roll back/remove versions/hide messages/close reports); moderator
  account deletion; manual levels with `trust_locked`; Reviewer ban requests; removing single versions from
  the history; reports about people and versions; user pages (`/u/:id`) and an account page (`/me`) with
  progress, limits and contributions (replaces the account dialog). Moderator access now follows
  `ADMIN_EMAILS` on every request. Migration `004_moderation.sql`.
- **2026-11-01**: Vercel deployment (Neon, Cloudflare R2, Redis Cloud). One Function serves API, auth,
  Socket.IO (WebSocket only) and page HTML; the CDN serves built assets. Migrations moved out of startup into
  an explicit, locked `migrate` command with an environment marker (migration `003_app_meta.sql`), checked at
  build and start. Images: direct-to-R2 uploads of originals into a private staging bucket via pre-signed PUT,
  then server-side validation and re-encoding (`POST /api/uploads` → PUT → `/complete`; the multipart upload
  endpoint is gone). Chat fan-out, presence (expiring), chat cooldown and API rate limits shared through
  Redis; join acks, `resync` and history reconciliation on reconnect; `delayed` send acks. Fixed: shutdown
  waited forever on open WebSockets (Socket.IO now closes in `preClose`). New: `docs/DEPLOYMENT.md`.
- **2026-10-31**: Rich story content: document-style editor (TipTap) with links, inline photos with captions,
  headings, quotes and lists; stored as our own validated format (migration `002_rich_content.sql`); the
  separate cover-image field is replaced by "first photo = thumbnail". Dates default to today and the BCE picker
  is hidden for new stories. Fixed: the Welcome name field refilled itself when emptied; the account dialog
  showed a stale name until refresh.
- **2026-10-31**: Initial implementation: map + H3 grid, stories with multi-hex areas, historical dates,
  required sources, append-only versions, trust levels, Watchtower, reports, The Square, Google sign-in,
  image uploads, legal pages, ad slot placeholders. Security review fixes: area-size check before
  expansion, trust promotion by distinct stories, restore limited to accepted versions + protection,
  stricter `returnTo`, unaccepted versions hidden from the public, transactional daily limits,
  Socket.IO flood control, moderator-only unhide.

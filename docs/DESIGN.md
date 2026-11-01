# Hexstory: design & operations

> **Every place has a story.** A world map divided into hexagons where anyone can read, write and discuss
> what happened in a place.

This file is the single source of truth for how Hexstory works: what it is built with, why it is built that
way, and how to run and change it. **Every change to behaviour, schema, tooling, policy or procedures must
update this file in the same change**, including a line in the [Changelog](#changelog).

---

## 1. Product overview

| Name | What it is |
|---|---|
| **Hexstory** | The site. Tagline: "Every place has a story." |
| **The Map** | Full-screen globe, always visible. Divided into H3 hexagons; hexes with stories are tinted orange. |
| **Stories** | Short user-written accounts of events (protests, wars, discoveries…), each tied to one or more hexes. |
| **The Square** | Live public chat for each hex, among everyone viewing it. |
| **Versions** | The append-only edit history of a story. Nothing is ever overwritten. |
| **Watchtower** | The review queue for Reviewers: pending edits, new stories, reports. |

Principles:

- **Map first, no sign-up wall.** Visitors land on the globe and can read everything. Signing in (Google)
  is only needed to write, edit, chat or report.
- **Calm UI.** One floating panel at a time, a quiet palette, no counters or badges shouting for attention.
- **Opinions welcome, sources required.** Every story needs at least one source. Sources are *not*
  verified yet; the source count is shown on every story so readers can judge at a glance.
- **Trolls can add noise but can't destroy anything.** Append-only revisions, trust levels, held edits, reports.

## 2. Repository layout

```
├── api/index.js             Vercel Function entry: re-exports the bundled API server
├── apps/
│   ├── api/                 Fastify server (REST + Socket.IO), serves index.html for page navigations
│   │   ├── migrations/      Numbered SQL migrations (never edit an applied one)
│   │   ├── src/
│   │   │   ├── index.ts     Long-running server (local dev, single machine): config → checks → listen
│   │   │   ├── serverless.ts  Vercel entry: builds the app once per instance, exports its Node server
│   │   │   ├── runtime.ts   Wires the app to Postgres, Redis/memory coordination and storage; DB guard
│   │   │   ├── app.ts       Fastify assembly: security headers, CSRF check, session, rate limits, routes
│   │   │   ├── config.ts    Env var schema (fails fast on bad config; Vercel-specific defaults)
│   │   │   ├── migrate.ts   The migrate command, its lock, the environment marker and the startup check
│   │   │   ├── coordination.ts  Cross-instance state: Redis (Pub/Sub, presence, cooldowns) or in-memory
│   │   │   ├── policy.ts    ALL anti-abuse numbers & rules (rate limits, promotion, auto-flags)
│   │   │   ├── auth/        Google OAuth flow, sessions
│   │   │   ├── routes/      Thin HTTP layer: parse input → call a service
│   │   │   ├── services/    Business logic + SQL (stories, users, reports, square, modlog)
│   │   │   ├── realtime/    The Square (Socket.IO)
│   │   │   ├── storage/     Image storage interface: local disk (dev) and Cloudflare R2 (`r2.ts`)
│   │   │   └── seed.ts      Dev-only sample stories
│   │   └── test/            Integration tests (real Postgres) and `*.unit.test.ts` (no services)
│   └── web/                 React SPA (Vite)
│       └── src/
│           ├── main.tsx     Routes
│           ├── api/         fetch client + React Query hooks (all query keys in one place)
│           ├── map/         MapLibre globe, hex geometry, map↔panel shared state
│           ├── views/       One file per panel/page
│           ├── components/  Small shared UI pieces
│           ├── realtime/    Socket.IO client hook for the Square
│           ├── content/     About page markdown
│           ├── features.ts  Feature flags (ads etc.)
│           └── styles/      global.css (design tokens at the top)
├── packages/shared/         Types, Zod schemas, hex & date helpers used by BOTH api and web
├── legal/                   Terms of Service, Privacy Policy (rendered in-app at /terms, /privacy)
├── docs/DESIGN.md           This file
├── docs/DEPLOYMENT.md       Vercel + Neon + R2 + Redis Cloud + Google setup, step by step
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
| Backend | Fastify 5, Socket.IO 4 | Fast, plugin-based, good security plugins |
| Database | PostgreSQL (14+) via `postgres` (postgres.js 4), plain SQL | Transparent queries, no ORM magic |
| Validation | Zod 4 | Shared schemas |
| Auth | Google OAuth via `arctic` (PKCE + state), own session table | Small, auditable |
| Story editor | TipTap 3 (ProseMirror) | Reliable document-style editing; its output is converted to our own format |
| Images | `sharp` (re-encode to WebP, strip metadata) | Removes GPS/EXIF from protest photos |
| Secrets | Doppler (`doppler run --`) locally; Vercel environment variables in deployments | No secrets in files |
| Hosting | Vercel: CDN for built assets, one Node Function (Fluid compute) for everything else, WebSockets included | Same origin for app, API, auth and chat |
| Production database | Neon PostgreSQL (Vercel Marketplace), pooled URL for the app, direct URL for migrations | Serverless-friendly Postgres; plain SQL unchanged |
| Image storage | Cloudflare R2 via its S3 API, signed with `aws4fetch` | Cheap egress, custom-domain CDN; tiny fetch-based client |
| Shared state | Redis Cloud (Vercel Marketplace) via `ioredis` | Pub/Sub + atomic counters for many Function instances |
| Tests | Vitest (shared unit tests, API integration tests, `ioredis-mock` for two-instance tests) | |

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
   `/socket.io` to the API, so everything is one origin). Local development needs no cloud services:
   images go to `UPLOAD_DIR`, and without `REDIS_URL` chat, presence and rate limits stay in the process.
   The API itself never migrates; if it says migrations are pending, rerun `npm run dev` or `npm run migrate`.
5. Optional sample content: `doppler run -- npm run seed -w @hexstory/api` (refuses to run in production).

### Configuration (environment variables)

Locally they come from Doppler; on Vercel from the project's environment variables (some injected by the
Neon and Redis integrations). The complete reference, with which are secrets and where each comes from, is
in [DEPLOYMENT.md §7](DEPLOYMENT.md#7-environment-variable-reference). The important ones:

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string (Neon: the **pooled** one) |
| `DATABASE_URL_UNPOOLED` | for migrations on Neon | Direct connection; `migrate` refuses pooled URLs |
| `APP_ORIGIN` | yes | Public origin, e.g. `https://hexstory.example`. Used for OAuth redirect and CSRF/WebSocket origin checks |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for sign-in | Without them sign-in is disabled (read-only site) |
| `ADMIN_EMAILS` | no | Comma-separated emails promoted to Moderator on sign-in |
| `STORAGE_BACKEND` | no | `local` (default; `UPLOAD_DIR`) or `r2` (default and required on Vercel) |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_STAGING_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_BASE_URL` | with `r2` | See DEPLOYMENT.md §3 |
| `REDIS_URL` | on Vercel | Shared chat fan-out, presence, cooldowns and rate limits. Optional locally |
| `DB_POOL_MAX` | no | Connections per process (default 10; 5 on Vercel) |
| `TRUST_PROXY` | no | `true` when behind a proxy that overwrites `X-Forwarded-For` (default `true` on Vercel) |
| `PORT`, `NODE_ENV`, `UPLOAD_DIR` | no | Local server settings (`NODE_ENV` defaults to `production` on Vercel) |
| `VITE_MAP_STYLE_URL` | no (build-time) | Alternative MapLibre style; also add its origin to `MAP_ORIGINS` in `apps/api/src/app.ts` (CSP) |
| `VITE_FEATURE_ADS` | no (build-time) | `true` renders ad slots (see Extension points) |

`VERCEL` and `VERCEL_ENV` are set by Vercel. `VERCEL_ENV` (`production`/`preview`) decides which database
the deployment may use (see "Environments" below); locally it is `development`.

### Deployment (Vercel)

Full, click-by-click setup is in **[docs/DEPLOYMENT.md](DEPLOYMENT.md)**. The shape:

- **One Vercel project** at the repo root (framework preset *Other*), configured by `vercel.json`.
  The build (`scripts/vercel-build.mjs`) builds the web app, copies it **minus `index.html`** to
  `apps/web/dist-static` (the CDN output), and bundles the API to `apps/api/dist/vercel.mjs`.
- **One Function**, `api/index.js`, exports Fastify's Node server with Socket.IO attached (Vercel's
  documented pattern for `ws`/Socket.IO servers). A single rewrite sends every path except `/assets/*` to it,
  so `/api`, `/auth`, `/socket.io` and page navigations all reach Fastify with their original paths.
  Static files (`/assets/*`, `favicon.svg`) are served by the CDN first; a missing asset is a plain 404.
- `index.html` is deliberately **not** a static file: Fastify serves it so every page gets the same Helmet
  headers, including a CSP whose image/upload origins come from the R2 settings at runtime.
- Module scope in `serverless.ts` runs once per Function instance: one database pool, one pair of Redis
  connections and one presence timer per instance, never per request.
- Functions run up to `maxDuration` (300 s in `vercel.json`, the Hobby maximum; Pro allows 800 s), and a
  WebSocket closes when that is reached. Clients reconnect automatically and refetch history (§7).
- A Vercel Function accepts at most 4.5 MB per request, so image originals (up to 6 MB) are uploaded by the
  browser straight to R2 (§8, "Malicious uploads").

### Environments and migrations

- **Migrations never run while serving.** `npm run migrate` (locally) or `npm run migrate:production` /
  `migrate:preview` (via `vercel env run`) applies them over the **direct** connection, holding a
  session-level advisory lock so a second concurrent run fails immediately. Each file runs in its own
  transaction with `lock_timeout = 15s`.
- **Environment marker.** `migrate --env <name>` records the environment in `app_meta`. Migrating a database
  marked for another environment fails (unless `--retarget`, for deliberate copies such as a Neon branch).
- **Startup and build checks.** The API refuses to start unless the database is marked for this deployment's
  environment (`VERCEL_ENV`, else `development`) and has every migration in `apps/api/migrations`; it never
  applies them itself. Production and preview builds run the same read-only check (`migrate --check`) so a
  deployment that couldn't start is never promoted. A preview deployment pointed at the production database
  therefore fails to build and to start, instead of writing to it.
- Redis keys and the Pub/Sub channel are prefixed `hx:<environment>:`, so environments sharing one Redis
  database don't hear each other's chat.

### Tests

```bash
npm run typecheck
npm test                       # shared unit tests + API unit tests (*.unit.test.ts)
TEST_DATABASE_URL=postgres://.../hexstory_test npm test -w @hexstory/api   # + integration tests
TEST_REDIS_URL=redis://localhost:6379 TEST_DATABASE_URL=... npm test -w @hexstory/api  # two-instance tests on a real Redis
```

API tests **wipe** the database in `TEST_DATABASE_URL` (`DROP SCHEMA public CASCADE`). Never point it at real
data. `test/realtime.test.ts` runs two app instances sharing Postgres and Redis (ioredis-mock unless
`TEST_REDIS_URL` is set) and checks cross-instance chat, moderation, presence expiry, cooldowns, shared rate
limits and resync.

## 5. Architecture

```
                         ┌── /assets/* ─────────── Vercel CDN (built JS/CSS)
Browser ── React SPA ────┼── pages, /api, /auth ─┐
   (MapLibre globe)      ├── WS /socket.io ──────┼── Fastify + Socket.IO (N Function instances)
                         │                       │      ├── Neon Postgres (pooled; durable data, chat history)
                         │                       │      ├── Redis Cloud (Pub/Sub, presence, cooldowns, rate limits)
                         │                       │      └── R2 (write processed images, read staged originals)
                         ├── PUT original ─────────────── R2 staging bucket (pre-signed URL, private)
                         ├── <img> ────────────────────── R2 public bucket via custom domain
                         └── tiles ────────────────────── OpenFreeMap
```

- Locally the same app runs as one process (`npm run dev`): images on disk at `/media`, coordination in memory.
- On Vercel each Function instance runs the whole Fastify app; nothing an instance keeps in memory is relied
  on across requests except connection pools and the WebSockets it accepted.
- The SPA keeps the map mounted permanently; every route renders into a single floating **panel**
  (`components/Panel.tsx`): a right-hand card on desktop and a bottom sheet under 720px.
- Map ↔ panel communication goes through `map/MapContext.tsx`: active hex, story footprint, editor
  selection mode, and `focusCells()` (which waits for the map to load and only moves the camera when the
  target is hidden under the panel).

### The hex model

- Stories are stored at **base resolution 5** (~253 km² per hex).
- The map shows resolution **2/3/4/5** depending on zoom (`resForZoom` in `packages/shared/src/hex.ts`).
- `story_cells` indexes every story under its base cells **and all their parents** (res 2–5), so "stories in
  this hex" is a single indexed lookup at any zoom, and so are the per-hex counts that tint the map.
- Revisions store the selection **compacted** (`compactCells`) to keep rows small; the index is rebuilt
  from the current revision whenever it changes.
- A story may cover up to **5,000 base cells (~1.26M km²)**. The size check uses `baseCellCount()` *before*
  expanding, because expansion is exponential in resolution.
- In the editor, clicking a hex at the current zoom adds or removes all of its base cells, so zoomed out one
  click covers a large area and zoomed in gives precision. The UI shows the area in km², not a hex count.

### Data model (`apps/api/migrations/001_init.sql`)

| Table | Purpose |
|---|---|
| `users` | Google `sub`, email (private), public `display_name` (unique, case-insensitive), `trust_level` 0–3, `terms_accepted_at`, `banned_at`, `deleted_at` |
| `sessions` | `id` = SHA-256 of the cookie token (raw token never stored), expiry (30 days, sliding) |
| `stories` | Identity + pointer `current_revision_id`, `status` (unreviewed/active/hidden), `protection_level`, `cell_count` |
| `story_revisions` | Append-only content: title, `content` (rich document, jsonb), `body` (plain text derived from content), `image_key`/`image_credit` (the first image, used as thumbnail), compact cells, dates, sources (jsonb, ≥1 enforced by CHECK), `status` (pending/accepted/rejected), `flags`, generated `source_count` and `sort_key` |
| `story_cells` | Derived index of the current revision's cells at res 2–5 |
| `comments` | The Square's messages, per display cell |
| `reports` | User reports on stories, revisions, comments or users |
| `mod_actions` | Append-only audit log of every moderation action |
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
`is_ongoing` and `is_approx` ("c. 1848"). Lists are ordered **by event date, most recent first, not by when
the story was added**: ongoing events first, then `sort_key` = the latest date the event touches
(`end` if present, else `start`) as `year*10000 + month*100 + day`. The same formula is in
`packages/shared/src/dates.ts` (`sortKey`) and the generated column.

## 6. Trust & moderation

All numbers live in `apps/api/src/policy.ts`. Change them there and update this table.

| Level | Name | How you get it | What changes |
|---|---|---|---|
| 0 | Newcomer | Sign in + accept terms | Can create stories (shown with a "New" tag until a reviewer marks them reviewed). Edits to stories you didn't create, or that are past "unreviewed", are **held for review** |
| 1 | Member | Account ≥ 3 days **and** accepted contributions on ≥ 3 distinct stories | Edits go live immediately (unless auto-flagged or the story is protected) |
| 2 | Reviewer | Account ≥ 30 days, ≥ 25 distinct stories, **≥ 15 of them started by someone else** | Watchtower access: accept/reject held edits, restore versions, hide stories and chat messages, resolve reports |
| 3 | Moderator | Email in `ADMIN_EMAILS` | Everything above + protect stories, unhide stories, ban users |

Promotion counts *distinct stories*, so repeatedly editing your own story cannot farm trust (tested).

**Rules that make overwriting useless:**

1. **Append-only revisions.** An edit inserts a new revision; `stories.current_revision_id` points to the
   live one. Restoring an old version copies it into a *new* revision, keeping history linear.
2. **Held edits.** An edit goes live only if the author's trust ≥ `max(Member, story.protection_level)`
   (or they created the still-unreviewed story) **and** it has no auto-flags (unless the author is a Reviewer).
3. **Auto-flags** (`detectFlags`): removing > 60% of the body (`large-removal`); newcomer adding > 2 links,
   counting both linked text and typed URLs (`many-links`).
4. **Optimistic concurrency.** Edits carry `baseRevisionId`; if the story moved on, the API returns 409
   `stale` and the user must reload, so concurrent editors never silently overwrite each other.
5. **No self-review.** Nobody can accept their own held edit. Restore only accepts versions that were once
   accepted and respects protection, so it can't be used to sneak a held edit live.
6. **Visibility.** Pending and rejected versions (which may contain abuse) are visible only to Reviewers
   and their author. Hidden stories are visible only to Reviewers; only Moderators can unhide.
7. **Daily limits** per trust level (stories 3/20/100/1000, edits 10/60/300/5000, reports 30), enforced inside
   the write transaction under a per-user advisory lock so parallel requests can't exceed them.
8. **Reports** from any signed-in user (once per item while open) go to the Watchtower.
9. **Audit log.** Every accept/reject/restore/hide/approve/protect/ban/report resolution is in `mod_actions`.
10. **Bans** delete the user's sessions and block all writing and chat immediately.

## 7. The Square (live chat)

- Socket.IO on `/socket.io`, **WebSocket transport only** (Vercel has no sticky sessions, so long-polling
  requests would land on different instances). One room per display hex (`cell:<h3>`); a connection is in
  at most one room.
- Anyone can listen; posting requires a signed-in user who accepted the terms and isn't banned.
  Newcomer accounts can post after 10 minutes. 1 message / 2 s per user, 500 characters max.
- Every `send` re-reads the session, so bans and sign-outs apply instantly.
- Flood control: more than 30 events per 10 s on one connection drops it (per connection, in memory).
- History: last 50 visible messages via `GET /api/cells/:cell/messages`; Reviewers can hide messages.

**Across instances** (`coordination.ts`). Each WebSocket stays on the instance that accepted it. Broadcasts
(`message`, `hidden`, `presence`) are published on one Redis Pub/Sub channel; every instance relays them to
its own sockets. We use plain Pub/Sub rather than `@socket.io/redis-adapter` because we only need one-way
room broadcasts, and publishing ourselves lets the server *await* the publish and tell the sender when it
failed. Two Redis connections per instance (commands + subscriber).

- **Presence** is a Redis sorted set per room (member = instance + socket id, score = expiry). Instances
  refresh their sockets' entries every 20 s and entries expire after 60 s, so sockets of a crashed instance
  stop counting within a minute even though their disconnect handlers never ran. The same timer re-sends
  each room's corrected count to local sockets.
- **Cooldown** (1 message / 2 s) is `SET NX PX` in Redis, shared by all instances and tabs.

**Delivery guarantees.** PostgreSQL is the record; Redis only relays.

- A message is saved before it is broadcast. `ack {ok: true}` means saved *and* published to every instance.
- If the cooldown can't be checked (Redis down), the message is rejected and **not** saved.
- If the publish fails after saving, the sender gets `{ok: true, delayed: true}` ("Sent, but it may take a
  moment to reach everyone"), sockets on the same instance still get it, and others see it on their next refetch.
- Pub/Sub is at-most-once: an instance whose subscriber connection dropped misses what was published
  meanwhile. When it reconnects it emits `resync` to its sockets.
- **Client recovery** (`useSquare.ts`): on every (re)connect the client re-joins and waits for the join
  ack (it's then in the room), then refetches history; on `resync` it refetches too. After a successful
  refetch, live messages received before it are dropped and the list is the union of fresh history and newer
  live messages, de-duplicated by id (`mergeMessages`). So messages and moderator removals missed while
  disconnected are reconciled, and nothing appears twice.
- Remaining gaps: a hidden message stays on screen for a client that missed the `hidden` event until its next
  refetch; messages older than the last 50 aren't reloaded; presence can lag by up to a minute after a crash.

## 8. Security

| Threat | Mitigation |
|---|---|
| CSRF | `SameSite=Lax` session cookie + every non-GET `/api` and `/auth` request must carry `Origin: APP_ORIGIN` (`app.ts`) |
| Cross-site WebSocket hijacking | Socket.IO `allowRequest` rejects any request whose `Origin` isn't `APP_ORIGIN` (browsers always send it on WebSocket upgrades; non-browser clients without one are allowed) |
| Session theft | httpOnly cookie, `Secure` in production, only a SHA-256 of the token stored, 30-day sliding expiry |
| OAuth | State + PKCE (arctic); email must be verified; `returnTo` only accepts plain same-site paths (no `//`, backslashes, control chars or spaces) |
| XSS | React escaping; story content is a validated document rendered element by element (`RichContent.tsx`), never as HTML; no `dangerouslySetInnerHTML`; markdown only for bundled legal pages, without raw HTML; story and source links must be `http(s)` and render with `rel="nofollow ugc noopener noreferrer"`; images in stories can only be our own re-encoded uploads |
| Content injection | Strict CSP (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`; allow-listed: tiles origin, the R2 image domain in `img-src`, the R2 S3 endpoint in `connect-src`), `nosniff`, Helmet defaults. `index.html` is always served by Fastify so these headers apply on Vercel too |
| SQL injection | Only parameterised postgres.js queries; identifiers only from fixed maps; `sql.unsafe` only runs migration files |
| Malicious uploads | Originals (max 6 MB) go to a **private staging bucket** through a pre-signed PUT that is valid for 5 minutes and signs the exact byte count and `application/octet-stream`; the key is `<userId>/<uploadId>` and completion rebuilds it from the session, so nobody can claim another user's upload. The API then reads the original (size re-checked), decodes and **re-encodes to WebP** with sharp (strips EXIF/GPS, rejects non-images, 50 MP cap), publishes full + thumbnail, and deletes the original. If either write fails both are removed and the client gets an error. Staged leftovers expire by an R2 lifecycle rule (1 day). No URL fetching. 20 upload slots/hour/user. R2 credentials never reach the browser |
| Resource abuse | 300 req/min/IP global and the upload limits, shared across instances in Redis (fail open if Redis is down; the daily limits in Postgres still apply), per-user daily limits, area size checked before expansion, 512 KB body limit, Socket.IO flood control |
| Spoofed client IPs | Fastify trusts `X-Forwarded-For` only with `TRUST_PROXY=true` (default on Vercel, which overwrites the header with the real client IP) |
| Environment mix-ups | Database environment marker checked at build and start; migrations only by explicit command over a direct connection; Redis keys prefixed per environment (§4) |
| Privacy | Emails and Google IDs never leave the API; Google profile pictures and full names are never stored; account deletion anonymises the user and deletes sessions |

## 9. UI design decisions

- **Visual language:** warm paper background (`--bg #f6f4f0`), white floating cards with soft shadow,
  one accent colour (terracotta `#c2410c`) for actions and occupied hexes, blue (`#1d4ed8`) only for "this
  story's area / your selection". Serif (`Iowan Old Style`/Georgia) for story titles and bodies, system
  sans for UI. Tokens are at the top of `apps/web/src/styles/global.css`.
- **Globe:** MapLibre globe projection; a faint res-2 hex grid covers the whole world when zoomed out, and
  finer grids appear for the viewport as you zoom. Hovering outlines the hex under the cursor. Occupied hexes
  get more opaque as they hold more stories.
- **First visit:** a single dark pill "Every place has a story. Tap a hexagon to explore." It disappears for
  good once any hex is opened (remembered in `localStorage`, safe if storage is blocked).
- **Hex panel:** title "This region" + coordinates, tabs **Stories** | **The Square**, sticky
  "Write a story here" button. Story rows: 56px thumbnail (`object-fit: cover`, hex glyph if none), serif
  title (2 lines max), event date, **source count badge** (neutral grey for 1, darker for 2–3, teal for 4+),
  area for multi-hex stories, and a quiet "New" tag for unreviewed stories.
- **Story view:** image, title, date · sources · area, body, numbered sources with hostnames, the disclaimer
  box, then Edit · Versions · Share · Report. Reviewer tools are folded in a `<details>`.
- **Editor:** opens in a wide panel while the map switches to *select mode* (clicks toggle regions). Fields:
  Title, When (defaults to **today**; year + month + optional day; One date / Has an end / Still ongoing;
  approximate), Where (area in km², Show on map, Clear), **The story**, Sources (title + optional link, at least
  one), and "What did you change?" for edits. The licence notice sits above the Publish button. A browser
  warning appears when leaving with unsaved changes.
- **The story editor** (`components/RichEditor.tsx`) is a document-style surface (serif, top to bottom, like a
  word processor) with one toolbar: **B**, *I*, Heading, Quote, bulleted and numbered lists, **Link** and
  **Photo**. Link opens an inline address field (with no selection, the address itself is inserted as the
  link). Photo uploads and inserts the image where the cursor is; a selected photo shows a caption/credit
  field and "Remove photo". The first photo becomes the story's thumbnail in lists.
- **BCE dates** are fully supported by the data model, but the era picker is hidden for new stories and only
  appears when editing a story whose date is already BCE. Revisit after user testing.
- **Sign-in:** never a wall. Write and chat actions show an inline "Sign in with Google" prompt and return
  you to the same page afterwards. The first sign-in shows a one-time **Welcome** dialog: choose a public name
  (pre-filled with the Google first name only; the field can be cleared and retyped freely) and accept the Terms, Privacy Policy and CC BY-SA licence.
- **Required legal text in the UI:** the Welcome checkbox, the disclaimer under every story, the licence
  notice in the editor, the "Messages are public. Be kind." chat placeholder, and About · Terms · Privacy links
  bottom-left.

### Routes

| Path | View |
|---|---|
| `/` | Map only |
| `/h/:cell` (`?tab=square`) | Hex panel: Stories / The Square |
| `/s/:id` | Story |
| `/s/:id/edit`, `/new?cell=` | Editor (lazy-loaded) |
| `/s/:id/versions`, `/v/:revisionId` | Versions list, single version with word diff and review actions |
| `/watchtower` | Review queue (Reviewers) |
| `/about`, `/terms`, `/privacy` | Modal pages (markdown) |

## 10. API reference

All JSON. Errors are `{ error: code, message }`, and `message` is always safe to show.

| Method & path | Who | Purpose |
|---|---|---|
| `GET /api/session` | anyone | `{ user, signInEnabled }` |
| `PATCH /api/me` | signed in | `{ displayName?, acceptTerms? }` |
| `DELETE /api/me` | signed in | Delete account (anonymise) |
| `GET /auth/google?returnTo=`, `GET /auth/google/callback`, `POST /auth/logout` | | Sign-in flow |
| `GET /api/cells?res=2..5` | anyone | `[{ cell, count }]` for tinting the map (10 s cache) |
| `GET /api/cells/:cell/stories?offset=` | anyone | Story list, event-date order, 30 per page |
| `GET /api/cells/:cell/messages` | anyone | Last 50 Square messages |
| `GET /api/stories/:id` | anyone | Story + current revision + `can` permissions |
| `POST /api/stories` | writer | Create → `{ storyId, revisionId, status: live|pending }` |
| `PUT /api/stories/:id` | writer | Edit (needs `baseRevisionId`) |
| `GET /api/stories/:id/revisions`, `GET /api/revisions/:id` | anyone* | History (*unaccepted only for reviewers/author) |
| `POST /api/revisions/:id/review` | reviewer | `{ decision: accept|reject }` |
| `POST /api/stories/:id/restore` | reviewer | `{ revisionId }` |
| `POST /api/stories/:id/status` | reviewer | `{ status: active|hidden }` (unhide: moderator) |
| `POST /api/stories/:id/protection` | moderator | `{ level: 0..3 }` |
| `POST /api/uploads` | writer | `{ size }` → `{ id, upload: { url, method: 'PUT', headers } }` (20/hour) |
| `PUT <upload.url>` | browser | The original's bytes. Pre-signed R2 URL in production; locally `PUT /api/uploads/:id/original` |
| `POST /api/uploads/:id/complete` | writer (same user) | Validate, re-encode, publish → `{ imageKey, imageUrl, thumbUrl }` |
| `POST /api/reports` | writer | `{ targetType, targetId, reason, details? }` |
| `GET /api/watchtower` | reviewer | `{ pending, unreviewed, reports }` |
| `POST /api/reports/:id/resolve` | reviewer | `{ resolution: dismissed|actioned }` |
| `POST /api/messages/:id/hide` | reviewer | Hide a chat message |
| `POST /api/users/:id/ban` | moderator | `{ banned, reason? }` |
| Socket.IO `join` (acked), `leave`, `send` (ack `{ok, delayed?}`) → `message`, `presence`, `hidden`, `resync` | | The Square |

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
- **Timeline slider:** `sort_key` is already indexed per revision; add a `from/to` filter to the cell counts
  and list queries.
- **Place search:** add a geocoder (e.g. self-hosted Nominatim/Photon) and call `focusCells([cellAt(...)])`.
- **Dark mode:** add dark tokens in `global.css` and a dark basemap style URL.
- **More realtime features:** add an event type to `RoomEvent` in `coordination.ts` and a case in `relay`
  (`realtime/square.ts`); everything published there reaches every instance.

## 12. Procedures

- **Schema change:** add `apps/api/migrations/NNN_description.sql` (next number). Apply it with
  `npm run migrate` (local), then `npm run migrate:preview` / `migrate:production` **before** deploying code
  that needs it (DEPLOYMENT.md §6). Keep migrations backward compatible (add, then remove in a later
  release), because the previous deployment keeps serving until the new one is promoted. Never edit an
  applied migration.
- **Change a policy number:** edit `apps/api/src/policy.ts`, update §6 here, run the tests.
- **Make someone a Moderator:** add their email to `ADMIN_EMAILS` in Doppler; it applies at their next sign-in.
  (To make someone a Reviewer by hand: `UPDATE users SET trust_level = 2 WHERE display_name = '...'`.)
- **Production deploy:** Vercel, see [DEPLOYMENT.md](DEPLOYMENT.md).
- **Alternative: single server:**
  1. Doppler config `prd` with `NODE_ENV=production`, `APP_ORIGIN=https://<domain>`, `TRUST_PROXY=true`,
     `UPLOAD_DIR=/var/lib/hexstory/uploads`, real Google credentials (add the production redirect URI).
  2. `npm ci && npm run build` (builds the SPA into `apps/web/dist`).
  3. `doppler run --config prd -- npm run start:local` under systemd (or `npm start` from the root, which runs
     it through Doppler); it migrates, then starts.
  4. Put Caddy or nginx in front for TLS, proxying everything to :3000 **including WebSocket upgrades** on `/socket.io`.
- **Backups:** on Neon, point-in-time restore within the plan's history window plus a periodic `pg_dump -Fc`
  of `DATABASE_URL_UNPOOLED` kept elsewhere; R2 objects are durable but not versioned (DEPLOYMENT.md §2). On a
  single server: nightly `pg_dump -Fc` and a copy of `UPLOAD_DIR`, both off the server. Test a restore.
- **Before launch:** fill the placeholders in `legal/*.md` (`[DATE]`, `[CONTACT EMAIL]`, `[JURISDICTION]`,
  chat retention); have a lawyer review; register a DMCA agent if operating in the US; publish the
  Privacy/Terms URLs on the Google OAuth consent screen.

## 13. Known limitations / follow-ups

- Processed images are public as soon as an upload completes and never garbage-collected if unused
  (rate-limited to 20/hour/user). Follow-up: track uploads, serve only once referenced, sweep orphans.
  (Unprocessed originals are private and expire after a day.)
- Locally, abandoned staged originals stay in `<UPLOAD_DIR>-staging` until deleted by hand.
- Reviewers are auto-promoted by activity; there is no UI to demote (use SQL). Consider manual promotion
  if abuse appears.
- WebSockets close at the Function's `maxDuration` (5 min on Hobby), so open Squares reconnect that often;
  each open connection keeps its instance's memory billed (DEPLOYMENT.md §8).
- Chat delivery between instances is at-most-once; clients reconcile from Postgres on reconnect/resync (§7).
- Expired sessions are not deleted (they are ignored); a periodic cleanup could be added as a Vercel cron.
- Grid lines are only drawn when ≤ 8,000 cells would be visible; at very wide res-3+ views only occupied
  hexes are drawn.
- No full-text search yet (Postgres `tsvector` is the intended route).
- Map tiles depend on the public OpenFreeMap service; self-host or switch provider via `VITE_MAP_STYLE_URL`.

## Changelog

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

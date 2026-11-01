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
├── apps/
│   ├── api/                 Fastify server (REST + Socket.IO), serves the built web app in production
│   │   ├── migrations/      Numbered SQL migrations (never edit an applied one)
│   │   ├── src/
│   │   │   ├── index.ts     Entry point: config → migrate → listen
│   │   │   ├── app.ts       Fastify assembly: security headers, CSRF check, session, routes, static
│   │   │   ├── config.ts    Env var schema (fails fast on bad config)
│   │   │   ├── policy.ts    ALL anti-abuse numbers & rules (rate limits, promotion, auto-flags)
│   │   │   ├── auth/        Google OAuth flow, sessions
│   │   │   ├── routes/      Thin HTTP layer: parse input → call a service
│   │   │   ├── services/    Business logic + SQL (stories, users, reports, square, modlog)
│   │   │   ├── realtime/    The Square (Socket.IO)
│   │   │   ├── storage/     Image storage interface (local disk today)
│   │   │   └── seed.ts      Dev-only sample stories
│   │   └── test/            Integration tests against a real Postgres
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
├── doppler.yaml             Doppler project/config binding
└── .env.example             List of secrets Doppler must provide (no values)
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
| Secrets | Doppler (`doppler run --`) | No secrets in files |
| Tests | Vitest (shared unit tests, API integration tests) | |

The API runs TypeScript directly with `tsx` (also in production); there is no separate API build output.

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
4. `npm install`, then `npm run dev`. It migrates the DB and starts the API on :3000 and the web app on :5173
   (Vite proxies `/api`, `/auth`, `/media`, `/socket.io` to the API, so everything is one origin).
5. Optional sample content: `doppler run -- npm run seed -w @hexstory/api` (refuses to run in production).

### Configuration (environment variables, all from Doppler)

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `APP_ORIGIN` | yes | Public origin, e.g. `https://hexstory.example`. Used for OAuth redirect and CSRF/WebSocket origin checks |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | for sign-in | Without them sign-in is disabled (read-only site) |
| `ADMIN_EMAILS` | no | Comma-separated emails promoted to Moderator on sign-in |
| `PORT` | no | API port (default 3000) |
| `NODE_ENV` | no | `development` / `production` / `test` |
| `UPLOAD_DIR` | no | Where images are written (default `./uploads`) |
| `TRUST_PROXY` | no | `true` behind a reverse proxy so client IPs (rate limits) are correct |
| `VITE_MAP_STYLE_URL` | no (build-time) | Alternative MapLibre style; also add its origin to `MAP_ORIGINS` in `apps/api/src/app.ts` (CSP) |
| `VITE_FEATURE_ADS` | no (build-time) | `true` renders ad slots (see Extension points) |

### Tests

```bash
npm run typecheck
npm test                                    # shared unit tests; API tests need the variable below
TEST_DATABASE_URL=postgres://.../hexstory_test npm test -w @hexstory/api
```

API tests **wipe** the database in `TEST_DATABASE_URL` (`DROP SCHEMA public CASCADE`). Never point it at real data.

## 5. Architecture

```
Browser ── React SPA ──┬── REST  /api/*  ─┐
   (MapLibre globe)    ├── OAuth /auth/* ─┼── Fastify (one process) ── Postgres
                       ├── WS    /socket.io ┘        │
                       └── tiles: OpenFreeMap        └── UPLOAD_DIR (served at /media)
```

- One Node process serves the API, the Socket.IO Square, uploaded images, and (in production) the built SPA.
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

- Socket.IO on `/socket.io`, one room per display hex (`cell:<h3>`). A connection is in at most one room.
- Anyone can listen; posting requires a signed-in user who accepted the terms and isn't banned.
  Newcomer accounts can post after 10 minutes. 1 message / 2 s per user, 500 characters max.
- Every `send` re-reads the session, so bans and sign-outs apply instantly.
- Flood control: more than 30 events per 10 s on one connection drops it.
- History: last 50 visible messages via `GET /api/cells/:cell/messages`; Reviewers can hide messages
  (removed live for everyone in the room).
- Presence ("3 people here now") is the room's socket count.
- **Single-process assumption:** rooms, presence and chat rate limits are in memory. To run several API
  instances, add the Socket.IO Redis adapter and move the rate-limit maps to Redis.

## 8. Security

| Threat | Mitigation |
|---|---|
| CSRF | `SameSite=Lax` session cookie + every non-GET `/api` and `/auth` request must carry `Origin: APP_ORIGIN` (`app.ts`) |
| Cross-site WebSocket hijacking | Socket.IO `allowRequest` rejects any request whose `Origin` isn't `APP_ORIGIN` (same-origin polling GETs carry none and are allowed) |
| Session theft | httpOnly cookie, `Secure` in production, only a SHA-256 of the token stored, 30-day sliding expiry |
| OAuth | State + PKCE (arctic); email must be verified; `returnTo` only accepts plain same-site paths (no `//`, backslashes, control chars or spaces) |
| XSS | React escaping; story content is a validated document rendered element by element (`RichContent.tsx`), never as HTML; no `dangerouslySetInnerHTML`; markdown only for bundled legal pages, without raw HTML; story and source links must be `http(s)` and render with `rel="nofollow ugc noopener noreferrer"`; images in stories can only be our own re-encoded uploads |
| Content injection | Strict CSP (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, tiles origin allow-listed), `nosniff`, Helmet defaults |
| SQL injection | Only parameterised postgres.js queries; identifiers only from fixed maps; `sql.unsafe` only runs migration files |
| Malicious uploads | Max 6 MB, decoded and **re-encoded to WebP** by sharp (strips EXIF/GPS, rejects non-images), 50 MP pixel cap, random UUID names, 20 uploads/hour/user |
| Resource abuse | 300 req/min/IP global, per-user daily limits, area size checked before expansion, 512 KB body limit, Socket.IO flood control |
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
| `POST /api/uploads` | writer | multipart `file` → `{ imageKey, imageUrl, thumbUrl }` |
| `POST /api/reports` | writer | `{ targetType, targetId, reason, details? }` |
| `GET /api/watchtower` | reviewer | `{ pending, unreviewed, reports }` |
| `POST /api/reports/:id/resolve` | reviewer | `{ resolution: dismissed|actioned }` |
| `POST /api/messages/:id/hide` | reviewer | Hide a chat message |
| `POST /api/users/:id/ban` | moderator | `{ banned, reason? }` |
| Socket.IO `join`, `leave`, `send` → `message`, `presence`, `hidden` | | The Square |

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
- **Image storage on S3/R2:** implement the `Storage` interface (`storage/index.ts`); `publicUrl` returns the
  CDN URL; set `localDir` to `null`; add the CDN origin to `img-src` in the CSP.
- **Source verification (planned):** add a `source_checks` table keyed by URL, a background job, and a
  per-source status in `StoryContent`. The neutral source badge can then reflect verified counts.
- **Timeline slider:** `sort_key` is already indexed per revision; add a `from/to` filter to the cell counts
  and list queries.
- **Place search:** add a geocoder (e.g. self-hosted Nominatim/Photon) and call `focusCells([cellAt(...)])`.
- **Dark mode:** add dark tokens in `global.css` and a dark basemap style URL.
- **Scaling out:** Socket.IO Redis adapter, move in-memory rate limits/caches to Redis, S3 storage.

## 12. Procedures

- **Schema change:** add `apps/api/migrations/NNN_description.sql` (next number). It runs automatically
  on start (and with `npm run migrate`), each file in its own transaction. Never edit an applied migration.
- **Change a policy number:** edit `apps/api/src/policy.ts`, update §6 here, run the tests.
- **Make someone a Moderator:** add their email to `ADMIN_EMAILS` in Doppler; it applies at their next sign-in.
  (To make someone a Reviewer by hand: `UPDATE users SET trust_level = 2 WHERE display_name = '...'`.)
- **Production deploy (single server):**
  1. Doppler config `prd` with `NODE_ENV=production`, `APP_ORIGIN=https://<domain>`, `TRUST_PROXY=true`,
     `UPLOAD_DIR=/var/lib/hexstory/uploads`, real Google credentials (add the production redirect URI).
  2. `npm ci && npm run build` (builds the SPA into `apps/web/dist`).
  3. `doppler run --config prd -- npm run start -w @hexstory/api` under systemd (or `npm start` from the
     root, which runs it through Doppler).
  4. Put Caddy or nginx in front for TLS, proxying everything to :3000 **including WebSocket upgrades** on `/socket.io`.
- **Backups:** nightly `pg_dump -Fc` and a copy of `UPLOAD_DIR`, both stored off the server. Test a restore.
- **Before launch:** fill the placeholders in `legal/*.md` (`[DATE]`, `[CONTACT EMAIL]`, `[JURISDICTION]`,
  chat retention); have a lawyer review; register a DMCA agent if operating in the US; publish the
  Privacy/Terms URLs on the Google OAuth consent screen.

## 13. Known limitations / follow-ups

- Uploaded images are public as soon as they're uploaded and never garbage-collected if unused (rate-limited
  to 20/hour/user). Follow-up: track uploads, serve only once referenced, sweep orphans.
- Reviewers are auto-promoted by activity; there is no UI to demote (use SQL). Consider manual promotion
  if abuse appears.
- Single-process assumptions (see §7).
- Grid lines are only drawn when ≤ 8,000 cells would be visible; at very wide res-3+ views only occupied
  hexes are drawn.
- No full-text search yet (Postgres `tsvector` is the intended route).
- Map tiles depend on the public OpenFreeMap service; self-host or switch provider via `VITE_MAP_STYLE_URL`.

## Changelog

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

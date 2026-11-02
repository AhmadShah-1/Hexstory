# Importing events in bulk

Hexstory can load many events at once from **JSON Lines** files: one event per line, each with its
sources, place, dates, connections, timeline of developments and an optional photo. The importer
(`apps/api/src/import.ts`) validates every event with the same rules the site enforces, checks that
source links exist, and writes stories through the same code the site uses, as the **Hexstory Archive**
account. Imported stories are labelled "Imported from public sources" and can be corrected and edited like
any other story.

This document has two parts you can hand to an AI agent (or follow yourself):

- **[Part 1: Gathering events](#part-1-gathering-events)**: for whoever researches events and writes the files.
- **[Part 2: Importing](#part-2-importing)**: for whoever loads the files into a database.

Files live in `data/import/` (create it if missing): `events-001.jsonl`, `events-002.jsonl`, … and photos in
`data/import/photos/`. Commit them if you want a record of what was imported; `.import-cache.json` (link
check results) is ignored by git.

---

## Part 1: Gathering events

> **Task:** research real historical and current events and write them to `data/import/events-NNN.jsonl`
> in the format below, with a freely licensed photo for each where one exists. Target: **5,000 events**,
> favouring **recent events (2020 to today), especially ongoing ones**.

### What to collect

- **Mix** (approximate): 70% from 2020 to today, 20% from 2000–2019, 10% earlier events that recent events
  build on (their causes and predecessors, so they can be connected).
- **Ongoing events first**: wars, crises, protests, negotiations, disasters still unfolding. Each gets a
  timeline of `developments` (typically 3–15 dated steps), rather than a separate event per step.
- **Cover the whole world**: every continent and many countries, not only the US and Europe; include
  regional and local events with lasting significance, not only headline events.
- **Spread the categories**: `war`, `protest`, `politics` (political decisions, elections, laws, treaties),
  `science` (discoveries, missions, breakthroughs), `disaster` (natural and industrial), `culture`
  (cultural movements, major cultural events), `landmark` (historical places and monuments), `local`
  (local events). Give each event 1–3.
- **One event, one story.** A war is one event; its battles, ceasefires and turning points are developments.
  Write a separate event only for something significant in its own right (e.g. a major battle with its own
  literature), and connect it (`part-of`).

### Sources: the most important rule

- **Every fact must come from a page you actually opened in this session.** Never cite a URL from memory,
  never guess or construct a URL, never cite a page you couldn't read. If you can't find a source for
  something, leave it out.
- **Every event needs at least one source; events from 2020 on, ongoing events and anything contested need
  at least two independent sources.** Every development needs its own source(s).
- **Good sources:** Wikipedia (for overviews; cite the article), established news organisations across the
  spectrum: Reuters, AP, AFP, BBC, NPR, PBS, CNN, Fox News, NBC, CBS, ABC News, The Guardian, The New York
  Times, The Washington Post, The Wall Street Journal, Financial Times, The Economist, Al Jazeera, DW,
  France 24, NHK, CBC, ABC (Australia), South China Morning Post, The Hindu, and official bodies (UN agencies,
  WHO, USGS for earthquakes, NASA/ESA, national governments' official sites).
- **Avoid:** opinion and editorial pieces, blogs, social-media posts, press releases presented as news,
  advocacy or partisan sites, content farms, Wikipedia mirrors, search-result or AMP/redirect links, and
  links with tracking parameters (`utm_…`). Use the canonical article URL.
- **Source title format:** `Publisher: Headline (date)`, e.g. `BBC News: Sudan army retakes presidential palace (21 March 2025)`.
  For Wikipedia: `Wikipedia: War in Sudan (2023–present)`.

### Writing

- **Neutral and factual.** Attribute claims ("according to the UN", "the government said"). Give figures as
  reported, with their source ("at least 150 people died, according to …"). Where accounts conflict, say so
  and give both. No speculation, no adjectives doing the arguing.
- **Your own words.** Don't copy sentences from sources (copyright); summarise and paraphrase.
- **People:** name public figures central to the event. Don't name private individuals (victims, bystanders)
  unless they became widely known public figures in their own right.
- **No graphic detail** beyond what's needed to understand the event.

### The format

One JSON object per line (no line breaks inside an object; use `\n` inside strings). UTF-8.

| Field | Required | Rules |
|---|---|---|
| `key` | yes | Unique, stable id: lowercase words joined by hyphens, e.g. `sudan-war-2023`. **Never reuse or change a key**: re-importing a key updates that story. Check existing keys before adding (see the self-check below). |
| `title` | yes | 4–120 characters. What happened, plainly: `War in Sudan`, `Earthquake strikes Turkey and Syria`. |
| `summary` | yes | 20–300 characters, one or two sentences that stand on their own: what happened and why it matters. Shown before everything else. |
| `body` | yes | The full account, 600–2,500 characters recommended (40–10,000 allowed), 2–5 paragraphs separated by `\n\n`. Background, what happened, consequences. |
| `start` | yes | `YYYY`, `YYYY-MM` or `YYYY-MM-DD`; a minus sign for BCE (`-44-03-15`). As precise as the sources allow. Not in the future. |
| `end` | no | Same format. For events that lasted and have ended. Omit for single-day events and for ongoing ones. |
| `ongoing` | no | `true` only if it is still going on today. Then omit `end`. |
| `approximate` | no | `true` when the date is uncertain ("c. 1848"). |
| `location` | yes | `{ "lat": 15.5007, "lng": 32.5599, "place": "Khartoum, Sudan" }`: where it happened (or began), 4–5 decimals. `place` 2–120 characters: specific site, city, country. For a country-wide event, use where it started or its centre, and say so in `place` (e.g. `Kyiv, Ukraine (country-wide)`). |
| `categories` | yes | 1–3 of `war`, `protest`, `politics`, `science`, `disaster`, `culture`, `landmark`, `local`. |
| `people` | no | Up to 20 names of public figures central to it. |
| `sources` | yes | `[{ "title": "…", "url": "https://…" }]`, 1–19 entries, every one with a working link (see Sources). |
| `links` | no | Connections to other events **by key**: `[{ "key": "arab-spring", "relation": "part-of" }]`, up to 20. `relation` is read from *this* event: `preceded-by` (it came after and because of the other), `led-to`, `part-of`, `includes`, `related`. The other event shows the inverse automatically, so link once. Only link to keys that exist in these files (or were imported before). |
| `photo` | no (preferred) | See Photos. |
| `developments` | no | For ongoing or long events: `[{ "date": "2023-12-18", "title": "RSF enter Wad Madani", "details": "…", "location": { … } , "sources": [ … ] }]`. `title` 4–160 characters, `details` up to 2,000, `location` optional (same shape as above), at least one source each. Dated steps, oldest or newest first (order doesn't matter). |

Example (shown on several lines for reading; in the file it is **one line**):

```json
{"key": "sudan-war-2023",
 "title": "War in Sudan",
 "summary": "A war between Sudan's army and the paramilitary Rapid Support Forces that began in Khartoum in April 2023 and spread across the country.",
 "body": "Fighting broke out in Khartoum on 15 April 2023 between the Sudanese Armed Forces and the Rapid Support Forces (RSF), former partners who had shared power since a 2021 coup.\n\nThe war spread to Darfur, Kordofan and Gezira. The UN described the humanitarian situation as one of the worst in the world, with millions of people displaced.\n\n…",
 "start": "2023-04-15", "ongoing": true,
 "location": {"lat": 15.5007, "lng": 32.5599, "place": "Khartoum, Sudan"},
 "categories": ["war"],
 "people": ["Abdel Fattah al-Burhan", "Mohamed Hamdan Dagalo"],
 "sources": [
   {"title": "Wikipedia: War in Sudan (2023–present)", "url": "https://en.wikipedia.org/wiki/War_in_Sudan_(2023%E2%80%93present)"},
   {"title": "Reuters: …", "url": "https://www.reuters.com/…"}],
 "links": [{"key": "sudan-coup-2021", "relation": "preceded-by"}],
 "photo": {"file": "sudan-war-2023.jpg", "caption": "Smoke over Khartoum, April 2023", "author": "…", "license": "CC BY-SA 4.0", "source": "https://commons.wikimedia.org/wiki/File:…"},
 "developments": [
   {"date": "2023-12-18", "title": "RSF enter Wad Madani", "location": {"lat": 14.4012, "lng": 33.5199, "place": "Wad Madani, Sudan"}, "sources": [{"title": "…", "url": "https://…"}]},
   {"date": "2025-03-21", "title": "The army retakes the Republican Palace in Khartoum", "sources": [{"title": "…", "url": "https://…"}]}]}
```

### Photos (one per event preferred)

- **Only freely licensed photos**, in practice from **Wikimedia Commons** (`commons.wikimedia.org`). Photos
  from news organisations or agencies (Reuters, AP, AFP, Getty, the BBC…) are copyrighted and **must not be
  used**, even when their article is a source.
- Accepted licences (`license`): `public-domain`, `CC0`, `CC BY 2.0`/`2.5`/`3.0`/`4.0`, `CC BY-SA 2.0`/`2.5`/`3.0`/`4.0`.
  Copy the licence exactly as the Commons file page states it. No "fair use", no NC (non-commercial) or ND
  (no-derivatives) licences.
- `author`: the attribution exactly as the file page gives it. `source`: the file page URL
  (`https://commons.wikimedia.org/wiki/File:…`). `caption` (optional, up to 120 characters): what it shows,
  and when.
- Download the image (a version at least 800 px wide; JPEG, PNG or WebP; under 25 MB) to
  `data/import/photos/<key>.<ext>` and set `file` to that file name.
- Choose photos that show the event or its place. Avoid photos of identifiable private people in distress,
  and graphic images.
- **No suitable free photo? Leave `photo` out.** Better no photo than a wrong licence.

The importer re-encodes every photo (strips location data), shows it first in the story with the credit in
its caption ("Photo: author, licence"), and lists its file page as a source.

### Work in batches, and check your own work

1. Write files of 100–250 events: `events-001.jsonl`, `events-002.jsonl`, …
2. Before adding events, list keys and titles already written so you don't duplicate them:
   `grep -ho '"key": *"[^"]*"' data/import/*.jsonl | sort` (and search titles the same way).
3. After each file, run the checker and fix **every error**:
   ```bash
   npm run import:check -- data/import/*.jsonl --check-urls
   ```
   It validates every field (same rules as the site), checks that every key is unique, that links point to
   existing keys and that photo files exist with an accepted licence, and visits every link: a link that
   doesn't exist (404, unknown domain) is an **error**, almost always an invented URL; replace it with one
   you opened. Sites that block automated checks (403, timeouts) show as warnings: verify those by hand.
   Read the warnings too (possible duplicates, events without photos, and with `--check-places`, places
   whose coordinates fall outside the area OpenStreetMap knows for them). `--check-places` looks places up
   one a second (OpenStreetMap's usage policy), so a new file of 250 events takes several minutes; results
   are cached. If it says places "could not be looked up", their coordinates were **not** checked: run it
   again later. A place it can't find gets a warning: use a simpler name the map knows ("City, Country"),
   or check the coordinates by hand against the place's Wikipedia article. The last lines summarise how many events are recent, ongoing and have photos.
4. When done, report: number of events and files, how many are from 2020 on and ongoing, how many have
   photos, and any warnings you couldn't resolve.

---

## Part 2: Importing

> **Task:** load `data/import/*.jsonl` into a Hexstory database: local first, check it on the site, then
> preview and production. Never edit the database by hand; only use the commands below.

The importer refuses a database that isn't marked for the environment you name (`--env`) or that lacks
migrations (007 and 008 are needed), the same guard the API uses. It writes each story in its own
transaction and is **safe to run again**: events already imported are skipped if unchanged, updated (a new
version by the Hexstory Archive account) if their line changed, and stories that someone edited on the
site since are **left alone** unless you add `--update-edited`. It never deletes anything.

### Local

```bash
npm run migrate                                                  # applies 007/008 to the dev database
npm run import:check -- data/import/*.jsonl --check-urls --check-places
npm run import -- dry-run data/import/*.jsonl --env development   # what would happen
npm run import -- apply   data/import/*.jsonl --env development --batch 2026-11-initial
npm run dev                                                       # look at the map and some stories
```

`npm run import` reads the database (and `UPLOAD_DIR` for photos) from Doppler's `dev` config. `apply`
re-checks links (using the cache from `check`, so it's quick) and stops if any check fails, before writing
anything; add `--skip-url-check` only if you just ran `check` with `--check-urls`. Name the batch
(`--batch`): it is how you take an import down again.

What to look for on the site: dots spread where you expect them (try the timeline from 2020 on), a few
stories open with their photo, summary, sources and connections, ongoing events show their timeline, and
Explore → Developing events lists the ongoing ones.

### Preview and production

Apply migrations first (`npm run migrate:preview`, `npm run migrate:production`; see DEPLOYMENT.md §6). Then,
with the environment's database URL and, if the files have photos, its R2 settings (`STORAGE_BACKEND=r2`,
`R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_BASE_URL`) in the
environment, for example from a Doppler config:

```bash
doppler run -c prd -- npm run import:remote -- dry-run data/import/*.jsonl --env production
doppler run -c prd -- npm run import:remote -- apply   data/import/*.jsonl --env production --batch 2026-11-initial
```

Without `DATABASE_URL`/`DATABASE_URL_UNPOOLED` in the environment the importer asks for the connection
string (input hidden). The pooled or the direct Neon string both work. Do preview first.

New stories reach the map within about a minute (the map's point list is cached by the CDN).

### Taking an import down

```bash
npm run import -- remove-batch 2026-11-initial --env development
doppler run -c prd -- npm run import:remote -- remove-batch 2026-11-initial --env production
```

This hides every story of that batch (recorded in the audit log as hidden by Hexstory Archive). Moderators
can bring single stories back with Unhide. Fix the files and import again under a new batch name to
replace them; hidden stories with the same keys are updated, not duplicated, but stay hidden until unhidden.

### Sizes and costs

5,000 events take roughly 25–50 MB in Postgres (within Neon's free 0.5 GB) and, with photos, about 1–1.5 GB
in R2 (within its free 10 GB). An import of 5,000 events takes a few minutes locally and roughly 15–40
minutes against Neon, four stories at a time.

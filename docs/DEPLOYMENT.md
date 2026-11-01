# Deploying Hexstory: Vercel + Neon + Cloudflare R2 + Redis Cloud

This guide takes you from an empty Vercel account to a working production site, and covers every later
release. It complements [DESIGN.md](DESIGN.md) (how the pieces work and why). Throughout,
**`hexstory.example`** stands for your real domain: replace it everywhere.

What you will create:

| Service | What for | Where it is configured |
|---|---|---|
| Vercel project | Hosting: CDN for built assets, one Node Function for API, sign-in, chat (WebSockets) and page HTML | Vercel dashboard, `vercel.json` |
| Neon Postgres (via Vercel Marketplace) | All durable data, including chat history and sessions | Vercel → Storage, Neon console |
| Redis Cloud (via Vercel Marketplace) | Chat fan-out between Function instances, presence, chat cooldown, API rate limits | Vercel → Storage, Redis Cloud console |
| Cloudflare R2 (2 buckets) | Published images (public via your domain) and uploaded originals (private staging) | Cloudflare dashboard |
| Google OAuth client | Sign-in | Google Cloud console |

Nothing in this repository purchases plans, changes DNS, or touches production data by itself. Every step
below is something you do, in this order.

> Dashboards change their labels from time to time. Where a label below doesn't match exactly, look for the
> closest equivalent; the values to enter are what matters.

---

## 0. Before you start

1. **Put the code on GitHub** (Vercel deploys from Git). The repo is not a Git repository yet:
   ```bash
   git init && git add -A && git commit -m "Hexstory"
   gh repo create hexstory --private --source . --push     # or create the repo on github.com and push
   ```
   `.gitignore` already excludes `node_modules`, builds, `uploads/`, `.env*` and `.vercel/`.
2. **Install the Vercel CLI** (needed for migrations): `npm i -g vercel`, then `vercel login`.
3. **Decide your domains** (all on the same registrable domain is simplest):
   - `hexstory.example`: the site (`APP_ORIGIN`)
   - `images.hexstory.example`: published images (R2 custom domain)
   - optional `preview.hexstory.example`: a stable preview site with its own data and sign-in
4. **Plans.** Vercel Hobby is free but **for non-commercial use only**; if you turn on ads (or otherwise run
   the site commercially) you need Vercel Pro. The free tiers of Neon and Redis Cloud are fine for testing,
   but Redis Cloud's free database is too small for a public launch (§4, §8).

## 1. Vercel project

1. Vercel dashboard → **Add New… → Project** → **Import** your GitHub repository.
2. On the configure screen:
   - **Root Directory:** `./` (the repository root; the build needs the whole npm workspace).
   - **Framework Preset:** **Other**.
   - **Build and Output Settings:** leave them as they are. `vercel.json` sets the install command
     (`npm ci`), build command (`node scripts/vercel-build.mjs`) and output directory
     (`apps/web/dist-static`), and the dashboard shows them as overridden.
   - **Environment Variables:** skip for now (§7 lists them all).
3. Click **Deploy**. **This first build is expected to fail** with "DATABASE_URL is not set for the
   production environment". That's the build's database check, and it means the project exists. Continue
   with §2 to §5, then redeploy (§6).
4. **Settings → Build and Deployment → Node.js Version:** `24.x` (`package.json` `engines` also asks for it).
5. **Settings → Functions:**
   - **Fluid Compute:** must be **enabled** (the default for new projects; WebSockets require it).
   - **Function Region:** pick the region you will also use for Neon and Redis. The default
     **Washington, D.C., USA (iad1)** pairs with **AWS us-east-1** at Neon and Redis Cloud.
   - Function duration and included files come from `vercel.json`: `maxDuration` 300 s (the Hobby maximum).
     On Pro you may raise it to 800 in `vercel.json` so chat connections reconnect less often.
6. **Settings → Domains:** add `hexstory.example` (and `www` if you want it to redirect). Vercel shows the DNS
   records to create at your DNS provider. If the domain's DNS is on Cloudflare (needed for the R2 image
   domain, §3), add the records there and set them to **DNS only** (grey cloud), as Vercel recommends.
7. Optional, for a stable preview site: create a long-lived Git branch (e.g. `preview`). In **Settings →
   Domains**, add `preview.hexstory.example` and, in its settings, assign it to that **Git branch**.
   Deployments of other branches still get random `*.vercel.app` URLs. Those can be browsed, but sign-in,
   writing and chat refuse them, because they don't match `APP_ORIGIN`. That is on purpose.
8. **Deployment Protection** (Settings → Deployment Protection): Vercel Authentication on previews is fine
   and recommended; production must be public.

**Environment scopes.** Every variable in **Settings → Environment Variables** has scopes: *Production*,
*Preview* (optionally a specific branch) and *Development*. Changes apply only to **new** deployments:
after changing variables, go to **Deployments**, open the latest one's **⋯** menu and choose **Redeploy**.

## 2. Neon Postgres

1. Vercel dashboard → your project → **Storage → Create Database → Neon** (Marketplace). Accept the
   integration terms.
2. **Region:** the AWS region matching your Function region (iad1 → **AWS US East 1 (N. Virginia)**).
   **Plan:** Free is enough to start. Name it e.g. `hexstory`.
3. **Connect Project:** select this project.
   - **Environments:** **Production only.** Untick *Preview* and *Development*. Preview gets its own
     database below, and local development keeps using your own Postgres through Doppler.
   - **Create database branch for deployment:** leave **unchecked** for both Preview and Production. A
     per-deployment branch would be a copy of production, including its "production" marker, and the
     preview build would refuse it (DESIGN.md §4, "Environments and migrations").
   - This injects `DATABASE_URL` (pooled, through PgBouncer), `DATABASE_URL_UNPOOLED` (direct), plus `PG*`
     and `POSTGRES_*` variables we don't use, into the Production environment.
4. **Preview database (recommended).** In the Neon console (Vercel → Storage → your database → **Open in
   Neon**) → **Branches → New branch**: name `preview`, parent `main`. Choose the **schema-only** option if it
   is offered, so no production users or emails are copied. Open the branch → **Connect**: copy the
   **pooled** connection string and, with *Connection pooling* switched off, the **direct** one. In Vercel →
   Settings → Environment Variables add, scoped to **Preview** only:
   - `DATABASE_URL` = the preview branch's pooled string
   - `DATABASE_URL_UNPOOLED` = the preview branch's direct string
5. **Pool sizes.** Each Function instance opens at most 5 connections (`DB_POOL_MAX`, default 5 on Vercel)
   to Neon's PgBouncer, which accepts up to 10,000 client connections and runs in transaction mode.
   postgres.js's protocol-level prepared statements work in that mode (Neon allows 1,000 per connection).
   The app never uses session-level features through the pooler; migrations use the direct connection.
6. **Backups.** Neon keeps a restore window (point-in-time restore and branching from the past). Its length
   depends on the plan and is short on the Free plan; check Neon's pricing page. For a launch, also take
   regular logical backups:
   `pg_dump -Fc "$DATABASE_URL_UNPOOLED" > hexstory-$(date +%F).dump`, stored outside Neon.

The first migration happens in §6.

## 3. Cloudflare R2

You need a Cloudflare account, and `hexstory.example` must be a **zone in that same account** (Cloudflare
DNS). That's required for a custom domain on an R2 bucket. If your domain's DNS lives elsewhere, either
move its nameservers to Cloudflare, or add a subdomain to Cloudflare with a *partial (CNAME) setup*.

1. **Activate R2.** Cloudflare dashboard → **R2 Object Storage** → **Purchase R2 Plan / Get started**. This
   asks for a payment method even though there is a free monthly allowance (storage, Class A/B operations;
   no egress fees).
2. **Create two buckets** (R2 → **Create bucket**), both with location *Automatic* and the **Standard**
   storage class:
   - `hexstory-images`: published, processed WebP images. Public through your domain.
   - `hexstory-staging`: unvalidated originals while they are uploaded. **Never public.**

   For the preview site, create a second pair (`hexstory-preview-images`, `hexstory-preview-staging`) so
   preview uploads never mix with production.
3. **Public access for `hexstory-images` only:** bucket → **Settings → Custom Domains → Connect Domain** →
   `images.hexstory.example` → confirm. Cloudflare creates the DNS record. Leave the **r2.dev** public URL
   **disabled** (it is rate-limited and meant for development).
   Do *not* enable any public access on `hexstory-staging`.
4. **Expire abandoned originals:** `hexstory-staging` → **Settings → Object lifecycle rules → Add rule**:
   name `expire-originals`, applies to the whole bucket, *delete objects* **1 day** after upload (and abort
   incomplete multipart uploads after 1 day). The API deletes each original as soon as it is processed; this
   catches the ones a browser uploaded but never completed. Cloudflare applies expiry within about a day.
5. **CORS for direct uploads**, on `hexstory-staging` only: **Settings → CORS policy → Edit**:
   ```json
   [
     {
       "AllowedOrigins": ["https://hexstory.example"],
       "AllowedMethods": ["PUT"],
       "AllowedHeaders": ["content-type"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```
   For the preview staging bucket use `https://preview.hexstory.example`. If you develop against R2 locally
   (optional), add `http://localhost:5173` to a *development* bucket's CORS, never to production's. The
   public bucket needs no CORS (images are loaded with plain `<img>` tags).
6. **API token.** R2 overview → **Manage API tokens** (under *Account details → API Tokens*) → **Create API
   token** (*Account API token*):
   - **Permissions:** **Object Read & Write**
   - **Specify bucket(s):** apply to `hexstory-images` and `hexstory-staging` only
   - **TTL:** your choice (forever, or rotate on a schedule)

   Copy the **Access Key ID** and **Secret Access Key** (shown once) and the **S3 endpoint**
   `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (shown on the same page; buckets in the EU jurisdiction
   use `https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`). Make a separate token for the preview buckets.
7. Add to Vercel (Settings → Environment Variables; Production scope with the production values, Preview
   scope with the preview buckets and token):

   | Variable | Value |
   |---|---|
   | `R2_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
   | `R2_BUCKET` | `hexstory-images` |
   | `R2_STAGING_BUCKET` | `hexstory-staging` |
   | `R2_ACCESS_KEY_ID` | from step 6 (mark **Sensitive**) |
   | `R2_SECRET_ACCESS_KEY` | from step 6 (mark **Sensitive**) |
   | `R2_PUBLIC_BASE_URL` | `https://images.hexstory.example` |

   `STORAGE_BACKEND` defaults to `r2` on Vercel; you don't need to set it.

How uploads work (DESIGN.md §8): the browser asks the API for an upload slot. It PUTs the original
straight to the staging bucket through a 5-minute pre-signed URL that signs the exact size. Then the API
reads it back, re-encodes it with sharp and writes the WebP files to the public bucket. Originals are never
public; credentials never reach the browser.

### Moving existing local images to R2

Image keys are stored in the database, and URLs are built when a story is read. Copying the files with the
**same names** is therefore all that's needed: `<key>.webp` and `<key>-thumb.webp` at the bucket root. With
the AWS CLI and the R2 token from step 6:

```bash
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_DEFAULT_REGION=auto \
aws s3 cp ./apps/api/uploads/ s3://hexstory-images/ --recursive --exclude "*" --include "*.webp" \
  --endpoint-url https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
  --content-type image/webp --cache-control "public, max-age=31536000, immutable"
```

(`UPLOAD_DIR` defaults to `./uploads` relative to where the API ran, so locally that's `apps/api/uploads`.)
Images only matter if you also move the **database** rows that reference them. To move local data into the
production database, run `pg_dump -Fc` locally, `pg_restore --no-owner -d "$DATABASE_URL_UNPOOLED"` into an
empty Neon database, then `npm run migrate:production -- --retarget`. That re-marks the copied database
(marked `development`) as production. Most launches start empty and skip this.

## 4. Redis Cloud

1. Vercel → your project → **Storage → Create Database → Redis** (by Redis, from the Marketplace).
2. **Region:** the same AWS region as your Function and Neon (e.g. AWS us-east-1). **Plan:** the free 30 MB
   plan works for testing; see the limits below before launch. High availability is optional.
3. **Connect Project:** select this project and the **Production** environment (and Preview if you want
   previews to share it; keys and channels are prefixed per environment, so they don't collide).
4. **Check the variable name.** On the database page, open the **.env.local** / Quickstart tab. The
   connection string should be injected as `REDIS_URL` (`redis://default:<password>@<host>:<port>`, or
   `rediss://…` when TLS is enabled). If the integration uses a different name, add `REDIS_URL` yourself
   (Settings → Environment Variables, mark Sensitive) with the same value. Both `redis://` and `rediss://`
   work.
5. **TLS:** TLS can be enabled on paid plans (Redis Cloud console → database → *Security*). Then the URL
   starts with `rediss://`. Traffic otherwise travels over the provider's network unencrypted, so turn TLS on
   for a public launch.
6. **Eviction policy:** leave the default (*no eviction*). Every key the app writes expires on its own:
   presence entries after 60 s, cooldowns after 2 s, rate-limit windows after 1 min or 1 h.

What the app needs from Redis is plain RESP over TCP with **Pub/Sub** (Redis Cloud supports it; a
REST-only Redis API would not work). Each Function instance holds **2 connections**: commands and a
subscriber.

| Free plan limit (Redis Cloud Essentials 30 MB) | What it means here |
|---|---|
| 30 concurrent connections | At most ~15 Function instances can be connected at once |
| 100 operations/second | Roughly one op per API request (rate limit), plus chat and presence |
| 5 GB/month bandwidth | Chat fan-out to every instance |

The next tier (250 MB) allows 256 connections and 1,000 ops/s. If Redis is unreachable or throttled, the
site keeps working, degraded: API rate limits are skipped (daily limits in Postgres still apply), chat
posting returns "The Square is having trouble right now", and history still loads.

## 5. Google sign-in

In the Google Cloud console (the project you used for development, or a new one for production):

1. **Google Auth Platform → Branding** (older consoles: *APIs & Services → OAuth consent screen*):
   app name **Hexstory**, support email, and **Authorized domains:** `hexstory.example`. Set the app home page
   `https://hexstory.example`, privacy policy `https://hexstory.example/privacy` and terms of service
   `https://hexstory.example/terms`. Fill in the legal placeholders first (§9).
2. **Audience:** user type **External**. While the status is **Testing**, only listed test users (max 100)
   can sign in. Click **Publish app** to switch to **In production** so anyone with a Google account can.
   Hexstory only asks for `openid`, `email` and `profile`, which are non-sensitive scopes, so no Google
   security review is needed. Google may still verify your branding before showing the app name and logo.
3. **Data Access** (scopes): `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`.
4. **Clients → Create client** → *Web application*, name `Hexstory production`:
   - **Authorized redirect URIs:** exactly `https://hexstory.example/auth/google/callback`
   - Authorized JavaScript origins: not needed (sign-in is a server-side redirect flow).
   - Copy the **Client ID** and **Client secret**.
5. For the preview site, create a second client `Hexstory preview` with redirect URI
   `https://preview.hexstory.example/auth/google/callback`. Google doesn't accept wildcard redirect URIs,
   which is why preview sign-in works only on the stable preview domain.
6. Vercel → Settings → Environment Variables:

   | Variable | Production | Preview |
   |---|---|---|
   | `APP_ORIGIN` | `https://hexstory.example` | `https://preview.hexstory.example` |
   | `GOOGLE_CLIENT_ID` | production client | preview client |
   | `GOOGLE_CLIENT_SECRET` | production secret (Sensitive) | preview secret (Sensitive) |
   | `ADMIN_EMAILS` | e.g. `you@example.com` | same or different |

`APP_ORIGIN` must be exactly the origin people use (scheme + host, no trailing slash). It drives the OAuth
redirect URI, the CSRF check on every write and the WebSocket origin check. Leave `GOOGLE_*` unset to run a
read-only site.

## 6. First deploy, and every release after it

Migrations never run during a build or when the app starts. You apply them yourself with an explicit
command, **before** deploying code that needs them. The build and the app both *check* (read-only) that
the target database is up to date and belongs to their environment, and stop if not.

### First production deploy

1. Link your checkout to the project once: `vercel link`.
2. Create the schema in production and mark the database as `production`:
   ```bash
   npm run migrate:production
   ```
   This runs `vercel env run -e production -- npm run migrate -w @hexstory/api -- --env production`,
   which uses `DATABASE_URL_UNPOOLED` from Vercel's Production environment. It prints the host it is
   migrating, and refuses pooled URLs or a database marked for another environment.
   If `vercel env run` can't read the variable (variables marked *Sensitive* can't be read back), copy the
   direct connection string from the Neon console and run:
   ```bash
   DATABASE_URL_UNPOOLED='postgres://…direct…' npm run migrate -w @hexstory/api -- --env production
   ```
   Or keep it in a Doppler config (e.g. `prd`):
   `doppler run -c prd -- npm run migrate -w @hexstory/api -- --env production`.
3. Same for the preview database: `npm run migrate:preview` (or the equivalent with the preview branch's
   direct string and `--env preview`).
4. Vercel → **Deployments** → latest → **⋯ → Redeploy**. The build log ends with
   `[migrate] <host>/<db> is up to date for "production"`.
5. Work through the smoke test (§9).

### Releasing changes

1. **No schema change:** push or merge to your production branch. Vercel builds and promotes automatically.
2. **With a schema change** (a new `apps/api/migrations/NNN_*.sql`):
   1. Write the migration to be **backward compatible**, because the old deployment keeps serving until the
      new one is promoted. Add columns and tables first; drop or rename only in a later release, after no
      deployed code uses them.
   2. `npm run migrate:preview`, push to the preview branch, and test.
   3. `npm run migrate:production`.
   4. Merge to production. If you deploy before step 3, the build stops at the database check, with
      "migrations not yet applied: …", and production keeps running the previous deployment.
3. **If a migration fails:** that file's transaction is rolled back, and files before it stay applied. Fix
   it by adding a *new* migration (never edit an applied one) and run the command again. A
   `lock_timeout` of 15 s stops a migration from waiting forever behind live traffic; just retry.
4. **Concurrent runs:** a second `migrate` while one is running fails immediately with "Another migration is
   running". If a run is killed, its lock disappears with its connection.
5. **Rolling back code:** Vercel → Deployments → previous production deployment → **Instant Rollback**. This
   is safe as long as migrations stayed backward compatible.
6. **Emergency override:** `SKIP_DB_CHECK=1` as a build environment variable skips the build-time check. The
   app's startup check still runs. Use it only if the check itself is broken.

### Optional: Doppler as the source of production secrets

Local development is unchanged (`doppler run --` with config `dev`). If you also want Doppler to hold
production secrets, create configs `prd` and `stg` and use Doppler's **Vercel integration** (Doppler →
Integrations → Vercel) to sync them into Vercel's Production and Preview environments. Sync only the
variables you own: `APP_ORIGIN`, `GOOGLE_*`, `ADMIN_EMAILS` and `R2_*`. Let the Neon and Redis integrations
keep managing `DATABASE_URL*` and `REDIS_URL`, so the two don't overwrite each other.

## 7. Environment variable reference

"Set by" says who provides the value in a Vercel deployment. Locally everything comes from Doppler (`dev`).
Nothing here is ever exposed to the browser: the only browser-visible configuration is the `VITE_*` build
flags, which contain no secrets.

| Variable | Status | Set by (Vercel) | Secret | Meaning |
|---|---|---|---|---|
| `DATABASE_URL` | existing | Neon integration (Production); you (Preview) | **yes** | App connection string; on Neon the **pooled** one |
| `DATABASE_URL_UNPOOLED` | new | Neon integration (Production); you (Preview) | **yes** | Direct connection, used only by `migrate` |
| `APP_ORIGIN` | existing | you | no | Canonical public origin, e.g. `https://hexstory.example` |
| `GOOGLE_CLIENT_ID` | existing | you | no (public in the OAuth redirect) | Google OAuth client |
| `GOOGLE_CLIENT_SECRET` | existing | you | **yes** | Google OAuth client secret |
| `ADMIN_EMAILS` | existing | you | no (but private) | Comma-separated emails that become Moderators at sign-in |
| `REDIS_URL` | new | Redis integration (check the name, §4) | **yes** | `redis://` or `rediss://` URL. Required on Vercel; optional locally |
| `STORAGE_BACKEND` | new | defaults to `r2` on Vercel | no | `local` (default locally) or `r2` |
| `R2_ENDPOINT` | new | you | no | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `R2_BUCKET` | new | you | no | Public bucket for processed images |
| `R2_STAGING_BUCKET` | new | you | no | Private bucket for uploaded originals |
| `R2_ACCESS_KEY_ID` | new | you | **yes** | Bucket-scoped R2 token |
| `R2_SECRET_ACCESS_KEY` | new | you | **yes** | Bucket-scoped R2 token |
| `R2_PUBLIC_BASE_URL` | new | you | no | `https://images.hexstory.example` (custom domain of `R2_BUCKET`) |
| `DB_POOL_MAX` | new | optional | no | Connections per instance (default 5 on Vercel, 10 locally) |
| `TRUST_PROXY` | existing | defaults to `true` on Vercel | no | Trust `X-Forwarded-For` (Vercel overwrites it with the client IP) |
| `NODE_ENV` | existing | defaults to `production` on Vercel | no | |
| `SKIP_DB_CHECK` | new | only in emergencies | no | `1` skips the build-time database check |
| `VERCEL`, `VERCEL_ENV` | read | **Vercel system variables** | no | `VERCEL_ENV` = `production`/`preview` chooses which database marker is accepted |
| `PORT`, `UPLOAD_DIR` | existing | not used on Vercel | no | Local server only |
| `VITE_MAP_STYLE_URL`, `VITE_FEATURE_ADS` | existing | you, if needed | no (public, build-time) | Baked into the browser bundle |
| `PG*`, `POSTGRES_*` | injected, unused | Neon integration | yes | Ignore |

Never put a secret in a `VITE_*` variable: those are compiled into public JavaScript.

## 8. Limits, costs and caveats

- **Vercel Functions:** request and response bodies are capped at **4.5 MB**, which is why images upload
  directly to R2. Max duration is 300 s on Hobby, 800 s on Pro, and the default is 300 s. Billing on Fluid
  compute is Active CPU + provisioned memory + invocations.
- **WebSockets on Vercel** (generally available since 2026-10-20): a connection stays on one instance, and
  new connections may land on another. It closes when the Function reaches `maxDuration`, so an open Square
  silently reconnects every 5 minutes on Hobby and refetches its history. **An open connection keeps its
  instance's memory billable while it is open**, even when idle (no CPU is charged while idle). The page only
  connects while a Square tab is open, and many connections share one instance. Still, watch *Usage* after
  launch. After a deployment, existing connections stay on the old deployment until they close.
- **Neon Free:** limited compute hours and storage, and the database scales to zero when idle, so the first
  request after a pause takes a little longer. The restore window is short.
- **Redis Cloud Free:** 30 MB, 30 connections, 100 ops/s, 5 GB/month. That's test-sized; plan on the paid
  tier for launch (§4).
- **R2:** free allowance per month (storage plus Class A/B operations), then pay-as-you-go; no egress fees.
  Each upload costs a few Class A operations (PUT original, 2× PUT processed, DELETE) and a Class B (GET).
- **Hobby is non-commercial.** Ads or other commercial use need Vercel Pro.
- **Previews on random URLs** are read-only by design (origin checks). Use the stable preview domain to test
  sign-in, writing and chat.
- **Delivery guarantees for chat** are in DESIGN.md §7 (Postgres is authoritative; Redis relays at most once;
  clients reconcile on reconnect).

### What was verified locally, and what only a real deployment can confirm

Verified in this repository (see the test suites and the changelog):

- `vercel build` (Vercel CLI 65.9) produces one Node 24 Function with sharp's Linux binaries, the bundled API,
  `index.html` and the migrations, plus a static output without `index.html`.
- The built Function, run locally under Node, with Redis unreachable: pages, API, sign-in redirect, 404s for
  missing files and API paths, CSRF rejection, CSP containing the R2 origins, WebSocket connect + join, and
  polling refused.
- Two app instances sharing Postgres and Redis (ioredis-mock) in the test suite: cross-instance chat and
  moderator removal, presence across instances with expiry of a vanished instance, a shared chat cooldown
  and upload rate limit, resync after a Redis reconnect, and honest acks when Redis fails.
- Direct uploads with the local backend (same API flow as R2) in a browser; R2 request signing with a fake
  transport.
- Chat recovery in a browser across a server restart: a message posted meanwhile appears once, and a message
  hidden meanwhile disappears.

Not verifiable without the real services, so check them in the smoke test:

- Vercel passing the original path to the Function through the rewrite, and WebSocket upgrades through it.
  This is Vercel's documented pattern, but it hasn't been exercised on Vercel here.
- R2 enforcing the signed `content-length` (the API re-checks the size either way), and the CORS preflight.
- Redis Cloud's injected variable name, its TLS, and real reconnect behaviour.
- Google sign-in on the production domain.

## 9. Smoke-test checklist (after each first deploy of an environment)

Use two different browsers (or one normal and one private window) signed in as two different Google accounts.

- [ ] **Navigation:** open `/`, click a hex, open a story; **refresh** on `/h/<cell>` and `/s/<id>`. The page
      loads, not a 404. `/assets/does-not-exist.js` gives a 404, not the app.
- [ ] **Headers:** DevTools → Network → the document → `content-security-policy` includes
      `https://images.hexstory.example` in `img-src` and the R2 endpoint in `connect-src`.
- [ ] **Sign-in/out:** "Sign in with Google" returns you to the same page, signed in. The Welcome dialog
      appears once. Sign out, and you're signed out after a refresh.
- [ ] **Stories:** create a story with a link and a photo; edit it; check Versions.
- [ ] **Images:** while adding a photo, Network shows `POST /api/uploads` → `PUT https://<account>.r2.cloudflarestorage.com/...` (200)
      → `POST /api/uploads/<id>/complete` (201). The image loads from `images.hexstory.example`. In R2, the
      staging bucket is empty again and the images bucket holds `<id>.webp` and `<id>-thumb.webp`.
- [ ] **Chat:** both browsers open the same hex → The Square. Each says "2 people here now". A message from
      one appears in the other within a second.
- [ ] **Reconnection:** in one browser, DevTools → Network → *Offline* for ~10 s. Post from the other browser
      meanwhile, then go back *Online*. The missed message appears once.
- [ ] **Moderation:** with a Reviewer/Moderator account (`ADMIN_EMAILS`), hide a message. It disappears in
      the other browser.
- [ ] **Rate limits:** send two chat messages within 2 s: "Slow down a little." Request 21 upload slots
      within an hour (or temporarily lower `POLICY.uploadsPerHour`) to get HTTP 429.
- [ ] **Persistence:** redeploy (Deployments → Redeploy). Stories, images, chat history and your session
      survive.
- [ ] **Previews:** a preview deployment's build log shows `up to date for "preview"`, and data written there
      doesn't appear in production.
- [ ] **Logs:** Vercel → Logs show no `[startup]` errors (Redis or database).

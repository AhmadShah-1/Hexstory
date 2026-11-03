# Deploying Hexstory: Vercel + Neon + Cloudflare R2 (+ optional Redis Cloud)

This guide takes you from an empty Vercel account to a working production site, and covers every later
release. It complements [DESIGN.md](DESIGN.md) (how the pieces work and why). Throughout,
**`hexstory.example`** stands for your real domain: replace it everywhere.

What you will create:

| Service | What for | Where it is configured |
|---|---|---|
| Vercel project | Hosting: CDN for built assets and cacheable public API responses (map points, home page), one Node Function for API, sign-in and page HTML | Vercel dashboard, `vercel.json` |
| Neon Postgres (via Vercel Marketplace) | All durable data, including sessions | Vercel → Storage, Neon console |
| Redis Cloud (via Vercel Marketplace), **optional** | API rate limits, cooldowns and small caches shared between Function instances | Vercel → Storage, Redis Cloud console |
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
   the site commercially) you need Vercel Pro. The free tiers of Neon, R2 and (if you use it) Redis Cloud
   are enough to launch and grow for a while: there is no live chat or WebSocket any more, the map and home
   page are served from the CDN cache, and Redis holds only rate-limit counters and small caches (§4, §8).

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
   - **Fluid Compute:** leave it **enabled** (the default for new projects; instances serve many requests).
   - **Function Region:** pick the region you will also use for Neon (and Redis). The default
     **Washington, D.C., USA (iad1)** pairs with **AWS us-east-1** at Neon and Redis Cloud.
   - Function duration and included files come from `vercel.json`: `maxDuration` 60 s. No request needs
     more (the slowest is processing a photo); a low cap limits what a stuck request can cost.
6. **Settings → Domains:** add `hexstory.example` (and `www` if you want it to redirect). Vercel shows the DNS
   records to create at your DNS provider. If the domain's DNS is on Cloudflare (needed for the R2 image
   domain, §3), add the records there and set them to **DNS only** (grey cloud), as Vercel recommends.
7. Optional, for a stable preview site: create a long-lived Git branch (e.g. `preview`). In **Settings →
   Domains**, add `preview.hexstory.example` and, in its settings, assign it to that **Git branch**.
   Deployments of other branches still get random `*.vercel.app` URLs. Those can be browsed, but sign-in
   and writing refuse them, because they don't match `APP_ORIGIN`. That is on purpose.
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

## 4. Redis Cloud (optional)

Redis lets every Function instance share API rate limits (300 requests/min per address, 20 upload slots
an hour), cooldowns and small caches (place-search results, resource-usage readings). **Without it the site
works the same**, but each instance keeps its own counters and caches, so limits are per instance (daily
limits always live in Postgres and still apply). For a small site that is fine and saves a service; add Redis
when traffic grows or abuse appears.

1. Vercel → your project → **Storage → Create Database → Redis** (by Redis, from the Marketplace).
2. **Region:** the same AWS region as your Function and Neon (e.g. AWS us-east-1). **Plan:** the free 30 MB
   plan is plenty for this use. High availability is optional.
3. **Connect Project:** select this project and the **Production** environment (and Preview if you want
   previews to share it; keys are prefixed per environment, so they don't collide).
4. **Check the variable name.** On the database page, open the **.env.local** / Quickstart tab. The
   connection string should be injected as `REDIS_URL` (`redis://default:<password>@<host>:<port>`, or
   `rediss://…` when TLS is enabled). If the integration uses a different name, add `REDIS_URL` yourself
   (Settings → Environment Variables, mark Sensitive) with the same value. Both `redis://` and `rediss://`
   work.
5. **TLS:** TLS can be enabled on paid plans (Redis Cloud console → database → *Security*). Then the URL
   starts with `rediss://`. Traffic otherwise travels over the provider's network unencrypted.
6. **Eviction policy:** leave the default (*no eviction*). Every key the app writes expires on its own:
   rate-limit windows after 1 min or 1 h, caches after at most a day.

What the app needs from Redis is plain RESP over TCP (Redis Cloud supports it; a REST-only Redis API would
not work). Each Function instance holds **1 connection**.

| Free plan limit (Redis Cloud Essentials 30 MB) | What it means here |
|---|---|
| 30 concurrent connections | Up to ~30 Function instances connected at once |
| 100 operations/second | Roughly one op per API request that reaches the Function (rate limit); CDN-cached requests cost none |
| 5 GB/month bandwidth | Small counters and cached JSON only |

If Redis is unreachable or throttled, the site keeps working: API rate limits are skipped (daily limits in
Postgres still apply) and caches are recomputed.

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
redirect URI and the CSRF check on every write. Leave `GOOGLE_*` unset to run a
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
   It asks for the **direct** (unpooled) connection string: Neon console → your project → **Connect** →
   turn **Connection pooling off** → copy (its host has no `-pooler`). The input is hidden and the string is
   only handed to the migrate process (never printed, saved or kept in shell history). If
   `DATABASE_URL_UNPOOLED` is already set in your shell, it uses that instead, e.g. from a Doppler config:
   `doppler run -c prd -- npm run migrate:production`. It prints the host it is migrating, and refuses pooled
   URLs or a database marked for another environment.
   (It doesn't use `vercel env run`: that can't read variables marked *Sensitive*, and Vercel CLI 65.9.0
   misread `vercel env run -e production -- node <file>` as a deploy of `<file>`.)
3. Same for the preview database: `npm run migrate:preview` (or the equivalent with the preview branch's
   direct string and `--env preview`).
4. Vercel → **Deployments** → latest → **⋯ → Redeploy**. The build log ends with
   `[migrate] <host>/<db> is up to date for "production"`.
5. Work through the smoke test (§9).

### Importing events in bulk

To fill a new site with events, see [IMPORT.md](IMPORT.md). Import into preview first, then production,
after the migrations are applied; photos need the environment's R2 variables (e.g. from its Doppler
config).

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

<a id="support-links"></a>

## Support page (Stripe and PayPal links)

The public `/support` page (footer link **Support**) offers voluntary contributions through two
provider-hosted pages: a **Stripe Payment Link** ("Support with card") and a **PayPal.Me** link
("Support with PayPal"). Hexstory itself has no payment SDK, API keys, webhooks, payment records or
supporter badges, never collects payment details, and never treats a return URL as proof of payment.
Contributions buy nothing: no features, access, moderation privileges or preferential treatment. Don't
describe them as charitable or tax-deductible donations.

Each option appears only when its variable holds a valid link; with neither set the page says
contributions aren't available right now.

### Stripe Payment Link ("Customers choose what to pay")

Sources: [Create a payment link](https://docs.stripe.com/payment-links/create),
[After a payment link payment](https://docs.stripe.com/payment-links/post-payment),
[Customize checkout for Payment Links](https://docs.stripe.com/payment-links/customize) (checked 2026-11-01).

1. **Account and eligibility first.** During Stripe onboarding, describe Hexstory's activity accurately
   (a free, community-written history map funded by voluntary contributions) and confirm with Stripe the
   correct classification for this kind of payment. Stripe accepts tips only for something you already
   provide and donations only toward a defined goal you commit to, with country-specific restrictions:
   read [Requirements for accepting tips or donations](https://support.stripe.com/questions/requirements-for-accepting-tips-or-donations).
   Renaming "donations" to "contributions" or "support" does not by itself establish eligibility.
2. Stripe Dashboard → **Payment Links** → **New** (or **+** → **Payment link**).
3. Select **Customers choose what to pay**; add a title (e.g. "Support Hexstory"), a short description
   that matches the Support page wording ("Voluntary contribution toward hosting, storage and
   development. Does not unlock features or privileges."), and optionally an image.
4. Optional: a **suggested (preset) amount**, and **minimum / maximum** amounts (the default maximum is
   10,000.00 USD). This pricing model has no recurring payments, which is what we want: no subscriptions.
5. Quantity: a customer-chosen-amount link always has quantity 1; don't add other line items, and don't
   enable **Let customers adjust quantity**.
6. **After the payment** → keep **Confirmation page** (optionally with a custom thank-you message). Don't
   redirect back to Hexstory: the site has nothing to show there and must never treat a redirect as proof
   of payment.
7. Leave optional fields (addresses, phone, custom fields) off: collect nothing you don't need.
8. **Create link** and copy it. Stripe-hosted Payment Links are `https://buy.stripe.com/<id>`, the only
   host Hexstory accepts (Stripe's optional custom domains such as `pay.example.com` are rejected by the
   allowlist on purpose). A link created in **test mode / a sandbox**
   (`https://buy.stripe.com/test_…`) also passes validation, so you can try the whole flow with Stripe's
   test cards on Preview before switching to the live link.

Cards are paid on Stripe's checkout page; payers don't need a Stripe account. Apple Pay and Google Pay
appear only if enabled in your [payment method settings](https://dashboard.stripe.com/settings/payment_methods)
and supported by the payer's device and browser, so the page only says they *may* be offered.

### PayPal.Me link

Sources: [What is PayPal.Me?](https://www.paypal.com/cshelp/article/HELP432),
[PayPal.Me FAQ](https://www.paypal.com/us/selfhelp/article/what-is-paypal.me-faq3025) (checked 2026-11-01).

PayPal.Me links are created on PayPal.Me while signed in to PayPal, and are shown afterwards in the
**Profile** section of your PayPal **Account settings**. One link per account; the name can't be changed
later; business accounts can only accept Goods and Services payments. Hexstory's link is
**`https://www.paypal.com/paypalme/hexstory`**. Accepted forms: `https://www.paypal.com/paypalme/<name>`
and `https://paypal.me/<name>` (an amount suffix such as `/5` is allowed).

### Hosting terms

Vercel's Hobby plan is for non-commercial use, but its
[fair use guidelines](https://vercel.com/docs/limits/fair-use-guidelines#commercial-usage) state that
asking for donations does not count as commercial usage. That holds only while contributions buy no
product, service, feature or benefit, which is why the Support page says so explicitly.

### Configuring the links

| Variable | Example | Secret |
|---|---|---|
| `STRIPE_SUPPORT_URL` | `https://buy.stripe.com/<id>` | no (public link) |
| `PAYPAL_SUPPORT_URL` | `https://www.paypal.com/paypalme/hexstory` | no (public link) |

- **Locally:** `doppler secrets set STRIPE_SUPPORT_URL` and `doppler secrets set PAYPAL_SUPPORT_URL`
  (config `dev`), then restart `npm run dev`.
- **Vercel:** Project → Settings → Environment Variables, for **Production** and (with test-mode links if
  you like) **Preview**. They are not sensitive, so they don't need the "Sensitive" flag.
- The API reads them at startup and serves them from `GET /api/support`; the frontend needs no rebuild.
  On Vercel, environment variable changes apply **only to new deployments: redeploy** (Deployments → ⋯ →
  **Redeploy**) after changing them.
- Validation (`packages/shared/src/support.ts`): `https://` only, no username/password, no port, and an
  exact hostname (`buy.stripe.com`; `www.paypal.com` with a `/paypalme/<name>` path, or `paypal.me`).
  An invalid value never stops the site: that option is hidden and the startup log says
  `STRIPE_SUPPORT_URL ignored: <reason>` (the URL itself is not logged). Check `GET /api/support` after
  deploying: it returns `{ "stripe": "…" | null, "paypal": "…" | null }`.

<a id="resource-usage"></a>

## Resource usage dashboard

Moderators see hosting usage under **Moderation → Resource usage** (`/moderation?tab=usage`). Only
Moderators (`ADMIN_EMAILS`) can open it; Reviewers get "not allowed". The browser never talks to a
provider: the API reads each provider itself, with its own short timeout (4 s). Readings are shared
between Function instances through Redis and reused for 15 minutes (`USAGE_CACHE_SECONDS`). **Refresh**
re-reads everything, at most once a minute for the whole site. Nothing polls in the background, so
nothing wakes Neon on a timer: providers are only asked when a Moderator opens the tab or presses
Refresh. When a reading fails, the last good value stays on screen, marked *Stale (updated … ago)*.
Error messages are fixed texts; provider responses, tokens and connection strings never reach the
browser. The dashboard only reads: it never changes provider settings or plans.

Every number shows its scope (database, project, bucket or whole account), whether it is **Now** (in use
at the moment) or **This period** (adds up until it resets, with the period and reset date when known),
when it was measured, where it came from (*measured by the app* with our own query, or *provider data*
from the provider's API), and whether it is approximate. A percentage and bar appear only when a limit is
known, finite, above zero and in the same unit. **Limits are never assumed**: they come from a provider
API where one reports them, otherwise from the optional `USAGE_LIMIT_*` variables below; without one,
the dashboard shows the usage alone. Missing data is shown as *Unavailable*, *Not configured* or
*Couldn't read*, never as 0. Each limit is labelled **hard limit** (the service stops, throttles or
pauses) or **included** (an allowance; use beyond it is billed).

### What works on our plans

Checked against the providers' documentation on 2026-11-01.

| Provider | Metric | Works with | Kind / scope | Notes |
|---|---|---|---|---|
| Neon | Database size | nothing extra (`pg_database_size()` over our own connection) | Now / this database | Exact for this database. Not compared with Neon's limit, which covers every branch of the project. |
| Neon | Project storage (all branches) | optional Neon API key | Now / project | Sum of each branch's `logical_size` (`GET /projects/{id}/branches`), which is what the Free plan's storage cap counts.[^neon-calc] |
| Neon | Compute (CU-hours) | optional Neon API key | This period / project | `compute_time_seconds` ÷ 3600 from `GET /projects/{id}`; period and reset from `consumption_period_start`/`_end`. |
| Neon | Network transfer | optional Neon API key | This period / project | `data_transfer_bytes` (public and private combined; the Free allowance counts public transfer only). |
| Redis Cloud | Memory, connections, ops/s | nothing extra (`INFO` over the app's existing Redis connection) | Now / database | Live values. Redis Cloud answers `INFO` through its proxy and doesn't document every field[^redis-compat], so they're marked approximate. |
| Redis Cloud | Evicted keys | nothing extra | Since Redis last restarted / database | Stays 0 with the default *no eviction* policy (writes fail instead when memory is full). |
| Cloudflare R2 | Size and objects of `R2_BUCKET` and `R2_STAGING_BUCKET`; all buckets together | optional Cloudflare token | Now / bucket, account | Cloudflare's own storage samples (`r2StorageAdaptiveGroups`), no object listing.[^r2-metrics] |
| Cloudflare R2 | Storage this month (GB-month) | optional Cloudflare token | This period / account | Estimate: average of each day's peak ÷ 30, as R2 bills it.[^r2-pricing] |
| Cloudflare R2 | Class A and Class B operations | optional Cloudflare token | This period / account | `r2OperationsAdaptiveGroups` by action type, classified as on R2's pricing page; requests refused at authentication (401/403) aren't billed and aren't counted. |
| Vercel | Data transfer, invocations, Active CPU, provisioned memory | **dashboard only** | | See below. |

Neon's consumption endpoints (`/consumption_history/…`) need a paid plan[^neon-consumption]. The project and
branch endpoints used here work on Free. The Redis Cloud REST API isn't used: only an account Owner can
enable it, it needs an account key plus a user key, and it documents no connection, throughput or
eviction figures for Essentials databases[^redis-api]. `INFO` over the connection we already hold gives all
four figures.

**Vercel is dashboard-only.** Vercel documents a billing API (`GET /v1/billing/charges`)[^vercel-billing], but
every Vercel access token can both read and write. A token able to read the team's billing could also
change deployments and environment variables[^vercel-tokens], which is far too much power for a
dashboard. The page links to the Vercel dashboard instead (**Usage** in the sidebar). On Hobby, going
over a limit pauses the project until 30 days have passed[^vercel-plans]; it isn't billed.

**Quota scopes.** Neon's limits are per project. R2's free allowance is per Cloudflare account, so it
includes the preview buckets (the "all buckets" and monthly figures are account-wide, while per-bucket
sizes are only shown). Redis Cloud's limits are per database. Vercel's are per team/account.

**Delays and approximations.**
- Neon updates usage about every 15 minutes, and it can take up to an hour to appear. Its API notes
  that these figures aren't meant for billing[^neon-limits].
- Cloudflare doesn't document a delay. Its adaptive datasets are sampled at high volume[^cf-sampling], so
  operation counts are estimates. Queries are limited to 31 days. "This month" is the calendar month in
  UTC; Cloudflare doesn't say whether its monthly allowance uses the same boundaries.
- Redis `INFO` is live. `used_memory` includes Redis's own overhead, while the plan limit counts the
  dataset.
- The dashboard adds up to `USAGE_CACHE_SECONDS` (15 minutes by default) on top of these delays.

[^neon-calc]: https://neon.com/docs/introduction/usage-calculations
[^neon-consumption]: https://neon.com/docs/reference/api/consumption
[^neon-limits]: https://neon.com/docs/guides/consumption-limits
[^redis-compat]: https://redis.io/docs/latest/operate/rs/references/compatibility/commands/server/
[^redis-api]: https://redis.io/docs/latest/operate/rc/api/get-started/
[^r2-metrics]: https://developers.cloudflare.com/r2/platform/metrics-analytics/
[^r2-pricing]: https://developers.cloudflare.com/r2/pricing/
[^cf-sampling]: https://developers.cloudflare.com/analytics/graphql-api/sampling/
[^vercel-billing]: https://vercel.com/docs/rest-api/billing/list-focus-billing-charges
[^vercel-tokens]: https://vercel.com/docs/accounts/access-tokens
[^vercel-plans]: https://vercel.com/docs/plans/hobby

### Optional monitoring credentials

Both credentials are separate from the app's own (the R2 S3 token and the database URL are never reused
for this). Both are secrets: add them in Vercel → Settings → Environment Variables, scoped to
**Production** (and Preview if you want the dashboard there), marked **Sensitive**, or sync them from
Doppler `prd`. Locally, run `doppler secrets set NAME`. Never write them to a file. Like every variable,
they take effect on the **next deployment** (Deployments → ⋯ → Redeploy).

**Cloudflare (R2 storage and operations)**, read-only:
1. Cloudflare dashboard → **My Profile → API Tokens → Create Token → Create Custom Token**.
2. Name `hexstory-usage-read`. Under **Permissions**, choose **Account** → **Account Analytics** →
   **Read**, and nothing else. This is the only permission Cloudflare documents for account analytics
   queries[^cf-token]. It reads all analytics of that account, and can't change anything.
3. **Account Resources:** *Include* → only the account that holds the R2 buckets. Optional: Client IP
   address filtering. Set a TTL if you rotate tokens.
4. **Continue to summary → Create Token**, and copy it (it is shown once).
5. Set `USAGE_CLOUDFLARE_API_TOKEN` to it. The account ID is taken from `R2_ENDPOINT`
   (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`); set `USAGE_CLOUDFLARE_ACCOUNT_ID` only if your
   endpoint is different.

[^cf-token]: https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/

**Neon (project storage, compute, transfer)**, optional, and a trade-off:
Neon has **no read-only API key**. The narrowest is a *project-scoped* key, which can read and modify
that one project (but not delete it or manage access)[^neon-keys]. The database size works without it. Add
the key only if you accept that trade-off.
1. Vercel → Storage → your database → **Open in Neon**. With the Vercel-managed integration the
   organization is managed by Vercel; the Neon docs say the Console works as usual and that the CLI
   needs an API key there[^neon-vercel]. They don't say explicitly whether these organizations can create
   keys. If **API keys** isn't offered in the next step, leave these variables unset.
2. Neon Console → organization **Settings → API keys → Create new**. Choose **Project-scoped**, select
   the production project, name it `hexstory-usage-read`, and copy the key (shown once). Only
   organization Admins can create project-scoped keys.
3. Copy the **Project ID** (Project settings → General, e.g. `calm-sky-123456`).
4. Set `USAGE_NEON_API_KEY` and `USAGE_NEON_PROJECT_ID`. Use the same project ID for Preview: the preview
   database is a branch of the same project.

[^neon-keys]: https://neon.com/docs/manage/api-keys
[^neon-vercel]: https://neon.com/docs/guides/vercel-managed-integration

**Redis Cloud** needs nothing extra: the dashboard sends one `INFO` over the existing command connection,
with no `SCAN` or `KEYS`.

### Limits and thresholds (optional, not secret)

Set these from your **current** plan pages. The dashboard never assumes them. The figures in brackets
were published on 2026-11-01, are given for orientation only, and change, so check before using them.
GB and MB mean 10⁹ and 10⁶ bytes here. Providers don't say whether they mean decimal or binary units;
decimal is the smaller reading, so warnings come slightly early.

| Variable | Meaning | Kind shown | For orientation |
|---|---|---|---|
| `USAGE_LIMIT_NEON_STORAGE_GB` | Neon storage per project (logical size) | hard on Free, included if `USAGE_NEON_PLAN=paid` | Free: Neon's plans page[^neon-plans] (one older FAQ page states a different figure) |
| `USAGE_LIMIT_NEON_COMPUTE_CU_HOURS` | CU-hours per project per month | same | Free: 100 |
| `USAGE_LIMIT_NEON_TRANSFER_GB` | Network transfer per project per month | same | Free: 5 |
| `USAGE_NEON_PLAN` | `free` (default) or `paid`: whether the Neon limits above are hard or billed | | |
| `USAGE_LIMIT_REDIS_MEMORY_MB` | Database memory (else `INFO maxmemory` if Redis reports one) | hard | Essentials free: 30[^redis-plans] |
| `USAGE_LIMIT_REDIS_CONNECTIONS` | Concurrent connections | hard | Essentials free: 30 |
| `USAGE_LIMIT_REDIS_OPS_PER_SEC` | Operations per second | hard (throttled) | Essentials free: 100 |
| `USAGE_LIMIT_R2_STORAGE_GB_MONTH` | R2 storage allowance per month (account) | included | 10[^r2-pricing] |
| `USAGE_LIMIT_R2_CLASS_A_MONTH` | Class A operations per month (account) | included | 1000000 |
| `USAGE_LIMIT_R2_CLASS_B_MONTH` | Class B operations per month (account) | included | 10000000 |
| `USAGE_WARN_PERCENT`, `USAGE_CRITICAL_PERCENT` | Amber and red bar thresholds | | default 75 and 90 |
| `USAGE_CACHE_SECONDS` | How long readings are reused (60–86400) | | default 900 |

An invalid value never stops the site. It is ignored and listed at the top of the dashboard.
Neon's API can also report a project *quota* that you set yourself in Neon. When one is set, it is
shown as a hard limit and takes precedence over `USAGE_LIMIT_NEON_COMPUTE_CU_HOURS` and
`USAGE_LIMIT_NEON_TRANSFER_GB`.

[^neon-plans]: https://neon.com/docs/introduction/plans
[^redis-plans]: https://redis.io/docs/latest/operate/rc/subscriptions/view-essentials-subscription/essentials-plan-details/

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
| `ADMIN_EMAILS` | existing | you | no (but private) | Comma-separated emails of Moderators (granted at sign-in; removal applies on their next request) |
| `GEOCODER_URL` | new | optional | no | Place search geocoder (Photon). Default `https://photon.komoot.io`, komoot's free public instance (fair use, no key, no guarantee). Point it at your own Photon if traffic grows. Redeploy after changing |
| `REDIS_URL` | new | Redis integration (check the name, §4) | **yes** | `redis://` or `rediss://` URL. Optional everywhere; without it rate limits and caches are per instance |
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
| `STRIPE_SUPPORT_URL`, `PAYPAL_SUPPORT_URL` | new | you (optional) | no (public links) | Support page links; validated, invalid ones ignored with a warning. Runtime config: redeploy after changing. See [Support page](#support-links) |
| `USAGE_CLOUDFLARE_API_TOKEN` | new | you (optional) | **yes** | Monitoring token with only *Account Analytics: Read*, for R2 usage. Redeploy after changing. See [Resource usage](#resource-usage) |
| `USAGE_CLOUDFLARE_ACCOUNT_ID` | new | you (optional) | no | Only if it can't be taken from `R2_ENDPOINT`. Redeploy after changing |
| `USAGE_NEON_API_KEY` | new | you (optional) | **yes** | Project-scoped Neon API key for project storage/compute/transfer (Neon has no read-only key: see [Resource usage](#resource-usage)). Redeploy after changing |
| `USAGE_NEON_PROJECT_ID` | new | you (optional) | no | Neon project ID for the key above |
| `USAGE_NEON_PLAN` | new | you (optional) | no | `free` (default) or `paid`: Neon limits shown as hard or included |
| `USAGE_LIMIT_NEON_STORAGE_GB`, `USAGE_LIMIT_NEON_COMPUTE_CU_HOURS`, `USAGE_LIMIT_NEON_TRANSFER_GB` | new | you (optional) | no | Neon allowances for the dashboard; unset = usage shown without a percentage. Redeploy after changing |
| `USAGE_LIMIT_REDIS_MEMORY_MB`, `USAGE_LIMIT_REDIS_CONNECTIONS`, `USAGE_LIMIT_REDIS_OPS_PER_SEC` | new | you (optional) | no | Redis Cloud plan limits for the dashboard. Redeploy after changing |
| `USAGE_LIMIT_R2_STORAGE_GB_MONTH`, `USAGE_LIMIT_R2_CLASS_A_MONTH`, `USAGE_LIMIT_R2_CLASS_B_MONTH` | new | you (optional) | no | R2 monthly allowances (account-wide) for the dashboard. Redeploy after changing |
| `USAGE_WARN_PERCENT`, `USAGE_CRITICAL_PERCENT`, `USAGE_CACHE_SECONDS` | new | you (optional) | no | Dashboard thresholds (default 75 / 90) and cache time (default 900 s). Invalid values are ignored and listed on the dashboard |
| `PORT`, `UPLOAD_DIR` | existing | not used on Vercel | no | Local server only |
| `VITE_MAP_STYLE_URL`, `VITE_FEATURE_ADS` | existing | you, if needed | no (public, build-time) | Baked into the browser bundle |
| `VITE_CLARITY_PROJECT_ID` | new | you (optional) | no (public, build-time) | Microsoft Clarity project; unset uses `z80oz1x04t`, empty string disables. Set it to `''` for Preview builds if you don't want preview sessions recorded |
| `PG*`, `POSTGRES_*` | injected, unused | Neon integration | yes | Ignore |

Never put a secret in a `VITE_*` variable: those are compiled into public JavaScript.

## 8. Limits, costs and caveats

- **Vercel Functions:** request and response bodies are capped at **4.5 MB**, which is why images upload
  directly to R2. `maxDuration` is 60 s here (`vercel.json`). Billing on Fluid compute is Active CPU +
  provisioned memory + invocations; with no long-lived connections, instances are only busy while answering.
- **CDN caching keeps the free tiers free.** `GET /api/map/points` and `GET /api/discover` are the same for
  every visitor and send `Cache-Control: s-maxage=60, stale-while-revalidate=600`, so Vercel's CDN answers
  most map loads and home-page visits without invoking the Function or waking Neon. Each instance also caches
  them in memory for 30–60 s. The map filters, colours and counts stories in the browser, so moving the
  timeline slider or switching layers costs no requests at all.
- **Neon Free:** limited compute hours and storage, and the database scales to zero when idle, so the first
  request after a pause takes a little longer. The restore window is short.
- **Redis Cloud Free** (optional): 30 MB, 30 connections, 100 ops/s, 5 GB/month, plenty for rate-limit
  counters and caches (§4).
- **R2:** free allowance per month (storage plus Class A/B operations), then pay-as-you-go; no egress fees.
  Each upload costs a few Class A operations (PUT original, 2× PUT processed, DELETE) and a Class B (GET).
- **Hobby is non-commercial.** Ads or other commercial use need Vercel Pro.
- **Previews on random URLs** are read-only by design (origin checks). Use the stable preview domain to test
  sign-in and writing.
- **The map's point list** holds every published story (a few hundred KB gzipped for a few thousand
  stories). Beyond `MAP_POINTS_MAX` (20,000) the least recently updated drop off the map; switch to
  viewport/tiled queries before that (DESIGN.md §13).

### What was verified locally, and what only a real deployment can confirm

Verified in this repository (see the test suites and the changelog):

- `vercel build` (Vercel CLI 65.9) produces one Node 24 Function with sharp's Linux binaries, the bundled API,
  `index.html` and the migrations, plus a static output without `index.html`.
- The built Function, run locally under Node, with Redis unreachable: pages, API, sign-in redirect, 404s for
  missing files and API paths, CSRF rejection and CSP containing the R2 origins (verified before the live
  chat was retired; the retired `/socket.io` path now answers 404).
- Two app instances sharing Postgres and Redis (ioredis-mock) in the test suite: a shared upload rate limit.
- Direct uploads with the local backend (same API flow as R2) in a browser; R2 request signing with a fake
  transport.

Not verifiable without the real services, so check them in the smoke test:

- Vercel passing the original path to the Function through the rewrite (Vercel's documented pattern), and
  the CDN caching `/api/map/points` and `/api/discover` (look for `x-vercel-cache: HIT` on a second load).
- R2 enforcing the signed `content-length` (the API re-checks the size either way), and the CORS preflight.
- If you use Redis: Redis Cloud's injected variable name, its TLS, and real reconnect behaviour.
- Google sign-in on the production domain.

## 9. Smoke-test checklist (after each first deploy of an environment)

Use two different browsers (or one normal and one private window) signed in as two different Google accounts.

- [ ] **Navigation:** open `/`: the Discover panel shows beside the map. Use "Surprise me", open a story,
      click a hex; **refresh** on `/h/<cell>`, `/s/<id>` and `/c/<id>`. The page loads, not a 404.
      `/assets/does-not-exist.js` gives a 404, not the app.
- [ ] **Map:** drag the timeline slider and switch layers (density, category, period, developing): the map
      changes with no new network requests. A second load of `/api/map/points` shows `x-vercel-cache: HIT`.
- [ ] **Headers:** DevTools → Network → the document → `content-security-policy` includes
      `https://images.hexstory.example` in `img-src` and the R2 endpoint in `connect-src`.
- [ ] **Sign-in/out:** "Sign in with Google" returns you to the same page, signed in. The Welcome dialog
      appears once. Sign out, and you're signed out after a refresh.
- [ ] **Stories:** create a story with a summary, a pinned place, categories, a link, a photo and a
      connection to another story; edit it; check Versions. The other story lists the connection too.
- [ ] **Timelines and corrections:** add a development to an ongoing story; dispute a statement in a story
      from the other account; as a Reviewer accept it with a note. The outcome shows on the story.
- [ ] **Collections:** as a Member, create a place collection by picking an area; its stories appear.
- [ ] **Images:** while adding a photo, Network shows `POST /api/uploads` → `PUT https://<account>.r2.cloudflarestorage.com/...` (200)
      → `POST /api/uploads/<id>/complete` (201). The image loads from `images.hexstory.example`. In R2, the
      staging bucket is empty again and the images bucket holds `<id>.webp` and `<id>-thumb.webp`.
- [ ] **New stories wait for approval:** with a fresh (Newcomer) account, write a story. Signed out, it isn't
      listed or reachable; the Moderator account sees it in Watchtower → New stories and approves it, after
      which it is public.
- [ ] **Moderation screen:** as the Moderator, open Moderation: the Users tab lists both accounts, and the
      Audit log shows the approval and the correction decision. Ban a throwaway account with "Remove posts" and
      check its stories are gone; then unban it.
- [ ] **Rate limits:** request 21 upload slots within an hour (or temporarily lower `POLICY.uploadsPerHour`)
      to get HTTP 429.
- [ ] **Persistence:** redeploy (Deployments → Redeploy). Stories, images and your session survive.
- [ ] **Previews:** a preview deployment's build log shows `up to date for "preview"`, and data written there
      doesn't appear in production.
- [ ] **Logs:** Vercel → Logs show no `[startup]` errors (Redis or database).

# DEPLOYMENT_FREE.md — a zero-cost, beginner-friendly setup

> # ⚠️ READ THIS FIRST — NOTHING HERE WAS DEPLOYED OR VERIFIED LIVE
>
> The author's environment had **no cloud credentials, no free-tier account, no card, no
> JDK and no Android SDK**. Therefore:
>
> - **No resource was created anywhere.** No Supabase project, no host, no domain, no APK.
> - **No free-tier quota in this document was checked** against a provider's live page.
>   Free tiers change, pause on inactivity, and sometimes require a card. Re-verify before
>   you rely on any number.
> - **Only the local, no-account path below was actually run** — the API was started and
>   answered `/api/health` (`200`, `schemaVersion: 6`), the seed ran and its integrity report
>   passed, and `npm run build` produced the web bundle. Those are the only parts with real
>   evidence. Everything else is **instructions**.
> - **I cannot log into your accounts.** Where a step needs a human with a browser, it says
>   **"YOU MUST"**.
>
> If any step starts asking for a payment method and you do not intend to pay, **stop**.

Every section below is independent. You can run §1 and stop there and still have a working
business system.

---

## 1. Run it locally with **no accounts at all** (this was verified)

This is the zero-cost baseline: no sign-up, no key, no network.

### 1.1 Prerequisites

| Need | Version | Why |
|---|---|---|
| Node.js | **≥ 22.5** (`engines: ">=22.5.0"`) | the API uses the built-in `node:sqlite` |
| npm | 10+ (ships with Node 22+) | npm workspaces |

Check:

```bash
node --version      # must print v22.5.0 or higher (verified on v24.19.0)
npm --version
```

### 1.2 Install and run

```bash
cd small-business-manager

npm install          # installs the whole workspace; no build tools, no native modules
npm test             # optional but recommended: 330 tests should pass
npm run api          # builds @sbm/domain, then starts the API
```

You should see exactly this (captured):

```
[jobs] wrote backup .../data/backups/sbm-2026-10-14.json
Small Business Manager API listening on http://127.0.0.1:8787 (mode=local)
AI: offline rule engine + curated official links are active (no paid service required).
```

Confirm it is alive:

```bash
curl http://127.0.0.1:8787/api/health
# {"status":"ok","service":"small-business-manager-api","schemaVersion":6,"time":"..."}
```

### 1.3 Load the demo business

```bash
npm run seed                       # writes to DATA_DIR (default ./data)
node apps/api/dist/seed.js --memory # throw-away demo, prints a summary, writes nothing
```

Sign in with `owner@demo.sbm` / `demo1234` (also `partner@demo.sbm`, `farm@demo.sbm`).

### 1.4 Open the web app

```bash
npm run web:dev      # Vite on http://localhost:5173, proxying /api → 127.0.0.1:8787
```

⚠️ **Over plain HTTP the session cookie will not be stored**, because `Secure` is on by
default. For local HTTP browsing only, set `INSECURE_COOKIES=1` (the API reports
`secureCookies: false` in `/api/status` when you do). **Never set this in production.**

### 1.5 Let your partners' phones reach the same PC (still ৳0)

```bash
# .env
HOST=0.0.0.0          # bind to the LAN, not just localhost
```

Then, on each partner's phone (the Expo app):

```bash
cd apps/mobile
npm install           # Expo's dependency tree is large; this is a one-off, explicit step
EXPO_PUBLIC_API_URL=http://192.168.0.20:8787 npm run android
```

Replace `192.168.0.20` with **your** machine's LAN IP. The default
`http://10.0.2.2:8787` only works inside an Android emulator.

> **Attachments note:** photos are stored on the server and are **not** shared with a partner
> who is offline. The API says so in its own response. This is deliberate.

### 1.6 Environment variables (all optional in local mode)

Copy `.env.example` to `.env` (it is git-ignored) and edit. The variables that matter most:

| Variable | Default | Meaning |
|---|---|---|
| `SBM_MODE` | `local` | `local` = embedded SQLite; `shared` = cloud (see §2) |
| `PORT` | `8787` | API port |
| `HOST` | `127.0.0.1` | use `0.0.0.0` to allow phones on the LAN |
| `DATA_DIR` | `./data` | where the DB, `.session_secret`, backups and attachments live |
| `DATABASE_FILE` | *(empty → `DATA_DIR/sbm.db`)* | explicit DB path |
| `DEFAULT_TIMEZONE` | `Asia/Dhaka` | business date logic |
| `DEFAULT_CURRENCY` | `BDT` | money formatting and scale |
| `DEFAULT_LOCALE` | `bn-BD` | default UI language |
| `SESSION_SECRET` | *(empty)* | **required in `shared` mode** (≥32 chars). Generated + persisted to `DATA_DIR/.session_secret` (mode 0600) in local mode |
| `SESSION_TTL_HOURS` | `720` | 30-day sessions |
| `INSECURE_COOKIES` | unset | `1` only for local HTTP |
| `CORS_ORIGIN` | unset | set to the web app's origin if it is on a **different** host |

Generate a secret when you need one:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### 1.7 Backups (do this from day one)

```bash
# a full JSON dump of ONE business (owner/admin; needs backup.manage)
curl -b cookies.txt http://127.0.0.1:8787/api/reports/backup > backup-$(date +%F).json

# put it somewhere that is not this disk (USB drive, cloud drive, another machine)
```

There is also a daily job that writes a **partial** snapshot to
`$DATA_DIR/backups/sbm-YYYY-MM-DD.json` (journal lines, stock movements, harvests, members) —
it **overwrites itself** for the same date and keeps no history, so treat it as a convenience,
not your backup. A restore is `POST /api/reports/restore` with that JSON, into an **empty**
workspace, owner only. See `DATABASE_SCHEMA.md` §9 and `TASKS.md` Phase 15.

---

## 2. Shared mode: your own free Supabase project (so 2–5 partners in different places share data)

**Use this only if your partners are not on the same network.** §1 already supports several
partners on one LAN.

> ⚠️ **This path was NOT verified.** The SQL lives in `supabase/` and its structure is
> asserted by 38 static tests, but the migrations have **never been run against a live
> PostgreSQL**. Expect to debug.

### 2.1 YOU MUST: create the project

1. Sign in at <https://supabase.com> → **New project**. Choose a region near Bangladesh
   (e.g. Singapore / `ap-southeast-1`). Set a strong DB password. Wait ~2 minutes.
2. Enable **Email** auth under **Authentication → Providers**.
3. From **Project Settings → API**, copy: `Project URL`, **`anon` key**, and the
   **`service_role` key**.
   🔒 The `service_role` key **bypasses RLS**. It is for the server only. Never put it in a
   browser, an APK, a repo, or a chat message.
4. From **Project Settings → Database**, copy the connection string (the pooled `postgres://…`
   URI) for `psql`/`supabase db push`.

### 2.2 Apply the migrations and functions

```bash
cd small-business-manager/supabase

# Option A — Supabase CLI
supabase link --project-ref <your-project-ref>
supabase db push                                   # applies migrations/ in filename order

# then the functions, in order (they depend on the 0007 helpers)
for f in functions/0000_helpers.sql functions/01*.sql; do
  psql "$DATABASE_URL" -f "$f"
done

# optional demo data (fake names, *.example.com addresses, no secrets)
psql "$DATABASE_URL" -f seed.sql
```

**Option B** — paste, in order, into the Supabase SQL editor:
`migrations/0001 → 0007`, then `functions/0000 → 0180`, then `seed.sql` (optional).

> Run as a role that can **bypass RLS** (`postgres` / `supabase_admin`). `0007` uses
> `force row level security`, and its `security definer` helpers read `business_members`; if
> their owner cannot bypass RLS you get
> `infinite recursion detected in policy for relation "business_members"`. On plain
> PostgreSQL, reassign the helpers — the exact `alter function … owner to …` list is in
> `supabase/README.md` §2.

### 2.3 Verify RLS — do not skip this

```sql
-- every tenant table must be both enabled AND forced, and must have a SELECT policy
select c.relname, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' order by c.relname;

select t.tablename, count(*) filter (where p.cmd = 'SELECT') as select_policies
  from pg_tables t
  left join pg_policies p on p.schemaname = t.schemaname and p.tablename = t.tablename
 where t.schemaname = 'public'
 group by t.tablename
having count(*) filter (where p.cmd = 'SELECT') = 0;   -- must return no rows
```

Then prove isolation with a real session:

```sql
set local role authenticated;
select set_config('request.jwt.claim.sub', '<user-a-uuid>', true);
select count(*) from public.sales;                        -- only A's rows
select public.is_business_member('<business-b-uuid>');    -- must be false
```

### 2.4 Point the app at it

```bash
# .env  (server-side only)
SBM_MODE=shared
SESSION_SECRET=<48 random bytes, base64url, >= 32 chars>
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service_role key — SERVER ONLY>
CORS_ORIGIN=https://<your web app origin>
```

⚠️ **Honest status:** `SBM_MODE=shared` currently validates the configuration, requires a
strong `SESSION_SECRET`, and reports `database: "shared-cloud"` in `/api/status` — but the
Node API (`apps/api`) has **no Postgres adapter**; it always uses SQLite. The Postgres layer
in `supabase/` is a complete, separately-tested **schema + RLS + RPC** port, and the clients
can talk to those RPCs. Wiring the two together is the remaining work
(`IMPLEMENTATION_PLAN.md` R2). Do not assume that flipping `SBM_MODE` moves your data.

---

## 3. Host the web app on a free static host

The web build is a static site (`apps/web/dist`) — it needs no server runtime, so a free
static host is enough. All three options below have free tiers; **choose one that does not
ask for a card**.

```bash
npm run web:build      # → apps/web/dist/index.html + assets/ (verified: 351 kB JS / 101 kB gzip)
```

| Host | Free tier (⚠️ unverified) | Card? | Notes |
|---|---|---|---|
| Cloudflare Pages | generous static hosting | usually no card | connect a Git repo or upload `dist/`; free `*.pages.dev` subdomain |
| Netlify | free static hosting | usually no card | drag-and-drop `dist/`, or Git |
| GitHub Pages | free for public repos | no | **private repos need a paid plan**, so use a public repo or another host |

**Two things to get right:**

1. **Same-origin `/api`.** The web app calls the API at the **same origin** by default
   (`VITE_API_BASE` is empty) so the `sbm_session` cookie is first-party. If the API is on a
   different host, set `VITE_API_BASE=https://api.example.com` at build time **and** set
   `CORS_ORIGIN` on the API — and be aware that a cross-site cookie plus `SameSite=Lax` will
   break sign-in unless you serve both from the same site.
2. **SPA fallback.** Deep links (e.g. `/reports`) need the host to serve `index.html` for
   unknown paths. Cloudflare Pages/Netlify do this by default in most setups; GitHub Pages
   needs a `404.html` copy of `index.html`.

**You cannot host the API on a static host** — it is a stateful Node process with a SQLite
file. If you want one public URL for everything, put the API on a small always-on machine
(your own PC, or an existing VPS you already pay for) and reverse-proxy `/api` to it. That is
outside "free", but it is the only way to expose `apps/api` publicly without a paid PaaS.

**PWA:** the build ships `manifest.webmanifest` and a service worker, so "Add to Home Screen"
installs an offline-capable app shell. ⚠️ Not verified in a browser here. Service workers
require **HTTPS** (or `localhost`).

---

## 4. The AI agent with **no paid service** — three routes

The AI is optional. With nothing configured it uses offline rules + curated official links
and **still answers** (labelled honestly as `fallback`).

### 4.1 Route A — nothing to configure (default, works offline)

```bash
AI_PROVIDER=none
RESEARCH_PROVIDER=none
```

What you get: deterministic business insights, plus six curated official sources
(DAE, BRRI, BARI, DLS, DoF, FAO), each labelled `CURATED_LINK` and explicitly described as a
link to open — **never** as a live search result. No dose is ever invented. This route cannot
be exhausted and cannot bill.

### 4.2 Route B — your own model (Ollama), no cloud at all

```bash
# on the machine you will run the API on
# install Ollama from https://ollama.com and pull a model
ollama pull llama3.1:8b          # ~5 GB; wants ~8 GB of RAM; a GPU makes it usable
```

```bash
# .env
AI_PROVIDER=local-ollama
AI_OLLAMA_URL=http://127.0.0.1:11434
AI_OLLAMA_MODEL=llama3.1:8b
AI_TIMEOUT_MS=20000
AI_MAX_OUTPUT_TOKENS=700
AI_RATE_LIMIT_PER_HOUR=30
```

- Your business data **never leaves your machine**.
- `127.0.0.1` means *the machine running the API* — if the API is in a container, use a
  reachable host. **Never expose an Ollama port to the internet**: it has no authentication.
- An 8B model needs ~8 GB and a GPU for usable speed. This is a desktop/laptop route. **Do not
  expect it to run on an Android phone** — the mobile app has no Ollama setting, by design.

### 4.3 Route C — any OpenAI-compatible endpoint you have free access to

```bash
# .env (server-side only — never bundle these in the web app or the APK)
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://<provider>/v1
AI_API_KEY=<your free key>
AI_MODEL=<model name>
AI_TIMEOUT_MS=20000
AI_MAX_OUTPUT_TOKENS=700
AI_RATE_LIMIT_PER_HOUR=30
RESEARCH_PROVIDER=searxng           # optional, for live research
RESEARCH_BASE_URL=https://<your searxng>/     # self-hosted is the free option
RESEARCH_TIMEOUT_MS=15000
RESEARCH_RATE_LIMIT_PER_HOUR=20
RESEARCH_CACHE_TTL_HOURS=168
```

🔒 The key stays on the server. `GET /api/ai/status` reports `hasKey: true/false`, **never the
key**. The app never retries against a paid tier and there is no billing code anywhere.

### 4.4 What each route limits, and what happens when you hit it

| Route | Free allowance (⚠️ **unverified**) | On timeout / quota / failure |
|---|---|---|
| A — offline rules | unlimited; no network | n/a — it cannot fail |
| B — Ollama | your hardware | the call aborts at `AI_TIMEOUT_MS` (20 s) and the API **returns the fallback answer** with a limitation line. Never a 500 |
| C — hosted free tier | some request/token allowance; **not verified** | on 429/quota the provider call fails and the app **falls back to offline rules**, labelled. **No charge**, because no paid fallback is configured |
| Research — none | the 6 curated links | cached links, labelled as links, never as search results |
| Research — SearXNG | your server; upstream engines may throttle or block you | empty results → curated links + an explicit limitation line |
| Any route | `AI_RATE_LIMIT_PER_HOUR` (30/h per business+user) | `429 RATE_LIMITED` **before** a provider quota is reached |

**Ground rules:** the app must never *pretend* generative AI or live search ran. `mode` and
`provider` are stored on **every** message and every answer carries its limitations — verify
this in the UI before trusting it. Details: `AI_AGENT_DESIGN.md` and `docs/FREE_TIER_LIMITS.md`.

---

## 5. Android APK, sideloaded — no Google Play

> ### ⚠️ **No APK was produced by this project's author.**
> This environment has **no JDK and no Android SDK**, so nothing was compiled. The Expo
> project, the Gradle scripts and `eas.json` exist; the steps below are the intended route and
> are **unverified end to end**.

**Why sideload instead of Play:** Play Console registration costs money one-off, and the spec
forbids a paid dependency. Sideloading costs ৳0.

### 5.1 Route A — build locally (needs a JDK + Android SDK)

```bash
# prerequisites you MUST install first
#   JDK 17            (e.g. Temurin 17)
#   Android SDK       (Android Studio, or cmdline-tools + platform-tools + build-tools)
#   ANDROID_HOME set, and platform-tools on PATH

cd apps/mobile
npm install                      # Expo's tree is big; this is a one-off, explicit step
npx expo prebuild --platform android     # generates apps/mobile/android/
npm run apk:release              # = cd android && gradlew assembleRelease
#   debug build (no signing needed):  npm run apk:debug
# output:  apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

A release build needs a signing keystore. A **local** keystore is fine:

```bash
keytool -genkeypair -v -keystore sbm-release.keystore -alias sbm \
        -keyalg RSA -keysize 2048 -validity 10000
# keep the keystore and its password OUT of git (see .gitignore: *.keystore, *.jks)
```

### 5.2 Route B — build in the cloud with a free Expo account

```bash
cd apps/mobile
npx eas-cli login                # YOU MUST: create the free account yourself
npx eas-cli build -p android --profile preview
```

`eas.json` already has the profiles. The free tier queues builds; you get a download URL for
the `.apk`. ⚠️ Quotas and terms are not verified here. Note that a cloud build uploads your
source to Expo's builders.

### 5.3 Install it on the phone (sideload)

1. Copy the `.apk` to the phone (USB, or a cloud drive).
2. Open it with a file manager → Android asks to allow installs from that app → allow.
3. Or over USB from a PC with `adb`:

```bash
adb install -r app-release.apk
```

4. ☝️ **Point it at your API.** The app defaults to `http://10.0.2.2:8787` (emulator only).
   For a real phone, build with your LAN IP or a public HTTPS URL:

```bash
EXPO_PUBLIC_API_URL=http://192.168.0.20:8787 npm run apk:release
```

   The current server URL is shown in **Settings** so a partner can confirm it.

5. ⚠️ Android blocks **cleartext HTTP** in release builds. Debug builds allow it; for a release
   build you need **HTTPS**. Either put a TLS reverse proxy in front of the API, or use a
   dev/debug build for LAN testing.

6. The app requests only `INTERNET`, `CAMERA` and `ACCESS_NETWORK_STATE`, and explicitly
   **blocks** location, microphone and contacts. Sideloaded apps cannot be silently updated —
   tell your partners how to install a new APK (same steps, `-r` replaces it, data is kept).

---

## 6. Scheduled backups (a free recipe)

Free hosting is **not** a backup. The owner must export.

**On Windows** (Task Scheduler → a daily task):

```powershell
# backup-daily.ps1
$date = Get-Date -Format 'yyyy-MM-dd'
$dir  = "D:\sbm-backups\$date"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
# 1. the whole embedded database file (stop the API first, or copy with WAL in mind)
Copy-Item "$env:DATA_DIR\sbm.db" "$dir\sbm.db" -Force
Copy-Item "$env:DATA_DIR\.session_secret" "$dir\.session_secret" -Force
# 2. attachments
robocopy "$env:DATA_DIR\attachments" "$dir\attachments" /E /R:1 /W:1 | Out-Null
```

**On Linux/macOS** (cron, `crontab -e`, daily at 02:30):

```cron
30 2 * * * cd /srv/small-business-manager && \
  sqlite3 "$DATA_DIR/sbm.db" ".backup /backups/sbm-$(date +\%F).db" && \
  tar czf /backups/attachments-$(date +\%F).tar.gz "$DATA_DIR/attachments"
```

**Also** take a per-business JSON export at least monthly, and store it **off the machine**:

```bash
curl -b cookies.txt http://127.0.0.1:8787/api/reports/backup > sbm-backup-$(date +%F).json
```

**And test a restore.** A backup you have never restored is a guess. Restore is
owner-only and only into an **empty** workspace:

```bash
curl -b cookies.txt -X POST -H 'content-type: application/json' \
     --data-binary @sbm-backup-2026-10-14.json \
     http://127.0.0.1:8787/api/reports/restore
```

If the embedded DB is your store, prefer `sqlite3 .backup` (or copy while the API is stopped) —
copying a live WAL database can capture a torn state. For Supabase, `pg_dump` on a schedule;
the free plan has **no** daily backups.

Keep the retention honest: delete old copies deliberately, and confirm the copy exists
somewhere that is not the same disk.

---

## 7. Moving providers without changing business logic

Everything provider-specific is confined to a few seams, so a migration never touches the
accounting rules, the sync protocol or the farming model.

| From → to | What you change | What you do **not** touch |
|---|---|---|
| Hosted AI → Ollama / none | `AI_PROVIDER` (+ `AI_OLLAMA_*`) and a restart | domain, accounting, UI |
| Hosted AI provider → another OpenAI-compatible one | `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | everything else |
| SearXNG → none | `RESEARCH_PROVIDER=none`; curated links take over | everything else |
| Supabase → another Postgres | `pg_dump --schema-only`/`--data-only`, re-apply `functions/*.sql`, re-verify RLS with §2.3, then repoint the connection env vars | the schema shape, the RPC names, the domain code |
| Cloud Postgres → embedded SQLite | `SBM_MODE=local` + restore the JSON backup | domain, accounting, UI |
| Static host → another static host | re-run `npm run web:build`, upload `dist/` | everything else |
| Any host → your own machine | copy `DATA_DIR` (DB + attachments + `.session_secret`) and start the API there | everything else |

**Why this works:** the domain package is pure and portable, the SQL is confined to
`apps/api/src/repository.ts` (and `supabase/`), and every provider choice is an **environment
variable**. The one structural caveat: `apps/api` currently speaks only SQLite, so moving to
Postgres means implementing the adapter in front of the `Repository` seam
(`ARCHITECTURE.md` §7.2, `IMPLEMENTATION_PLAN.md` R2).

---

## 8. Pre-flight checklist before real money

- [ ] `SESSION_SECRET` set to ≥32 random characters; `INSECURE_COOKIES` **unset**; the API is
      behind **HTTPS**.
- [ ] `.env` is **not** committed and is not inside `DATA_DIR` backups you share.
- [ ] The `service_role` key exists only on the server.
- [ ] You have taken a backup **and restored it once** into an empty workspace.
- [ ] `GET /api/reports/integrity` reports **all checks passed** on your real data.
- [ ] You know which AI mode you are in (`/api/ai/status`) and your partners know that
      fallback mode is normal, not a fault.
- [ ] Every partner has their **own** login, and you have set roles deliberately.
- [ ] You accept the limitations in `README.md` §8 and `SECURITY.md` §11 (including the two
      open findings) — or you have fixed them.
- [ ] Someone qualified has looked at your tax/accounting needs
      (`ACCOUNTING_RULES.md` says clearly that this is **not** tax advice).

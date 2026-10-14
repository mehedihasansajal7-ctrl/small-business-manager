# FREE_TIER_LIMITS.md

> ## ⚠️ NOTHING IN THIS FILE WAS VERIFIED AGAINST A LIVE PROVIDER
>
> Every number below is a **planning note written from general knowledge and from the
> configuration in `.env.example` — not from the providers' own pages.** No provider's
> pricing, quota, terms or dashboard was opened while this project was built, and **nothing
> was deployed**.
>
> Free tiers change without notice, they pause on inactivity, they sometimes require a card
> on file even when the tier is free, and they can start billing on overage. **Re-check each
> provider's current official page before you rely on any figure here.** Where you see
> `?` or `(unverified)`, treat the value as unknown rather than true.
>
> Last written: **2026-10-14**. Nothing has been re-checked since.

The point of this document is not to be an accurate price list (it cannot be), it is to
answer one question honestly: **what happens when a limit is hit, and can that cost me money
or lose my data?** The answers to those are structural and do not go stale the way quotas do.

---

## 1. What this project needs at each layer

| Layer | Needed | Mandatory cost if you follow the free path |
|---|---|---|
| Domain logic | nothing | **৳0** |
| API + database | a place to run one Node process | **৳0** (your own machine / LAN) — or a free static/edge tier |
| Shared multi-device database | Postgres + auth + RLS (only for the "different cities" case) | **৳0** on a free Postgres tier, **if** it still offers one (`?`) |
| Web app hosting | static file hosting | **৳0** (several free static hosts, no card on most) |
| Android app | sideload an APK | **৳0** — Google Play's one-time registration fee is **avoided entirely** |
| AI agent | nothing (fallback works offline) | **৳0** |
| AI with a real model | your own machine running Ollama | **৳0** (electricity only) |
| Search / research | nothing (curated links) | **৳0** |
| Backups | a file you copy | **৳0** (but you must actually do it) |

---

## 2. The honest limits table

`?` = not verified. `n/a` = no limit that matters at this scale.

| Provider / option | What the free path gives you (**unverified**) | What the limit actually means | What happens when you hit it |
|---|---|---|---|
| **Local machine (this repo, `SBM_MODE=local`)** | unlimited everything; the DB is a file you own | your disk, your uptime | nothing breaks; your machine is the server, so if it is off, partners cannot sync |
| **LAN hosting** (same PC, `HOST=0.0.0.0`) | partner phones on the same Wi-Fi | Wi-Fi range | out of range → offline mode (data is safe on the device, syncs when back) |
| **Static web host** (Cloudflare Pages / Netlify / GitHub Pages / Vercel hobby) | hosting for a static Vite build | monthly build minutes, bandwidth, and per-build/platform limits — **numbers unverified** | site keeps serving already-deployed files; **new deploys** may be blocked until the window resets. No data loss (data is not in the static host) |
| **Free Postgres tier** (e.g. a Supabase-style free project) | a small database + auth + RLS | project **pauses on inactivity**, storage/row/egress caps, and **RLS is mandatory** because an anon key is public | the schema/RLS/RPCs for this are written and sit in `supabase/` — but **they have never been run**, and `apps/api` has no Postgres adapter yet, so a pause today cannot break anything because nothing is connected. Once wired up: a paused project returns errors until you resume it in the dashboard; **nothing is deleted** by a pause, but never treat it as a backup. If a cap is exceeded, writes are rejected and the devices keep their outbox and retry |
| **Object storage free tier (for photos)** | a bit of file storage | storage + egress caps; some tiers require a card | uploads fail; **core transactions still work** because attachments are optional by design. A failed attachment never rolls back a posted transaction |
| **AI — no provider (`AI_PROVIDER=none`)** | deterministic rules + curated official links | **none** | nothing. This mode cannot be exhausted, cannot bill, works offline |
| **AI — local Ollama** | whatever your own hardware can run | your RAM/GPU; an 8B model wants ~8 GB | the request times out after `AI_TIMEOUT_MS` (20 s) and the API **returns the fallback answer with a limitation line** — never a 500 |
| **AI — hosted OpenAI-compatible free tier** | some request/token allowance (**which providers, and how much: unverified**) | request/min and token limits; free tiers are frequently discontinued or require a card | on 429/quota, the provider call **fails and we fall back to the offline rule engine**, labelled. No charge, because the code never retries against a paid tier and has no billing configuration |
| **Search — none (`RESEARCH_PROVIDER=none`)** | the 6 curated government/FAO links | none | nothing; links are labelled `CURATED_LINK`, never as live results |
| **Search — self-hosted SearXNG** | your own meta-search endpoint | your server's resources; **upstream engines may rate-limit or block you** | results come back empty → the code falls back to curated links and says so |
| **GitHub (source hosting)** | private repos | repo/bandwidth limits | you can always `git push` to another host; source is also on your disk |
| **Backups** | `GET /api/reports/backup` → a JSON file | **unlimited, because it is just a file** — but *you* must store it somewhere | if you never download it: this is the only real data-loss risk in the whole project |

---

## 3. What happens at a limit — the four cases that matter

1. **Provider quota exhausted (AI or search).** The provider call throws; `AIAgent.ask`
   catches it and answers from the offline rule engine with a limitation that names the
   failure. **No charge, no data loss, no 500.** The mode is reported honestly.
2. **Hosted database paused or over quota.** Requests fail with an error; the devices keep
   their outbox (`PENDING`/`NEEDS_ATTENTION`) and retry with backoff. No local change is
   discarded, and no *partial* posting can survive because each event is applied inside one
   transaction keyed by an idempotency key. (Today this case is hypothetical: the Postgres
   schema in `supabase/` has never been connected to `apps/api`, so nothing depends on a
   hosted database yet.)
3. **Static host over its limit.** The already-deployed site keeps serving; **new deploys**
   may be refused until the window resets. Business data is not in the static host, so there
   is nothing to lose.
4. **Attachment storage full.** Uploads fail; transactions continue. The API already tells the
   user that attachments are not shared with offline partners, so no partner is misled into
   thinking a missing photo is a bug in their data.

**The design rule that makes all four safe:** *nothing paid is a mandatory dependency, and
nothing paid is ever retried or upgraded automatically.* There is no billing configuration in
this repository, no secret that can incur a charge, and no `amount`/`plan` upgrade call
anywhere in the code.

---

## 4. Card-on-file risk (read before signing up)

Some providers require a payment method even for their free tier. **Do not enter a card for a
tier you are not prepared to pay for**, because an accidental overage can start billing
immediately. The order of preference used throughout `DEPLOYMENT_FREE.md` is:

1. **no account at all** — local mode, your own machine (`SBM_MODE=local`);
2. **an account with no card** — a static host and/or a free database that does not require one;
3. **a self-hosted free service** — your own Ollama, your own SearXNG;
4. only then, an account that requires a card — and only if you actively want it.

If a required service starts demanding payment, **stop** — do not let it upgrade. The project
is designed so that every layer has a zero-cost alternative (it may be less convenient).

---

## 5. Monitoring your own usage without paying for monitoring

The app reports what it knows about itself, for free:

- `GET /api/ai/status` — the active provider/mode, the timeout, the output-token cap and the
  hourly request cap.
- `ai_usage` — one row per AI question with `tokens_in`/`tokens_out` (0 for the fallback), so
  you can see your own consumption. **There is no dashboard screen for this yet** — read it via
  the database or add the screen.
- `GET /api/status` — mode, database kind, whether Supabase is configured, whether an AI key is
  present (`hasKey`, never the key), and whether cookies are secure.
- Stdout: a `[slow] METHOD path Nms ip=…` line for any request over 1.5 s — a free,
  dependency-free latency canary.
- The rate limiter returns `429` before a provider cap is hit, so the free allowance is spent
  by real users rather than by a retry loop.

---

## 6. Before-and-after checklist for any quota you approach

- [ ] Write down the limit you are approaching and the **date you checked it**.
- [ ] Confirm there is no card on file, or that you accept the overage.
- [ ] Confirm the export path works **today**: `GET /api/reports/backup` (needs
      `backup.manage`) and download the JSON. Test a restore before you need it.
- [ ] Confirm you know how to switch providers without a code change — for AI that is
      `AI_PROVIDER=none`; for search, `RESEARCH_PROVIDER=none`; for the database, switch back to
      `SBM_MODE=local`. **All three are environment variables.**
- [ ] Tell your partners that the AI answers may drop back to rule-based mode, so nobody
      mistakes a mode change for a fault.

---

## 7. Migration path when a free tier changes

| From | To | What changes |
|---|---|---|
| any hosted AI tier | `AI_PROVIDER=none`, or `local-ollama` | one env var + a restart |
| any hosted AI tier | a different OpenAI-compatible endpoint | `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` |
| SearXNG | `RESEARCH_PROVIDER=none` | one env var; curated links take over |
| Free Postgres tier | another free Postgres tier | connection env vars + re-run migrations + re-seed; **the domain, accounting and UI do not change** |
| Free Postgres tier | `SBM_MODE=local` | one env var + restore the JSON backup |
| Static host | another static host | re-run `npm run web:build` and re-upload `dist/` |
| Static host | self-hosting the same API + web build | point the web app's API base URL at your host |

Nothing in that table requires a code change to the domain package, the accounting rules, the
sync protocol or the farming model — which is the actual guarantee. See
`ARCHITECTURE.md` §7 for the adapter boundary and `ADR-009`/`ADR-003` in `docs/DECISIONS.md`
for why the seam is where it is (and for the honest caveat that the Postgres adapter does not
exist yet).

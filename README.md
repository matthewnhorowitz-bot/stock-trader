# 📈 Congress Trade Notifier

Watches official U.S. congressional stock-trade disclosures (filed under the
**STOCK Act of 2012**) and alerts you by **email and/or SMS** whenever a
legislator you follow reports a new trade. Review each alert and decide for
yourself whether to mirror it in your own brokerage — no auto-trading.

## How it works

```
fetcher.js  →  filter.js  →  tradeLog.js  →  notifier.js
  pull          your          dedupe          email +
  House +       watchlist +    (only NEW       SMS +
  Senate        rules         disclosures)     console
```

A poller (`index.js`) runs the pipeline on an interval (default every 30 min).

## ⚠️ Two things to know about the data

1. **Dollar ranges, not exact amounts.** Trades are disclosed as ranges like
   `$1,001 – $15,000`. Filtering by minimum value uses the *low* end.
2. **Up to a 45-day lag.** The law gives members 45 days to disclose, so you're
   always following with a delay. This is an alerting/research aid, not a way to
   front-run anyone.

## 📡 Data sources (important)

The old free, no-key Stock Watcher JSON buckets that tools like this used to rely
on are now **access-locked (HTTP 403)**. So the data source is **pluggable** via
`DATA_PROVIDER` in `.env`:

| `DATA_PROVIDER` | Needs a key? | Notes |
|-----------------|--------------|-------|
| `sample` (default) | No | Bundled `data/sample_trades.json`. Runs instantly so you can verify the whole pipeline. |
| `fmp`           | Free key | [Financial Modeling Prep](https://site.financialmodelingprep.com/developer/docs) — set `FMP_API_KEY`. |
| `finnhub`       | Free key | [Finnhub](https://finnhub.io/dashboard) — set `FINNHUB_API_KEY` + `FINNHUB_SYMBOLS` (it queries per ticker). |
| `stockwatcher`  | No | Legacy S3 buckets, kept as best-effort — often returns 403. |

Switch to live data by setting, e.g., `DATA_PROVIDER=fmp` and `FMP_API_KEY=...`.
All filtering, dedup, and alerting work identically regardless of source.

## Setup (4 steps)

### 1. Install & configure
```bash
npm install
cp .env.example .env     # then edit .env
```

### 2. Get credentials
- **Email** — use Gmail and create an
  [App Password](https://myaccount.google.com/apppasswords) (~2 min). Put it in
  `SMTP_PASS`.
- **SMS (optional)** — sign up free at [twilio.com](https://twilio.com), grab a
  trial number, and set `SMS_ENABLED=true` plus the Twilio vars.

### 3. Set your watchlist (in `.env`)
```
WATCH_POLITICIANS=Nancy Pelosi,Dan Crenshaw,Tommy Tuberville
TRADE_TYPES=both          # buy | sell | both
MIN_TRADE_VALUE=0
```
Leave `WATCH_POLITICIANS` blank to follow all 535 members.

### 4. Test, then go live
```bash
npm test     # sends a mock alert to confirm email/SMS work
npm run once # one real poll, then exit (good for cron)
npm start    # live poller on your interval
```

> **First run is silent by design.** It marks all existing disclosures as
> "seen" (saved to `data/seen.json`) so you aren't blasted with the entire
> backlog. From then on, only genuinely new filings trigger alerts.

## Files
| File | Role |
|------|------|
| `src/index.js`    | Poller / orchestrator |
| `src/fetcher.js`  | Pulls + normalizes House & Senate disclosures |
| `src/filter.js`   | Applies watchlist, trade type, min value |
| `src/tradeLog.js` | Dedup (`seen.json`) + history (`alert_history.json`) |
| `src/notifier.js` | Email (Nodemailer) + SMS (Twilio) + console |
| `src/config.js`   | Reads `.env` |
| `src/test.js`     | Mock-alert delivery check |

## 🚀 Running in the cloud — GitHub Actions (no card, no cloud account)

This runs the poller on **GitHub's servers** on a schedule — completely free, no
credit card, no Google Cloud account. The trick: there's no bucket to store the
dedup state, so the **repo itself is the database** — after each run the workflow
commits the updated `data/seen.json` back.

```
GitHub Actions cron ── ~every 30 min ──▶ runs: node src/index.js --once
                                              │
                                              ├─ emails + texts you on new trades
                                              └─ commits data/seen.json back to repo
```

Defined in [`.github/workflows/notifier.yml`](.github/workflows/notifier.yml).

**Deploy in 4 steps:**

```bash
# 1. Fill in your config locally
cp .env.example .env        # set DATA_PROVIDER=fmp, FMP_API_KEY, Gmail, Twilio…

# 2. Put the project on GitHub (private repo recommended)
git init && git add . && git commit -m "Congress trade notifier"
gh repo create congress-trade-notifier --private --source=. --push

# 3. Upload your .env values as repo secrets (needs the gh CLI, logged in)
./deploy/set-github-secrets.sh

# 4. Kick off the first run (it'll then run every ~30 min on its own)
gh workflow run "Congress Trade Notifier"
```

Watch it run under the repo's **Actions** tab, or `gh run watch`.

> **SMS** is preset to text **+1 856-444-0212** (`SMS_TO`). You still need a free
> [Twilio](https://twilio.com) number for `TWILIO_*` and `SMS_ENABLED=true`.

**Three things to know about GitHub's free scheduler:**
- Scheduled runs can be **delayed 5–20+ min** (or skipped under heavy load). Fine
  here — disclosures already lag up to 45 days.
- GitHub **auto-disables** scheduled workflows after **60 days of no repo
  activity**. The state commits usually keep it alive, but if there are no new
  trades for that long, re-enable it from the Actions tab.
- Secrets are encrypted; still, use a **private repo** since it commits state.

## Alternative A — Google Cloud Run (needs a GCP account)
A serverless version (Cloud Run Job + Cloud Scheduler + GCS for state) is also
included: [`Dockerfile`](Dockerfile) + [`deploy/deploy.sh`](deploy/deploy.sh).
Run `cp deploy/env.yaml.example deploy/env.yaml`, fill it in, then
`PROJECT_ID=your-project ./deploy/deploy.sh`. Requires the `gcloud` CLI and a
billing-enabled project (fits the Always Free tier, but needs a card on file).

## Alternative B — your own desktop
Run `npm start` (continuous) or `npm run once` from cron / Windows Task
Scheduler. Local `data/seen.json` persists between runs, so dedup still works.

---
*Not financial advice. Always verify against the primary disclosure before acting.*

# grain-catcher

A Cloudflare Worker that listens for [Grain](https://developers.grain.com/#hooks) webhooks and creates OmniFocus tasks via Mail Drop.

For every Grain-recorded meeting:

- **If you attended** → one *"&lt;Company&gt;: Review meeting notes: &lt;title&gt; //grain //&lt;scope&gt; @15m"* task with the AI summary in the note.
- **For every pending AI action item assigned to you** → one *"&lt;Company&gt;: &lt;text&gt; //grain //&lt;scope&gt;"* task with the timestamp. Action items Grain has marked `completed` are skipped.

Every task subject is prefixed with the **company** on the other side of the call — derived from external attendees' email domains (e.g. `sam@snooze.com.au` → `Snooze`), with The Working Party and your own people excluded. Internal-only meetings get no prefix. The `//internal` / `//external` marker reflects whether anyone outside the org was on the call.

Each note is rendered as formatted HTML (OmniFocus Mail Drop renders the HTML part) showing:

- **Company** and **meeting type** (e.g. *Discovery Call (External)*)
- Date, **duration**, and a **clickable recording link**
- Timestamp (action items) and the **AI summary rendered from Markdown** (headings, bullets, bold)
- The full **attendee list with names and clickable emails**

A plain-text fallback is included for anywhere HTML isn't shown.

The trailing `//grain` and `//internal`/`//external` are parsed by OmniFocus as tags; `@15m` becomes the estimated duration.

## How it works

```
┌───────┐  recording_added   ┌──────────────────────┐  send_email   ┌──────────────────────┐  Mail Drop  ┌────────────┐
│ Grain ├───────────────────►│ grain-catcher Worker ├──────────────►│ Cloudflare Email     ├────────────►│ OmniFocus  │
│       │  recording_updated │  (Cloudflare Workers)│               │ Routing (verified    │             │  inbox     │
└───────┘                    └──────────┬───────────┘               │ destination)         │             └────────────┘
                                        │                           └──────────────────────┘
                                        ▼
                              ┌───────────────────┐
                              │ D1: sent_tasks    │
                              │ (INSERT OR IGNORE │
                              │  for dedupe)      │
                              └───────────────────┘
```

Both `recording_added` and `recording_updated` are subscribed because Grain's AI sometimes adds action items minutes after a recording lands. The two hooks would normally cause duplicates, so the Worker claims a dedupe key in D1 before sending each email — `INSERT OR IGNORE` is strongly consistent, so concurrent invocations can't both win.

## Setup

### 1. Install deps and copy the config template

```bash
npm install
cp wrangler.toml.example wrangler.toml
```

`wrangler.toml` is gitignored because it contains your OmniFocus Mail Drop address as `destination_address` — Cloudflare requires this on the `[[send_email]]` binding (it can't be a runtime secret).

### 2. Choose a sender domain on Cloudflare

Outbound mail uses Cloudflare's `send_email` Worker binding, which requires:

- A domain with **Email Routing** enabled on your Cloudflare account.
- Your OmniFocus Mail Drop address added as a **verified destination address** in Email Routing.

Pick a sending domain (or subdomain) that isn't running its own mail through another provider — Email Routing will own the MX records. If your primary domain is on Google Workspace, use a subdomain or a separate domain.

In the dashboard: **Email → Email Routing → Enable**. Cloudflare auto-adds the MX + SPF + DKIM records.

Then **Email Routing → Destination Addresses → Add** your OmniFocus Mail Drop address (`*@sync.omnigroup.com`). The verification email is delivered to Mail Drop, which materialises it as an OmniFocus task — click the link inside.

### 3. Create the D1 database

```bash
npx wrangler d1 create grain-catcher
```

Copy the printed `database_id` into `wrangler.toml` under `[[d1_databases]]`, then apply the schema:

```bash
npx wrangler d1 execute grain-catcher --remote --file migrations/0001_init.sql
```

### 4. Configure the mailer binding

Edit `wrangler.toml` and set `[[send_email]] destination_address` to your Mail Drop address.

### 5. Set secrets

| Secret | Where to find it |
| --- | --- |
| `GRAIN_USER_EMAIL` | The email Grain knows you by. |
| `GRAIN_USER_IDS` | Comma-separated `user_id` + `person_id` from Grain's `myself` endpoint (both appear in payloads in different places). |
| `GRAIN_USER_NAME` | Your display name on Grain action items (fallback match). |
| `MAIL_FROM` | RFC-5322 address on your Email Routing-enabled domain, e.g. `Grain Catcher <grain@oksushi.com>`. |
| `MAIL_TO` | Same as the binding's `destination_address` — used to populate the `To:` header in the MIME message. |
| `WEBHOOK_SECRET` | Any random string; Grain sends it as a `?secret=…` query param. |

```bash
npx wrangler secret put GRAIN_USER_EMAIL
npx wrangler secret put GRAIN_USER_IDS
npx wrangler secret put GRAIN_USER_NAME
npx wrangler secret put MAIL_FROM
npx wrangler secret put MAIL_TO
npx wrangler secret put WEBHOOK_SECRET
```

### 6. Deploy

```bash
npm run deploy
```

Note the Worker URL printed at the end (e.g. `https://grain-catcher.<subdomain>.workers.dev`).

### 7. Register the Grain hooks

You need a Grain Personal Access Token from [grain.com/app/settings/integrations/personal-access-tokens](https://grain.com/app/settings/integrations/personal-access-tokens). Then register both event types:

```bash
WORKER_URL="https://grain-catcher.<subdomain>.workers.dev"
SECRET="<the WEBHOOK_SECRET you set above>"
GRAIN_PAT="<your Grain PAT>"

for TYPE in recording_added recording_updated; do
  curl -X POST https://api.grain.com/_/public-api/v2/hooks/create \
    -H "Authorization: Bearer $GRAIN_PAT" \
    -H "Content-Type: application/json" \
    -H "Public-Api-Version: 2025-10-31" \
    -d "{
      \"hook_url\": \"$WORKER_URL/?secret=$SECRET\",
      \"hook_type\": \"$TYPE\",
      \"include\": { \"participants\": true, \"ai_action_items\": true, \"ai_summary\": true }
    }"
  echo
done
```

Grain replays a test event on creation. A `200` response with "Created N OmniFocus task(s)" (or "No tasks for …" for meetings you didn't attend and have no items in) confirms wiring.

## Backfilling past meetings

`scripts/backfill.mjs` fetches past meetings from the Grain API and replays them through the live Worker as synthetic `recording_added` payloads. D1 dedup means re-running is safe.

```bash
GRAIN_PAT="$(op read 'op://Employee/Grain Personal API Token/password')" \
WEBHOOK_URL='https://grain-catcher.<subdomain>.workers.dev' \
WEBHOOK_SECRET="$(op read 'op://CLI Secrets/Grain Catcher webhook secret/credential')" \
node scripts/backfill.mjs --since 2026-05-01 --dry-run    # preview
node scripts/backfill.mjs --since 2026-05-01              # for real
```

Optional flags: `--before <ISO>` and `--dry-run`.

If you've already manually created OmniFocus tasks for a period and want to make sure incoming webhooks don't recreate them, prime D1 instead of replaying:

```bash
GRAIN_PAT="<your Grain PAT>" \
GRAIN_USER_EMAIL="you@example.com" \
GRAIN_USER_IDS="<user_id>,<person_id>" \
GRAIN_USER_NAME="Your Name" \
node scripts/seed-dedupe.mjs --since 2026-05-01
```

## Local development

```bash
cp .dev.vars.example .dev.vars        # fill in secrets locally
npm run dev                           # wrangler dev on http://localhost:8787
```

`send_email` doesn't actually deliver in `wrangler dev` (the binding is a stub locally), but the rest of the pipeline runs. POST a sample payload:

```bash
curl -X POST 'http://localhost:8787/?secret=local' \
  -H 'content-type: application/json' \
  -d @samples/recording_added.json
```

## Operations

```bash
# Live logs from production
npx wrangler tail

# Inspect dedupe state
npx wrangler d1 execute grain-catcher --remote \
  --command "SELECT COUNT(*) FROM sent_tasks"

# Wipe a single key (forces the next delivery to recreate the task)
npx wrangler d1 execute grain-catcher --remote \
  --command "DELETE FROM sent_tasks WHERE key = 'review:<recording_id>'"

# Manually fire a test payload
curl -X POST "$WORKER_URL/?secret=$WEBHOOK_SECRET" \
  -H 'content-type: application/json' \
  -d @samples/recording_added.json

# List your Grain hooks
curl -H "Authorization: Bearer $GRAIN_PAT" \
  -H "Public-Api-Version: 2025-10-31" \
  https://api.grain.com/_/public-api/v2/hooks

# Delete a Grain hook
curl -X DELETE -H "Authorization: Bearer $GRAIN_PAT" \
  -H "Public-Api-Version: 2025-10-31" \
  https://api.grain.com/_/public-api/v2/hooks/<id>
```

## Project layout

```
src/index.ts              # the Worker
migrations/0001_init.sql  # D1 schema (sent_tasks table)
scripts/backfill.mjs      # replay past meetings through the live Worker
scripts/seed-dedupe.mjs   # prime D1 with dedupe keys without sending
samples/recording_added.json  # sample payload for local testing
wrangler.toml             # bindings + send_email destination
```

## Design notes

- **Why D1, not KV?** KV is eventually consistent (~60s globally). `recording_added` and `recording_updated` fire for the same meeting within seconds, often hitting different Worker instances. Both would read "not seen", both would write, both would email. D1 with `INSERT OR IGNORE` gives an atomic claim — only one invocation wins. On send failure the claim is released so retries can succeed.
- **Why not signature verification?** Grain's webhook docs don't expose a signing key today; the `?secret=` query param is a shared secret stand-in. Treat the Worker URL + secret as the authentication boundary.
- **Why action-item dedup ignores the timestamp?** Grain's AI occasionally revises which moment of the recording an action item points to without changing the wording. Hashing text only avoids spurious duplicates from re-anchored timestamps; if the wording itself changes that's a different, intentional task.
- **Why send via Cloudflare Email Routing instead of Resend / SES?** Keeps the entire stack on Cloudflare. The `send_email` binding restricts outbound to a verified destination, which is fine here since we only ever send to one Mail Drop address.

## Things worth adding later

- **Project routing**: append `::Some Project` to the subject so OmniFocus files tasks into a specific project per meeting type (e.g. internal 1:1s → `::Team / 1:1s`).
- **Defer date**: set the review task's defer date to the morning after the meeting using OmniFocus's `#tomorrow` parsing.
- **Periodic D1 sweep**: a scheduled cron that drops `sent_tasks` rows older than 90 days — keeps the table tiny.
- **Slack mirror**: optional second sink that pings a Slack DM when a high-priority action item is assigned to you.

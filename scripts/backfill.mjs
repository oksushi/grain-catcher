#!/usr/bin/env node
/**
 * Replays Grain meetings against the deployed grain-catcher Worker by
 * synthesising `recording_added` webhook payloads from the Grain API.
 *
 * KV dedup in the Worker ensures this is safe to re-run — already-sent tasks
 * are skipped.
 *
 * Usage:
 *   GRAIN_PAT=$(op read 'op://Employee/Grain Personal API Token/password') \
 *   WEBHOOK_URL='https://grain-catcher.<subdomain>.workers.dev' \
 *   WEBHOOK_SECRET=$(op read 'op://CLI Secrets/Grain Catcher webhook secret/credential') \
 *   node scripts/backfill.mjs --since 2026-05-12
 *
 *   # Or with a full ISO datetime / explicit range:
 *   node scripts/backfill.mjs --since 2026-05-01T00:00:00+10:00 --before 2026-05-12T23:59:59+10:00
 *
 *   # Dry-run (don't POST, just print what would be sent):
 *   node scripts/backfill.mjs --since 2026-05-12 --dry-run
 */

const API = "https://api.grain.com/_/public-api/v2";
const API_VERSION = "2025-10-31";

const args = parseArgs(process.argv.slice(2));
const pat = required("GRAIN_PAT");
const workerUrl = required("WEBHOOK_URL");
const webhookSecret = required("WEBHOOK_SECRET");
const dryRun = !!args["dry-run"];

const sinceIso = toIso(args.since ?? localStartOfDay());
const beforeIso = args.before ? toIso(args.before) : null;

console.log(`Backfilling meetings since ${sinceIso}${beforeIso ? ` before ${beforeIso}` : ""}${dryRun ? " (dry run)" : ""}`);

const meetings = await listAttendedMeetings({ after: sinceIso, before: beforeIso });
console.log(`Found ${meetings.length} attended meeting(s).`);

for (const meeting of meetings) {
  try {
    const payload = buildPayload(meeting);
    if (dryRun) {
      console.log(`\n--- ${meeting.title} (${meeting.id}) ---`);
      console.log(JSON.stringify(payload, null, 2));
      continue;
    }
    const res = await postToWorker(payload);
    console.log(`${meeting.title}: HTTP ${res.status} — ${res.body.trim()}`);
  } catch (err) {
    console.error(`${meeting.title}: ERROR ${err.message}`);
  }
}

// ---------- helpers ----------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}

function localStartOfDay() {
  const now = new Date();
  const tzOffsetMin = -now.getTimezoneOffset();
  const sign = tzOffsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(tzOffsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  const date = now.toISOString().slice(0, 10);
  return `${date}T00:00:00${sign}${hh}:${mm}`;
}

function toIso(value) {
  // Accept date-only (YYYY-MM-DD) or full ISO. Date-only → local start of day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00`).toISOString();
  }
  return new Date(value).toISOString();
}

function flattenSummary(s) {
  if (!s) return null;
  if (typeof s === "string") return s;
  if (typeof s === "object" && typeof s.text === "string") return s.text;
  return null;
}

function durationToMs(hms) {
  if (!hms) return 0;
  const [h, m, s] = hms.split(":").map(Number);
  return ((h * 60 + m) * 60 + (s || 0)) * 1000;
}


async function grain(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${pat}`,
      "Content-Type": "application/json",
      "Public-Api-Version": API_VERSION,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Grain ${res.status} on ${method} ${path}: ${await res.text()}`);
  return res.json();
}

async function listAttendedMeetings({ after, before }) {
  const filter = { attendance: "attended", after_datetime: after };
  if (before) filter.before_datetime = before;
  const include = { participants: true, ai_action_items: true, ai_summary: true };
  const all = [];
  let cursor = null;
  do {
    const body = { filter, include };
    if (cursor) body.cursor = cursor;
    const data = await grain(`/recordings`, { method: "POST", body });
    all.push(...(data.recordings || data.list || []));
    cursor = data.cursor;
  } while (cursor);
  return all;
}

function buildPayload(recording) {
  const durationMs = recording.duration_ms
    ?? (recording.duration ? durationToMs(recording.duration) : 0);
  const start = recording.start_datetime ? new Date(recording.start_datetime) : null;
  const end = recording.end_datetime
    ?? (start ? new Date(start.getTime() + durationMs).toISOString() : null);
  return {
    type: "recording_added",
    user_id: recording.user_id ?? null,
    data: {
      id: recording.id,
      title: recording.title,
      url: recording.url ?? `https://grain.com/share/recording/${recording.id}`,
      start_datetime: recording.start_datetime,
      end_datetime: end,
      duration_ms: durationMs,
      ai_summary: flattenSummary(recording.ai_summary ?? recording.summary),
      participants: (recording.participants || []).map((p) => ({
        id: p.id,
        user_id: p.user_id ?? p.person_id,
        name: p.name,
        email: p.email,
        scope: p.scope,
        confirmed_attendee: p.confirmed_attendee !== false,
      })),
      ai_action_items: (recording.ai_action_items || []).map((a) => ({
        status: a.status,
        timestamp: a.timestamp_ms ?? a.timestamp,
        text: a.text,
        assignee: a.assignee
          ? {
              id: a.assignee.id,
              name: a.assignee.name,
              user_id: a.assignee.user_id ?? a.assignee.person_id,
            }
          : null,
      })),
    },
  };
}

async function postToWorker(payload) {
  const url = new URL(workerUrl);
  url.searchParams.set("secret", webhookSecret);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.text() };
}

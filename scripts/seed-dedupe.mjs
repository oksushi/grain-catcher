#!/usr/bin/env node
/**
 * Computes the dedupe keys for already-sent grain-catcher tasks and inserts
 * them into D1. Run after a one-time backfill (or when migrating dedupe state
 * from one store to another) so future webhook deliveries don't recreate
 * tasks that already exist in OmniFocus.
 *
 * Usage:
 *   GRAIN_PAT=... GRAIN_USER_EMAIL=... GRAIN_USER_IDS=... GRAIN_USER_NAME=... \
 *     node scripts/seed-dedupe.mjs --since 2026-05-11 [--dry-run]
 *
 * Emits SQL on stdout in dry-run mode; otherwise executes against the remote
 * grain-catcher D1 database via `npx wrangler d1 execute`.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API = "https://api.grain.com/_/public-api/v2";
const API_VERSION = "2025-10-31";
const args = parseArgs(process.argv.slice(2));
const dryRun = !!args["dry-run"];

const pat = required("GRAIN_PAT");
const userEmail = required("GRAIN_USER_EMAIL").toLowerCase();
const userIds = new Set(
  (process.env.GRAIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);
const userName = (process.env.GRAIN_USER_NAME ?? "").toLowerCase();
const sinceIso = toIso(args.since ?? localStartOfDay());

const meetings = await listAttendedMeetings({ after: sinceIso });
console.error(`Found ${meetings.length} meeting(s) since ${sinceIso}.`);

const keys = new Set();
for (const m of meetings) {
  for (const k of dedupeKeysForRecording(m)) keys.add(k);
}
console.error(`Computed ${keys.size} dedupe key(s) to insert.`);

const sql = [...keys]
  .map((k) => `INSERT OR IGNORE INTO sent_tasks (key) VALUES ('${k.replace(/'/g, "''")}');`)
  .join("\n");

if (dryRun) {
  process.stdout.write(sql + "\n");
  process.exit(0);
}

const tmp = join(tmpdir(), `seed-dedupe-${Date.now()}.sql`);
writeFileSync(tmp, sql);
try {
  const res = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", "grain-catcher", "--remote", "--file", tmp],
    { stdio: "inherit" },
  );
  process.exit(res.status ?? 1);
} finally {
  try { unlinkSync(tmp); } catch {}
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
  const date = now.toISOString().slice(0, 10);
  return `${date}T00:00:00`;
}

function toIso(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T00:00:00`).toISOString();
  return new Date(value).toISOString();
}

async function grain(path, { method = "POST", body } = {}) {
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

async function listAttendedMeetings({ after }) {
  const all = [];
  let cursor = null;
  do {
    const body = {
      filter: { attendance: "attended", after_datetime: after },
      include: { participants: true, ai_action_items: true },
    };
    if (cursor) body.cursor = cursor;
    const data = await grain(`/recordings`, { body });
    all.push(...(data.recordings || data.list || []));
    cursor = data.cursor;
  } while (cursor);
  return all;
}

// Mirrors the worker's worker logic for which tasks would have been created.
function dedupeKeysForRecording(recording) {
  const keys = [];
  const id = recording.id;
  if (!id) return keys;

  if (userAttended(recording.participants)) {
    keys.push(`review:${id}`);
  }

  for (const item of recording.ai_action_items ?? []) {
    if (!item.text || !assigneeIsUser(item.assignee)) continue;
    keys.push(`action:${id}:${fingerprint(item.text)}`);
  }

  return keys;
}

function userAttended(participants) {
  if (!participants?.length) return false;
  return participants.some((p) => {
    if (p.confirmed_attendee === false) return false;
    if (p.email && p.email.toLowerCase() === userEmail) return true;
    if (p.user_id && userIds.has(p.user_id)) return true;
    if (p.id && userIds.has(p.id)) return true;
    return false;
  });
}

function assigneeIsUser(assignee) {
  if (!assignee) return false;
  if (assignee.email && assignee.email.toLowerCase() === userEmail) return true;
  if (assignee.user_id && userIds.has(assignee.user_id)) return true;
  if (assignee.person_id && userIds.has(assignee.person_id)) return true;
  if (assignee.id && userIds.has(assignee.id)) return true;
  if (userName && assignee.name && assignee.name.toLowerCase() === userName) return true;
  return false;
}

function fingerprint(text) {
  const normalised = text.trim().toLowerCase().replace(/\s+/g, " ");
  let hash = 0;
  for (let i = 0; i < normalised.length; i++) {
    hash = (hash * 31 + normalised.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

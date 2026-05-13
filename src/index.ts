/**
 * Grain Catcher — turns Grain meeting webhooks into OmniFocus tasks.
 *
 * Subscribes to Grain `recording_added` (and friends) webhooks, and for the
 * configured user:
 *   1. If the user attended the meeting → create a "Review meeting notes" task.
 *   2. For every AI action item assigned to the user → create an action task.
 *
 * Tasks are delivered to OmniFocus via Mail Drop using the Cloudflare Email
 * Routing `send_email` binding. The Mail Drop address must be verified as a
 * destination address in Email Routing (binding declared in wrangler.toml).
 */
import { createMimeMessage } from "mimetext";
import { EmailMessage } from "cloudflare:email";

export interface Env {
  GRAIN_USER_EMAIL: string;
  GRAIN_USER_IDS?: string; // comma-separated user_id and/or person_id values
  GRAIN_USER_NAME?: string;
  MAIL_FROM: string; // e.g. "Grain Catcher <grain@bots.theworkingparty.com.au>"
  MAIL_TO: string; // mirror of destination_address from wrangler.toml's send_email binding
  WEBHOOK_SECRET?: string;
  DB: D1Database;
  MAILER: { send(message: unknown): Promise<void> };
}

interface GrainAssignee {
  id?: string;
  name?: string;
  user_id?: string;
  email?: string;
}

interface GrainActionItem {
  status?: string;
  timestamp?: number;
  text?: string;
  assignee?: GrainAssignee | null;
}

interface GrainParticipant {
  id?: string;
  user_id?: string;
  name?: string;
  email?: string;
  scope?: string;
  confirmed_attendee?: boolean;
}

interface GrainRecording {
  id?: string;
  title?: string;
  url?: string;
  start_datetime?: string;
  end_datetime?: string;
  duration_ms?: number;
  participants?: GrainParticipant[];
  ai_action_items?: GrainActionItem[];
  ai_summary?: string;
}

interface GrainWebhook {
  type?: string;
  user_id?: string;
  data?: GrainRecording;
}

interface MailTask {
  subject: string;
  body: string;
  dedupeKey: string;
}

const RECORDING_EVENTS = new Set(["recording_added", "recording_updated"]);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "GET") {
      return new Response("grain-catcher: POST Grain webhooks here\n", { status: 200 });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (env.WEBHOOK_SECRET) {
      const url = new URL(request.url);
      const provided = url.searchParams.get("secret") ?? request.headers.get("x-webhook-secret");
      if (provided !== env.WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    let payload: GrainWebhook;
    try {
      payload = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    if (!payload.type || !RECORDING_EVENTS.has(payload.type)) {
      return new Response(`Ignored event: ${payload.type ?? "(missing)"}\n`, { status: 200 });
    }

    const recording = payload.data;
    if (!recording) {
      return new Response("Missing data\n", { status: 200 });
    }

    const allTasks = buildTasks(recording, env);
    if (allTasks.length === 0) {
      return new Response(`No tasks for "${recording.title ?? recording.id}"\n`, { status: 200 });
    }

    // Atomically claim each dedupe key in D1 before sending. INSERT OR IGNORE
    // returns rowsAffected=1 when we won the race, 0 when another invocation
    // (or a previous delivery of this same hook) already claimed it.
    const claims = await Promise.all(
      allTasks.map(async (task) => {
        const result = await env.DB.prepare(
          "INSERT OR IGNORE INTO sent_tasks (key) VALUES (?)",
        )
          .bind(task.dedupeKey)
          .run();
        return result.meta.changes === 1;
      }),
    );

    const tasks = allTasks.filter((_, i) => claims[i]);
    const skipped = allTasks.length - tasks.length;

    if (tasks.length === 0) {
      return new Response(`All ${allTasks.length} task(s) already sent (deduped)\n`, { status: 200 });
    }

    // Send mails. If a send fails, release the claim so a future delivery can
    // retry — otherwise that task would be permanently blocked.
    const results = await Promise.allSettled(
      tasks.map(async (t) => {
        try {
          await sendToMailDrop(t, env);
        } catch (err) {
          await env.DB.prepare("DELETE FROM sent_tasks WHERE key = ?").bind(t.dedupeKey).run();
          throw err;
        }
      }),
    );
    const failures = results.filter((r) => r.status === "rejected");

    if (failures.length > 0) {
      const messages = failures.map((f) => (f as PromiseRejectedResult).reason).join("; ");
      ctx.waitUntil(Promise.resolve());
      return new Response(
        `Sent ${tasks.length - failures.length}/${tasks.length} (skipped ${skipped}); errors: ${messages}\n`,
        { status: 500 },
      );
    }

    return new Response(`Created ${tasks.length} OmniFocus task(s); skipped ${skipped} already-sent\n`, {
      status: 200,
    });
  },
} satisfies ExportedHandler<Env>;

function buildTasks(recording: GrainRecording, env: Env): MailTask[] {
  const tasks: MailTask[] = [];
  const title = recording.title?.trim() || "Untitled meeting";
  const link = recording.url ?? "";
  const when = formatWhen(recording.start_datetime);
  const recordingId = recording.id ?? "unknown";

  if (userAttended(recording.participants, env)) {
    const noteLines = [
      when ? `Meeting: ${when}` : null,
      link ? `Recording: ${link}` : null,
      recording.ai_summary ? `\nSummary:\n${recording.ai_summary}` : null,
    ].filter(Boolean) as string[];

    tasks.push({
      subject: `Review meeting notes: ${title} //grain @15m`,
      body: noteLines.join("\n"),
      dedupeKey: `review:${recordingId}`,
    });
  }

  for (const item of recording.ai_action_items ?? []) {
    if (!item.text || !assigneeIsUser(item.assignee, env)) continue;
    const noteLines = [
      `From meeting: ${title}`,
      when ? `When: ${when}` : null,
      link ? `Recording: ${link}` : null,
      item.timestamp ? `Timestamp: ${formatTimestamp(item.timestamp)}` : null,
    ].filter(Boolean) as string[];

    tasks.push({
      subject: `${item.text.trim()} //grain`,
      body: noteLines.join("\n"),
      dedupeKey: `action:${recordingId}:${fingerprint(item.text)}`,
    });
  }

  return tasks;
}

function fingerprint(text: string): string {
  // Deterministic fingerprint of the action item text. Ignores timestamp so
  // small AI revisions to the moment-in-time don't create duplicates; if the
  // wording itself changes that's a different (intentional) task.
  const normalised = text.trim().toLowerCase().replace(/\s+/g, " ");
  let hash = 0;
  for (let i = 0; i < normalised.length; i++) {
    hash = (hash * 31 + normalised.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function userIds(env: Env): Set<string> {
  return new Set(
    (env.GRAIN_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function userAttended(participants: GrainParticipant[] | undefined, env: Env): boolean {
  if (!participants?.length) return false;
  const email = env.GRAIN_USER_EMAIL.toLowerCase();
  const ids = userIds(env);
  return participants.some((p) => {
    if (p.confirmed_attendee === false) return false;
    if (p.email && p.email.toLowerCase() === email) return true;
    if (p.user_id && ids.has(p.user_id)) return true;
    if (p.id && ids.has(p.id)) return true;
    return false;
  });
}

function assigneeIsUser(assignee: GrainAssignee | null | undefined, env: Env): boolean {
  if (!assignee) return false;
  if (assignee.email && assignee.email.toLowerCase() === env.GRAIN_USER_EMAIL.toLowerCase()) return true;
  const ids = userIds(env);
  if (assignee.user_id && ids.has(assignee.user_id)) return true;
  if (assignee.id && ids.has(assignee.id)) return true;
  if (env.GRAIN_USER_NAME && assignee.name && assignee.name.toLowerCase() === env.GRAIN_USER_NAME.toLowerCase()) {
    return true;
  }
  return false;
}

function formatWhen(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-AU", {
    timeZone: "Australia/Brisbane",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

async function sendToMailDrop(task: MailTask, env: Env): Promise<void> {
  const { name: fromName, addr: fromAddr } = parseAddress(env.MAIL_FROM);

  const msg = createMimeMessage();
  msg.setSender({ name: fromName, addr: fromAddr });
  msg.setRecipient(env.MAIL_TO);
  msg.setSubject(task.subject);
  msg.addMessage({
    contentType: "text/plain",
    data: task.body || task.subject,
  });

  try {
    await env.MAILER.send(new EmailMessage(fromAddr, env.MAIL_TO, msg.asRaw()));
  } catch (err) {
    throw new Error(`send_email: ${(err as Error).message ?? String(err)}`);
  }
}

function parseAddress(value: string): { name: string; addr: string } {
  const match = value.match(/^\s*(?:"?([^"<]+?)"?\s*)?<([^>]+)>\s*$/);
  if (match) return { name: match[1]?.trim() ?? "", addr: match[2].trim() };
  return { name: "", addr: value.trim() };
}

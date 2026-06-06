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
  ai_summary?: unknown; // Grain sends a string OR an object (e.g. { text: "…" })
  meeting_type?: { id?: string; name?: string; scope?: string } | null;
}

interface GrainWebhook {
  type?: string;
  user_id?: string;
  data?: GrainRecording;
}

interface MailTask {
  subject: string;
  text: string; // plain-text note body (fallback)
  html: string; // rich note body — what OmniFocus renders
  dedupeKey: string;
}

interface Attendee {
  name: string;
  email: string;
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

  // The external party on the call (everyone but us). Used both as the task
  // subject prefix ("Snooze: …") and shown in the note body.
  const company = companyName(recording.participants, env);
  const attendees = listAttendees(recording.participants);
  const prefix = company ? `${company}: ` : "";

  // Whether anyone outside our org was on the call — surfaced as a //internal or
  // //external marker in the subject (OmniFocus reads it as a tag).
  const scope = meetingScope(recording.participants, env);
  const scopeTag = `//${scope}`;

  const ctx: BodyContext = {
    title,
    link,
    when,
    company,
    attendees,
    duration: formatDuration(recording.duration_ms),
    meetingType: recording.meeting_type?.name?.trim() || undefined,
    scope,
  };

  if (userAttended(recording.participants, env)) {
    const { text, html } = buildBody(ctx, { summary: summaryText(recording.ai_summary) });
    tasks.push({
      subject: `${prefix}Review meeting notes: ${title} //grain ${scopeTag} @15m`,
      text,
      html,
      dedupeKey: `review:${recordingId}`,
    });
  }

  for (const item of recording.ai_action_items ?? []) {
    if (!item.text || !assigneeIsUser(item.assignee, env)) continue;
    if (item.status?.toLowerCase() === "completed") continue; // already done in Grain
    const { text, html } = buildBody(ctx, {
      timestamp: item.timestamp ? formatTimestamp(item.timestamp) : undefined,
    });
    tasks.push({
      subject: `${prefix}${item.text.trim()} //grain ${scopeTag}`,
      text,
      html,
      dedupeKey: `action:${recordingId}:${fingerprint(item.text)}`,
    });
  }

  return tasks;
}

interface BodyContext {
  title: string;
  link: string;
  when: string;
  company: string | null;
  attendees: Attendee[];
  duration?: string;
  meetingType?: string;
  scope: "internal" | "external";
}

/**
 * Renders the OmniFocus note in two flavours: a plain-text fallback and an
 * HTML version. OmniFocus Mail Drop prefers the HTML part, so that's where the
 * formatting and the clickable recording link live; the plain-text part keeps
 * the note readable anywhere HTML isn't shown.
 */
function buildBody(
  ctx: BodyContext,
  extra: { timestamp?: string; summary?: string },
): { text: string; html: string } {
  const scopeLabel = ctx.scope === "external" ? "External" : "Internal";
  const typeLine = ctx.meetingType ? `${ctx.meetingType} (${scopeLabel})` : scopeLabel;

  // ---- plain text ----
  const textLines: string[] = [];
  if (ctx.company) textLines.push(`Company: ${ctx.company}`);
  textLines.push(`Meeting: ${ctx.title}`);
  textLines.push(`Type: ${typeLine}`);
  if (ctx.when) textLines.push(`When: ${ctx.when}`);
  if (ctx.duration) textLines.push(`Duration: ${ctx.duration}`);
  if (ctx.link) textLines.push(`Recording: ${ctx.link}`);
  if (extra.timestamp) textLines.push(`Timestamp: ${extra.timestamp}`);
  if (ctx.attendees.length) {
    textLines.push("", "Attendees:");
    for (const a of ctx.attendees) {
      textLines.push(`  • ${a.name && a.email ? `${a.name} <${a.email}>` : a.name || a.email}`);
    }
  }
  if (extra.summary) {
    textLines.push("", "Summary:", extra.summary);
  }

  // ---- html ----
  const rows: string[] = [];
  const row = (label: string, value: string) =>
    `<p style="margin:0 0 6px"><strong>${label}:</strong> ${value}</p>`;
  if (ctx.company) rows.push(row("Company", esc(ctx.company)));
  rows.push(row("Meeting", esc(ctx.title)));
  rows.push(row("Type", esc(typeLine)));
  if (ctx.when) rows.push(row("When", esc(ctx.when)));
  if (ctx.duration) rows.push(row("Duration", esc(ctx.duration)));
  if (ctx.link) {
    rows.push(row("Recording", `<a href="${escAttr(ctx.link)}">Watch in Grain &#8599;</a>`));
  }
  if (extra.timestamp) rows.push(row("Timestamp", esc(extra.timestamp)));
  if (ctx.attendees.length) {
    const items = ctx.attendees
      .map((a) => {
        const name = a.name ? `<strong>${esc(a.name)}</strong>` : "";
        const email = a.email
          ? `&lt;<a href="mailto:${escAttr(a.email)}">${esc(a.email)}</a>&gt;`
          : "";
        return `<li style="margin:0 0 2px">${[name, email].filter(Boolean).join(" ")}</li>`;
      })
      .join("");
    rows.push(
      `<p style="margin:12px 0 4px"><strong>Attendees</strong></p>` +
        `<ul style="margin:0 0 6px;padding-left:20px">${items}</ul>`,
    );
  }
  if (extra.summary) {
    rows.push(
      `<p style="margin:12px 0 4px"><strong>Summary</strong></p>` +
        `<div style="margin:0">${markdownToHtml(extra.summary)}</div>`,
    );
  }
  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;font-size:14px;line-height:1.45;color:#1a1a1a">` +
    rows.join("") +
    `</div>`;

  return { text: textLines.join("\n"), html };
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

// Common second-level labels that sit in front of a country TLD
// (e.g. com.au, co.uk, net.au) — used to find the real brand label.
const SECOND_LEVEL_LABELS = new Set(["com", "net", "org", "co", "gov", "edu", "ac"]);

function emailDomain(email: string | undefined): string {
  if (!email) return "";
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : "";
}

/** The user's own org domain, derived from GRAIN_USER_EMAIL (e.g. theworkingparty.com.au). */
function internalDomain(env: Env): string {
  return emailDomain(env.GRAIN_USER_EMAIL);
}

/**
 * The company on the other side of the call: every confirmed attendee who isn't
 * us, collapsed to a prettified brand name from their email domain. Returns null
 * for internal-only meetings. Multiple external orgs are joined with " / ".
 */
function companyName(participants: GrainParticipant[] | undefined, env: Env): string | null {
  const ours = internalDomain(env);
  const brands = new Set<string>();
  for (const p of participants ?? []) {
    if (p.confirmed_attendee === false) continue;
    if (p.scope && p.scope.toLowerCase() === "internal") continue;
    const domain = emailDomain(p.email);
    if (!domain || domain === ours) continue;
    const brand = prettifyDomain(domain);
    if (brand) brands.add(brand);
  }
  return brands.size ? [...brands].join(" / ") : null;
}

/** snooze.com.au → "Snooze", mail.acme.co.uk → "Acme", country-road.com → "Country-Road". */
function prettifyDomain(domain: string): string {
  const labels = domain.replace(/^www\./, "").split(".").filter(Boolean);
  if (!labels.length) return "";
  let suffixCount = 1;
  if (labels.length >= 3 && SECOND_LEVEL_LABELS.has(labels[labels.length - 2])) {
    suffixCount = 2;
  }
  const brand = labels[Math.max(0, labels.length - 1 - suffixCount)];
  return brand
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("-");
}

/** All confirmed attendees with at least a name or an email, in payload order. */
function listAttendees(participants: GrainParticipant[] | undefined): Attendee[] {
  return (participants ?? [])
    .filter((p) => p.confirmed_attendee !== false)
    .map((p) => ({ name: (p.name ?? "").trim(), email: (p.email ?? "").trim() }))
    .filter((a) => a.name || a.email);
}

/**
 * Grain's `ai_summary` is sometimes a plain string and sometimes an object
 * (e.g. `{ text: "…" }`). Coerce to a trimmed string, or undefined when there's
 * nothing usable — never "[object Object]", and never a throw on `.trim()`.
 */
function summaryText(summary: unknown): string | undefined {
  if (typeof summary === "string") {
    return summary.trim() || undefined;
  }
  if (summary && typeof summary === "object") {
    const obj = summary as Record<string, unknown>;
    for (const key of ["text", "summary", "markdown", "content"]) {
      const value = obj[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return undefined;
}

/** Was anyone outside our org on the call? Prefers Grain's scope, falls back to email domain. */
function meetingScope(
  participants: GrainParticipant[] | undefined,
  env: Env,
): "internal" | "external" {
  const ours = internalDomain(env);
  const hasExternal = (participants ?? []).some((p) => {
    if (p.confirmed_attendee === false) return false;
    if (p.scope) {
      const s = p.scope.toLowerCase();
      if (s === "external") return true;
      if (s === "internal") return false;
      // "unknown" (e.g. notetaker bots) → fall through to the domain check
    }
    const domain = emailDomain(p.email);
    return Boolean(domain) && domain !== ours;
  });
  return hasExternal ? "external" : "internal";
}

/** 3600000 → "1h", 3120000 → "52m", 4500000 → "1h 15m". Undefined when absent. */
function formatDuration(ms: number | undefined): string | undefined {
  if (!ms || ms <= 0) return undefined;
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

/**
 * Minimal Markdown → HTML for the AI summary (Grain sends it as markdown).
 * Handles headings, unordered lists, bold/italic/code and paragraphs — enough
 * to render cleanly in an OmniFocus note without pulling in a parser.
 */
function markdownToHtml(md: string): string {
  const out: string[] = [];
  let listOpen = false;
  const closeList = () => {
    if (listOpen) {
      out.push("</ul>");
      listOpen = false;
    }
  };
  for (const raw of md.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (bullet) {
      if (!listOpen) {
        out.push(`<ul style="margin:4px 0;padding-left:20px">`);
        listOpen = true;
      }
      out.push(`<li style="margin:0 0 2px">${renderInline(bullet[1])}</li>`);
    } else if (heading) {
      closeList();
      out.push(`<p style="margin:8px 0 2px"><strong>${renderInline(heading[2])}</strong></p>`);
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      out.push(`<p style="margin:0 0 6px">${renderInline(line)}</p>`);
    }
  }
  closeList();
  return out.join("");
}

/** Inline markdown (bold/italic/code) on an already-trusted line; escapes HTML first. */
function renderInline(text: string): string {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escAttr(value: string): string {
  return esc(value).replace(/"/g, "&quot;");
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
  // multipart/alternative: OmniFocus Mail Drop renders the HTML part (formatting
  // + clickable link); the plain-text part is the fallback.
  msg.addMessage({
    contentType: "text/plain",
    data: task.text || task.subject,
  });
  if (task.html) {
    msg.addMessage({
      contentType: "text/html",
      data: task.html,
    });
  }

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

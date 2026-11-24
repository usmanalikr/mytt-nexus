// brain-ingest — the only part of the brain anyone on the internet can reach.
//
// It is deployed without Supabase's JWT check and guards itself with its own
// token (D12), so the narrowness of that token is the whole security story of
// this endpoint. What it may do: add or update private items, and move
// watermarks. What it may not do: read anything back except the watermarks.
//
// It also cannot trust its caller. The gather screens and applies the scope
// rules before posting, but a public endpoint has no way to know that, so both
// run again here — this is the copy that counts.
//
// Slice 1 owns this file.

import {
  INGEST_MAX_BODY_BYTES,
  INGEST_TOKEN_HEADER,
  type IngestBatch,
  type InboxItem,
  type WatermarkUpdate,
} from "../_shared/types.ts";
import { screenText, sha256 } from "../_shared/screen.ts";

export interface ScopeRule {
  source: string;
  project: string | null;
  in_scope: boolean;
}

export interface Deps {
  token: string;
  scopeRules: ScopeRule[];
  upsert(item: InboxItem): Promise<{ inserted: boolean; changed: boolean }>;
  sendToReview(item: InboxItem): Promise<void>;
  setWatermark(source: string, at: string): Promise<void>;
  readWatermarks(): Promise<{ source: string; watermark: string }[]>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// --- the token ---------------------------------------------------------------

/** Constant time, so a wrong token cannot be found a character at a time.
 *  Compares the full length of both strings whatever happens. */
function tokensMatch(given: string, expected: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Only from its own header. A token the function accepted in `Authorization`
 *  would collide with a signed-in user's own bearer token on the same host,
 *  and would be sent on every REST call the session makes (D12). */
function authorised(request: Request, expected: string): boolean {
  const given = request.headers.get(INGEST_TOKEN_HEADER);
  if (!given) return false;
  return tokensMatch(given, expected);
}

// --- the batch ---------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const MAX_ITEMS = 500;

/** A hand-written check rather than a JSON Schema library: jsr.io and npm are
 *  outside the environment's network allowlist, and an endpoint this exposed
 *  should not gain a dependency to save thirty lines. It enforces the same
 *  constraints as contract/ingest-batch.schema.json; the schema stays the
 *  source of truth and tests/test_contract.py checks it still bites. */
function invalidBatch(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return "the body is not an object";
  const batch = body as Partial<IngestBatch>;

  if (typeof batch.batch_id !== "string" || !UUID.test(batch.batch_id)) {
    return "batch_id must be a uuid";
  }
  if (typeof batch.gathered_at !== "string" || Number.isNaN(Date.parse(batch.gathered_at))) {
    return "gathered_at must be a timestamp";
  }
  if (!Array.isArray(batch.items)) return "items must be an array";
  if (batch.items.length > MAX_ITEMS) return `at most ${MAX_ITEMS} items in a batch`;
  if (batch.watermarks !== undefined && !Array.isArray(batch.watermarks)) {
    return "watermarks must be an array";
  }

  for (const [i, item] of batch.items.entries()) {
    if (typeof item !== "object" || item === null) return `items[${i}] is not an object`;
    const it = item as Partial<InboxItem>;
    for (const field of ["source", "source_id", "kind", "body"] as const) {
      if (typeof it[field] !== "string" || it[field] === "") {
        return `items[${i}].${field} is required`;
      }
    }
    if (it.body_sha256 !== undefined && !SHA256.test(String(it.body_sha256))) {
      return `items[${i}].body_sha256 is not a sha-256`;
    }
    if (typeof it.screened !== "object" || it.screened === null) {
      // An unscreened item must be distinguishable from a clean one (D6).
      return `items[${i}].screened is required`;
    }
  }

  for (const [i, w] of (batch.watermarks ?? []).entries()) {
    const mark = w as Partial<WatermarkUpdate>;
    if (typeof mark.source !== "string" || typeof mark.watermark !== "string") {
      return `watermarks[${i}] needs a source and a watermark`;
    }
    if (Number.isNaN(Date.parse(mark.watermark))) return `watermarks[${i}].watermark is not a time`;
  }

  return null;
}

// --- the scope rules ----------------------------------------------------------

type Decision = "store" | "reject" | "review";

/** The twin of brain/scope.py. Three answers, not two: anything unclear waits
 *  for a person rather than entering on a guess (AC2). */
export function decide(item: InboxItem, rules: ScopeRule[]): Decision {
  const forSource = rules.filter((r) => r.source === item.source);
  const applicable = forSource.length ? forSource : rules.filter((r) => r.source === "*");
  if (!applicable.length) return "review";

  const project = (item.project ?? "").trim();
  if (!project) return "review";

  for (const rule of applicable) {
    if (rule.project !== null && rule.project === project) return rule.in_scope ? "store" : "reject";
  }

  // A name that contains an in-scope project name is ambiguous — "MyTT Phase 2"
  // may well be MyTT — so a person decides. Substring matching as a rule would
  // quietly widen the scope of the whole brain.
  const lowered = project.toLowerCase();
  for (const rule of applicable) {
    if (!rule.in_scope || !rule.project) continue;
    const name = rule.project.toLowerCase();
    if (lowered.includes(name) || name.includes(lowered)) return "review";
  }

  return "reject";
}

// --- the handler ---------------------------------------------------------------

export async function handler(request: Request, deps: Deps): Promise<Response> {
  if (!authorised(request, deps.token)) {
    // No detail: a 401 that explained itself would help someone probing.
    return json({ error: "unauthorised" }, 401);
  }

  const url = new URL(request.url);

  if (request.method === "GET") {
    // The one thing the token may read back (AC21). Every other read is
    // refused, so a leaked token cannot become a way to read what was
    // gathered.
    if (url.pathname.endsWith("/watermarks")) return json(await deps.readWatermarks());
    return json({ error: "not available" }, 404);
  }

  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > INGEST_MAX_BODY_BYTES) {
    // The endpoint is public, so an unbounded batch is an unbounded
    // transaction. Refuse before parsing, not after.
    return json({ error: "batch too large" }, 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "the body is not JSON" }, 400);
  }

  const problem = invalidBatch(body);
  if (problem) return json({ error: problem }, 400);

  const batch = body as IngestBatch;
  let accepted = 0;
  let queued = 0;
  let sentToReview = 0;
  let rejected = 0;

  for (const item of batch.items) {
    // Screen before anything else touches it. The gather screened it and this
    // is the second of three passes (D6); the endpoint cannot assume the first
    // one happened.
    const screened = screenText(item.body ?? "");
    const stored: InboxItem = {
      ...item,
      body: screened.body,
      body_sha256: await sha256(screened.body),
      screened: {
        patterns_version: screened.patterns_version,
        hits: screened.hits,
        withheld: item.screened?.withheld ?? false,
      },
    };

    switch (decide(stored, deps.scopeRules)) {
      case "store": {
        const { changed } = await deps.upsert(stored);
        accepted += 1;
        if (changed) queued += 1;
        break;
      }
      case "review":
        await deps.sendToReview(stored);
        sentToReview += 1;
        break;
      case "reject":
        rejected += 1;
        break;
    }
  }

  // Watermarks move last, and only once the items are in. A watermark advanced
  // ahead of a failed write would mean that window is never asked for again.
  for (const mark of batch.watermarks ?? []) {
    await deps.setWatermark(mark.source, mark.watermark);
  }

  return json({ accepted, queued, sent_to_review: sentToReview, rejected });
}

// Deno.serve is only reached when deployed; the tests call handler() directly
// with their own deps, so nothing here opens a connection during a test run.
if (import.meta.main) {
  const { serveWithDatabaseDeps } = await import("./deps.ts");
  await serveWithDatabaseDeps(handler);
}

// AC1 and AC21 — the ingest endpoint.
//
// brain-ingest is the only part of the brain anyone on the internet can reach:
// it is deployed without Supabase's JWT check and guards itself with its own
// token (D12). So the narrowness of that token is not a detail — it is the
// whole security story of the endpoint.
//
// Slice T owns this file. It fails until slice 1 exists.

import { assertEquals, assertNotEquals } from "../_shared/testing.ts";
import { handler, type Deps } from "./index.ts";
import { INGEST_TOKEN_HEADER, type IngestBatch, type InboxItem } from "../_shared/types.ts";

const TOKEN = "test-ingest-token-not-a-real-one";

function batch(overrides: Partial<IngestBatch> = {}): IngestBatch {
  return {
    batch_id: "11111111-2222-3333-4444-555555555555",
    gathered_at: "2026-11-25T06:00:00Z",
    items: [{
      source: "em_tracker.meetings",
      source_id: "m-1",
      kind: "meeting",
      title: "Roadmap meeting",
      body: "The release moved to 5 Dec.",
      project: "MyTT",
      body_sha256: "a".repeat(64),
      screened: { patterns_version: "1.0.0", hits: [], withheld: false },
    }],
    watermarks: [{ source: "em_tracker.meetings", watermark: "2026-11-25T06:00:00Z" }],
    ...overrides,
  };
}

function post(body: unknown, token: string | null = TOKEN): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token !== null) headers.set(INGEST_TOKEN_HEADER, token);
  return new Request("https://example.supabase.co/brain-ingest", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** An in-memory stand-in for the brain_intake role's view of the database.
 *  Slice 1 fills in the real one; the behaviour under test is the function's,
 *  not Postgres's. */
function deps(): Deps & { items: Map<string, InboxItem>; queued: string[] } {
  const items = new Map<string, InboxItem>();
  const queued: string[] = [];
  const watermarks = new Map<string, string>();
  const review: InboxItem[] = [];
  return {
    items,
    queued,
    token: TOKEN,
    scopeRules: [{ source: "*", project: "MyTT", in_scope: true }],
    upsert: (item) => {
      const key = `${item.source}\u0000${item.source_id}`;
      const before = items.get(key);
      items.set(key, item);
      const changed = !before || before.body_sha256 !== item.body_sha256;
      if (changed) queued.push(key);
      return Promise.resolve({ inserted: !before, changed });
    },
    sendToReview: (item) => {
      review.push(item);
      return Promise.resolve();
    },
    setWatermark: (source, at) => {
      watermarks.set(source, at);
      return Promise.resolve();
    },
    readWatermarks: () => Promise.resolve([...watermarks].map(([source, watermark]) => ({ source, watermark }))),
  };
}

Deno.test("test_ingest_is_idempotent", async () => {
  // AC1 — the same batch twice leaves one row; a changed body updates it and
  // re-queues it. The gather is incremental but overlaps at the edges, so the
  // same item arriving twice is the normal case, not the exception.
  const d = deps();

  await handler(post(batch()), d);
  await handler(post(batch()), d);

  assertEquals(d.items.size, 1, "the same (source, source_id) must not duplicate");
  assertEquals(d.queued.length, 1, "an unchanged item must not be curated again");

  const edited = batch();
  edited.items[0].body = "The release moved to 12 Dec.";
  edited.items[0].body_sha256 = "b".repeat(64);
  await handler(post(edited), d);

  assertEquals(d.items.size, 1, "an edit updates the row rather than adding one");
  assertEquals(d.queued.length, 2, "a changed body is curated again");
});

Deno.test("test_ingest_applies_the_scope_rules", async () => {
  // AC2, on the side that counts. The gather screens and scopes too, but the
  // endpoint is public, so it cannot trust that this was done.
  const d = deps();

  const other = batch();
  other.items[0].project = "ITT";
  await handler(post(other), d);
  assertEquals(d.items.size, 0, "another project never reaches the private store");

  const unset = batch();
  unset.items[0].project = null;
  unset.items[0].source_id = "m-2";
  await handler(post(unset), d);
  assertEquals(d.items.size, 0, "an unset project waits for a person, it does not enter");
});

Deno.test("ingest_token_is_narrow: no token is refused", async () => {
  // AC21
  const d = deps();
  const response = await handler(post(batch(), null), d);

  assertEquals(response.status, 401);
  assertEquals(d.items.size, 0, "nothing is written on a refused request");
});

Deno.test("ingest_token_is_narrow: a wrong token is refused", async () => {
  // AC21
  const d = deps();
  const response = await handler(post(batch(), "not-the-token"), d);

  assertEquals(response.status, 401);
  assertEquals(d.items.size, 0);
});

Deno.test("ingest_token_is_narrow: the token never carries Authorization", async () => {
  // D12 — the cloud environment attaches network secrets by host, and the
  // project host also serves the REST API and Auth. A token the function
  // accepted in Authorization would collide with a signed-in user's own.
  const d = deps();
  const request = new Request("https://example.supabase.co/brain-ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${TOKEN}` },
    body: JSON.stringify(batch()),
  });

  const response = await handler(request, d);

  assertEquals(response.status, 401, "a valid token in the wrong header is still refused");
  assertEquals(d.items.size, 0);
});

Deno.test("ingest_token_is_narrow: it can write items and watermarks", async () => {
  // AC21 — the permitted half.
  const d = deps();
  const response = await handler(post(batch()), d);

  assertEquals(response.status, 200);
  assertEquals(d.items.size, 1);
  assertEquals((await d.readWatermarks()).length, 1);
});

Deno.test("ingest_token_is_narrow: it cannot read the private store back", async () => {
  // AC21 — the token may advance watermarks and add items. Reading items back
  // would turn a leaked token into a way to read everything gathered.
  const d = deps();
  await handler(post(batch()), d);

  const read = new Request("https://example.supabase.co/brain-ingest/items", {
    method: "GET",
    headers: { [INGEST_TOKEN_HEADER]: TOKEN },
  });
  const response = await handler(read, d);

  assertNotEquals(response.status, 200);
  const text = await response.text();
  assertEquals(text.includes("The release moved"), false, "no item body comes back");
});

Deno.test("ingest refuses a batch that is too large", async () => {
  // The endpoint is public, so an unbounded batch is an unbounded transaction.
  const d = deps();
  const huge = batch();
  huge.items[0].body = "x".repeat(2_000_000);

  const response = await handler(post(huge), d);

  assertEquals(response.status, 413);
  assertEquals(d.items.size, 0);
});

Deno.test("ingest refuses a batch that does not match the schema", async () => {
  const d = deps();
  const response = await handler(post({ batch_id: "not-a-uuid", items: "no" }), d);

  assertEquals(response.status, 400);
  assertEquals(d.items.size, 0);
});

Deno.test("ingest re-screens what it is given", async () => {
  // AC20's sibling. The gather screens first, but the endpoint cannot trust
  // its caller: the same patterns run again here (D6).
  const d = deps();
  const leaky = batch();
  leaky.items[0].body = "Deploy key sbp_abcdef0123456789abcdef0123 is in the vault.";
  leaky.items[0].screened = { patterns_version: "1.0.0", hits: [], withheld: false };

  await handler(post(leaky), d);

  const stored = [...d.items.values()][0];
  assertEquals(
    String(stored.body).includes("sbp_abcdef0123456789abcdef0123"),
    false,
    "a secret the gather missed must not reach storage",
  );
});

Deno.test("ingest withholds a never-published source whatever the caller says", async () => {
  // AC6, at the endpoint. The gather drops these sources, but a public endpoint
  // cannot know that the gather ran: an item posted straight to it with
  // `withheld: false` must still never be stored or queued for the curator.
  const d = deps();
  const worklog = batch();
  worklog.items[0].source = "em_tracker.worklog_shortfalls";
  worklog.items[0].screened = { patterns_version: "1.0.0", hits: [], withheld: false };

  const response = await handler(post(worklog), d);

  assertEquals(response.status, 200);
  assertEquals(d.items.size, 0, "a never-published source must not be stored");
  assertEquals(d.queued.length, 0, "a never-published source must not reach the curator");
  assertEquals((await response.json()).withheld, 1);
});

Deno.test("ingest withholds an item the caller marked withheld", async () => {
  const d = deps();
  const marked = batch();
  marked.items[0].screened = { patterns_version: "1.0.0", hits: [], withheld: true };

  await handler(post(marked), d);

  assertEquals(d.items.size, 0);
  assertEquals(d.queued.length, 0);
});

Deno.test("ingest screens the title and the url, not only the body", async () => {
  // A meeting title can carry a person's email, and `brain review` offers the
  // title as the published title by default.
  const d = deps();
  const leaky = batch();
  leaky.items[0].title = "Call with jane.doe@example.com about access";
  leaky.items[0].url = "https://app:hunter2hunter2@tracker.example.com/m/1";

  await handler(post(leaky), d);

  const stored = [...d.items.values()][0];
  assertEquals(String(stored.title).includes("jane.doe@example.com"), false);
  assertEquals(String(stored.url).includes("hunter2hunter2"), false);
});

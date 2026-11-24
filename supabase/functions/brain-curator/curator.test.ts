// AC9-AC12, AC16, AC19, AC20 and AC22 — the curator.
//
// This is the only place in the brain where a model decides anything, and the
// only place where a mistake is published rather than merely logged. Every test
// here is about a guard that stands between the model and the team layer.
//
// Slice T owns this file. It fails until slice 3 exists.

import { assertEquals, assertRejects } from "../_shared/testing.ts";
import { runBatch, type CuratorDeps, type QueuedItem } from "./index.ts";
import { CURATOR_DEFAULTS, type Curation } from "../_shared/types.ts";

function queued(n: number): QueuedItem[] {
  return Array.from({ length: n }, (_, i) => ({
    msg_id: i + 1,
    private_item_id: `i${i + 1}`,
    source: "em_tracker.meetings",
    kind: "meeting",
    title: `Meeting ${i + 1}`,
    body: `The release moved to 5 Dec. Item ${i + 1}.`,
  }));
}

function published(id: string, tier: 1 | 2 | 3 = 3): Curation {
  return {
    source_item_id: id,
    outcome: "published",
    reason: "the release date moved",
    items: [{
      tier,
      kind: "date",
      title: "Release moved to 5 Dec",
      body: "The release has moved to 5 Dec.",
      status: "n/a",
      left_out: [],
    }],
  };
}

/** Records everything the curator did, so a test can assert on the whole
 *  transaction rather than on one write at a time. */
function deps(overrides: Partial<CuratorDeps> = {}) {
  const written = { items: [] as unknown[], outcomes: [] as Curation[], flags: [] as unknown[] };
  const requeued: number[] = [];
  const runs: Record<string, unknown>[] = [];
  const calls: { prompt: string; body: string }[] = [];
  const base: CuratorDeps = {
    settings: { ...CURATOR_DEFAULTS, publishEnabled: true },
    now: () => 0,
    deadline: 120_000,
    take: (n) => Promise.resolve(queued(n)),
    callModel: ({ prompt, body }) => {
      calls.push({ prompt, body });
      const id = body.match(/Item (\d+)/)?.[1] ?? "1";
      return Promise.resolve({
        json: published(`i${id}`),
        tokensIn: 2500,
        tokensOut: 500,
      });
    },
    record: (curation, items) => {
      written.outcomes.push(curation);
      written.items.push(...items);
      if (curation.outcome === "flagged") written.flags.push(curation);
      return Promise.resolve();
    },
    requeue: (msgId) => {
      requeued.push(msgId);
      return Promise.resolve();
    },
    openRun: (row) => {
      runs.push({ ...row, status: "running" });
      return Promise.resolve("run-1");
    },
    closeRun: (id, row) => {
      runs.push({ id, ...row });
      return Promise.resolve();
    },
    neuronsSpentToday: () => Promise.resolve(0),
    writeDigest: () => Promise.resolve(),
  };
  return { deps: { ...base, ...overrides }, written, requeued, runs, calls };
}

Deno.test("test_record_all_or_nothing", async () => {
  // AC9 — a curation covering N items produces N outcomes, and invalid JSON or
  // a missing item writes nothing at all. A half-written batch would leave an
  // item that looks curated but has no team item and no flag: invisible.
  const d = deps({
    take: () => Promise.resolve(queued(3)),
    record: () => Promise.reject(new Error("constraint violation on the third")),
  });

  await assertRejects(() => runBatch(d.deps));

  assertEquals(d.written.items.length, 0, "nothing is written when the transaction fails");
  assertEquals(d.written.outcomes.length, 0);
});

Deno.test("test_flagged_never_published_without_decision", async () => {
  // AC10 — a flag writes a flags row and no brain.items row. Nothing flagged
  // reaches the team without Usman's decision in `brain review`.
  const d = deps({
    take: () => Promise.resolve(queued(1)),
    callModel: () =>
      Promise.resolve({
        json: {
          source_item_id: "i1",
          outcome: "flagged",
          reason: "the date moved for a commercial reason",
          flag_reason: "the new date can be published, the reason cannot",
          items: [],
        } as Curation,
        tokensIn: 2500,
        tokensOut: 300,
      }),
  });

  await runBatch(d.deps);

  assertEquals(d.written.flags.length, 1);
  assertEquals(d.written.items.length, 0, "a flagged item never reaches brain.items");
});

Deno.test("test_decisions_default_to_proposed", async () => {
  // AC11 — without evidence of agreement a decision is stored as proposed.
  // Otherwise every passing remark in a meeting would read as policy.
  const d = deps({
    take: () => Promise.resolve([{
      msg_id: 1,
      private_item_id: "i1",
      source: "em_tracker.meetings",
      kind: "meeting",
      title: "Roadmap meeting",
      body: "I think we'll go with Postgres full-text search for now.",
    }]),
    callModel: () =>
      Promise.resolve({
        json: {
          source_item_id: "i1",
          outcome: "published",
          reason: "a search approach was discussed",
          items: [{
            tier: 3,
            kind: "decision",
            title: "Search approach",
            body: "Postgres full-text search is the current direction.",
            status: "proposed",
            left_out: [],
          }],
        } as Curation,
        tokensIn: 2500,
        tokensOut: 400,
      }),
  });

  await runBatch(d.deps);

  const item = d.written.items[0] as { status: string };
  assertEquals(item.status, "proposed");
});

Deno.test("test_curator_validates_and_retries", async () => {
  // AC12 — output that fails the schema is retried once, then flagged. There
  // is no JSON mode on this model (D5), so this is the only thing standing
  // between a chatty answer and the team layer.
  let attempt = 0;
  const d = deps({
    take: () => Promise.resolve(queued(1)),
    callModel: () => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.resolve({
          json: { outcome: "published" } as unknown as Curation, // no source_item_id, no items
          tokensIn: 2500,
          tokensOut: 120,
        });
      }
      return Promise.resolve({ json: published("i1"), tokensIn: 2500, tokensOut: 500 });
    },
  });

  await runBatch(d.deps);

  assertEquals(attempt, 2, "one retry, not none and not a loop");
  assertEquals(d.written.outcomes[0].outcome, "published");
});

Deno.test("test_curator_flags_after_the_retry_fails", async () => {
  // AC12 — the second failure flags rather than dropping the item or guessing.
  const d = deps({
    take: () => Promise.resolve(queued(1)),
    callModel: () =>
      Promise.resolve({ json: { outcome: "maybe" } as unknown as Curation, tokensIn: 2500, tokensOut: 90 }),
  });

  await runBatch(d.deps);

  assertEquals(d.written.flags.length, 1);
  assertEquals(d.written.items.length, 0);
});

Deno.test("test_curator_prompt_starts_with_the_policy_byte_for_byte", async () => {
  // AC12 — the policy is deployed with the function and prefixes every call.
  // If the prompt could drift from docs/PUBLISHING-POLICY.md, the policy you
  // read and the policy the model follows would be different documents.
  const d = deps({ take: () => Promise.resolve(queued(1)) });

  await runBatch(d.deps);

  const policy = await Deno.readTextFile(
    new URL("../../../docs/PUBLISHING-POLICY.md", import.meta.url),
  );
  assertEquals(d.calls[0].prompt.startsWith(policy), true);
});

Deno.test("budget_guard: the day's cap stops the batch", async () => {
  // AC16 — at 9,000 neurons the function stops taking items, the rest stay
  // queued, and the digest says so. Cloudflare refuses requests over the free
  // limit rather than charging, so without this a run fails halfway.
  const d = deps({
    take: () => Promise.resolve(queued(3)),
    neuronsSpentToday: () => Promise.resolve(8_980),
  });

  await runBatch(d.deps);

  assertEquals(d.written.outcomes.length, 0, "no item is started that will not fit");
  assertEquals(d.requeued.length, 3, "everything goes back on the queue");
  const closed = d.runs.at(-1) as { status: string };
  assertEquals(closed.status, "budget_reached");
});

Deno.test("budget_guard: spending is billed from the response, not estimated", async () => {
  // D7 — the guard bills from the token counts Workers AI returns. An estimate
  // that drifts low would walk the day straight past the cap.
  const d = deps({
    take: () => Promise.resolve(queued(1)),
    callModel: () => Promise.resolve({ json: published("i1"), tokensIn: 4_000, tokensOut: 2_000 }),
  });

  await runBatch(d.deps);

  const closed = d.runs.at(-1) as { neurons: number };
  // gemma-4: 9,091 in / 27,273 out per million.
  assertEquals(closed.neurons, Math.ceil((4_000 * 9_091 + 2_000 * 27_273) / 1_000_000));
});

Deno.test("curator_batch_requeues", async () => {
  // AC19 — the deadline is the stop condition, not the count. The free plan
  // allows 150s of wall clock, and a model call runs 10-30s, so a batch that
  // ran to its item count would be cut off mid-write.
  let clock = 0;
  const d = deps({
    take: () => Promise.resolve(queued(5)),
    now: () => clock,
    deadline: 100_000,
    callModel: () => {
      clock += 40_000;
      return Promise.resolve({ json: published(`i${d.written.outcomes.length + 1}`), tokensIn: 2500, tokensOut: 500 });
    },
  });

  await runBatch(d.deps);

  assertEquals(d.written.outcomes.length, 2, "two fit inside the deadline");
  assertEquals(d.requeued.length, 3, "three go back on the queue");
  const closed = d.runs.at(-1) as { status: string };
  assertEquals(closed.status, "ok", "stopping early is not a failure");
});

Deno.test("curator_batch_opens_its_run_row_before_the_first_call", async () => {
  // D8 — the pg_cron call reaches this function through pg_net, which gives up
  // after 5 seconds. Nobody is listening for the response, so a batch that
  // crashes leaves no HTTP error anywhere. The run row is the only evidence.
  const d = deps({
    take: () => Promise.resolve(queued(1)),
    callModel: () => Promise.reject(new Error("Workers AI timed out")),
  });

  await runBatch(d.deps).catch(() => {});

  assertEquals(d.runs.length >= 1, true, "a run row exists even though the batch failed");
  assertEquals(d.runs[0].status, "running");
});

Deno.test("curator_rescreens", async () => {
  // AC20 — the second screen catches what the first missed. The item in the
  // queue was screened by the gather and again by ingest; this is the last
  // chance before the text leaves the building.
  const leaky = [{
    msg_id: 1,
    private_item_id: "i1",
    source: "em_tracker.meetings",
    kind: "meeting",
    title: "Deploy notes",
    body: "Use key sbp_abcdef0123456789abcdef0123 for the staging deploy.",
  }];
  const d = deps({ take: () => Promise.resolve(leaky) });

  await runBatch(d.deps);

  assertEquals(
    d.calls[0].body.includes("sbp_abcdef0123456789abcdef0123"),
    false,
    "a secret never reaches the model call",
  );
  assertEquals(d.calls[0].body.includes("[redacted:"), true);
});

Deno.test("curator_publish_switch", async () => {
  // AC22 — with CURATOR_PUBLISH_ENABLED off, every item is flagged and
  // brain.items stays empty, whatever the model returned. This is the switch
  // D10 relies on: until the comparison against Claude passes, nothing
  // published by this model can be read by anyone.
  const d = deps({
    take: () => Promise.resolve(queued(2)),
    settings: { ...CURATOR_DEFAULTS, publishEnabled: false },
  });

  await runBatch(d.deps);

  assertEquals(d.written.items.length, 0, "nothing reaches the team layer");
  assertEquals(d.written.flags.length, 2, "every item is flagged instead");
  for (const outcome of d.written.outcomes) {
    assertEquals(outcome.outcome, "flagged");
  }
});

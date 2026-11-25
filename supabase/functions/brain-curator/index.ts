// brain-curator — the only place in the brain where a model decides anything,
// and the only place where a mistake is published rather than merely logged.
//
// Everything here is a guard standing between the model and the team layer:
// the third screen, the schema check, the one retry, the publish switch, the
// neuron cap and the deadline. None of them is defensive programming for its
// own sake; each one has an acceptance criterion behind it.
//
// Two facts about how this function is woken shape the whole design.
//
// **Nobody is listening.** pg_cron calls it through pg_net, which gives up
// after five seconds while a batch runs for minutes (D8). There is no caller
// to return an error to, so the `brain.runs` row — opened before the first
// model call, closed at the end — is the only evidence a batch ran at all.
//
// **The wall clock is the limit, not the item count.** The free plan allows
// 150s per worker and a model call takes 10-30s, so the batch stops when its
// own deadline is near and puts the rest back on the queue.
//
// Slice 3 owns this file.

import {
  CURATOR_DEFAULTS,
  CURATOR_TOKEN_HEADER,
  type Curation,
  type CuratedItem,
  type CuratorSettings,
  neuronsFor,
} from "../_shared/types.ts";
import { screenText } from "../_shared/screen.ts";
import { headerTokenMatches } from "../_shared/token.ts";

/** Whether this request may start a batch. Checked before anything else,
 *  including opening a database connection's worth of work. */
export function triggerAllowed(request: Request, expected: string): boolean {
  return headerTokenMatches(request, CURATOR_TOKEN_HEADER, expected);
}

export interface QueuedItem {
  msg_id: number;
  private_item_id: string;
  source: string;
  kind: string;
  title: string | null;
  body: string;
}

export interface ModelAnswer {
  json: Curation;
  tokensIn: number;
  tokensOut: number;
}

export interface CuratorDeps {
  settings: CuratorSettings;
  /** Milliseconds since the batch began. Injected so the deadline is testable. */
  now(): number;
  /** How long this batch may take before it must hand back what is left. */
  deadline: number;
  take(n: number): Promise<QueuedItem[]>;
  callModel(call: { prompt: string; body: string }): Promise<ModelAnswer>;
  /** One transaction: the outcome, its items and the deletion of queue message
   *  `msgId` land together or not at all. */
  record(curation: Curation, items: CuratedItem[], msgId: number): Promise<void>;
  requeue(msgId: number): Promise<void>;
  openRun(row: Record<string, unknown>): Promise<string>;
  closeRun(id: string, row: Record<string, unknown>): Promise<void>;
  neuronsSpentToday(): Promise<number>;
  writeDigest(): Promise<void>;
}

// --- the policy ---------------------------------------------------------------

// The policy prefixes every call, byte for byte (AC12). If the prompt could
// drift from docs/PUBLISHING-POLICY.md, the policy you read and the policy the
// model follows would be two different documents.
//
// Deploying copies it next to the function, because `supabase functions deploy`
// ships the function directory:
//     cp docs/PUBLISHING-POLICY.md supabase/functions/brain-curator/policy.md
let policyText: string | null = null;

export async function policy(): Promise<string> {
  if (policyText !== null) return policyText;
  for (const path of ["./policy.md", "../../../docs/PUBLISHING-POLICY.md"]) {
    try {
      policyText = await Deno.readTextFile(new URL(path, import.meta.url));
      return policyText;
    } catch {
      continue;
    }
  }
  throw new Error(
    "the publishing policy is missing. Copy docs/PUBLISHING-POLICY.md to " +
      "supabase/functions/brain-curator/policy.md before deploying.",
  );
}

/** The system prompt for one item: the policy, byte for byte, then the item's
 *  identity. Exported so the comparison check (eval/curate.ts) sends exactly
 *  what production sends. */
export function prompt(
  policyBody: string,
  item: Pick<QueuedItem, "private_item_id" | "kind" | "title">,
): string {
  return policyBody +
    "\n\n---\n\n" +
    "You are curating one source item for the MyTT brain. Follow the policy above exactly.\n" +
    "Answer with JSON only, matching contract/curation.schema.json:\n" +
    '{"source_item_id": string, "outcome": "published"|"withheld"|"flagged", "reason": string,\n' +
    ' "flag_reason": string|null, "items": [{"tier": 1|2|3, "kind": string, "title": string,\n' +
    ' "body": string, "status": "proposed"|"agreed"|"superseded"|"n/a", "left_out": [string]}]}\n\n' +
    `source_item_id: ${item.private_item_id}\n` +
    `kind: ${item.kind}\n` +
    `title: ${item.title ?? "(none)"}\n`;
}

// --- validation ---------------------------------------------------------------

const OUTCOMES = new Set(["published", "withheld", "flagged"]);
const STATUSES = new Set(["proposed", "agreed", "superseded", "n/a"]);
const LEFT_OUT = new Set([
  "commercial",
  "people",
  "personal_data",
  "credentials",
  "client_relationship",
  "security_detail",
  "off_topic",
]);

/** Mirrors contract/curation.schema.json. Hand-written because jsr.io and the
 *  npm registry are not reachable from every environment this runs in, and
 *  because this is the one check standing between a chatty answer and the team
 *  layer — it should be readable here rather than a schema away. */
export function invalidCuration(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "not an object";
  const c = value as Partial<Curation>;

  if (typeof c.source_item_id !== "string" || !c.source_item_id) return "source_item_id missing";
  if (typeof c.outcome !== "string" || !OUTCOMES.has(c.outcome)) return "outcome is not one of three";
  if (typeof c.reason !== "string" || !c.reason) return "reason missing";
  if (!Array.isArray(c.items)) return "items missing";

  if (c.outcome === "flagged" && (typeof c.flag_reason !== "string" || !c.flag_reason)) {
    // A flag with no reason is a flag nobody can action in `brain review`.
    return "a flagged item needs a flag_reason";
  }
  if (c.outcome !== "published" && c.items.length) return "only a published item carries items";
  if (c.outcome === "published" && !c.items.length) return "a published item needs at least one item";
  if (c.items.length > 3) return "at most one item per tier";

  const seen = new Set<number>();
  for (const [i, item] of c.items.entries()) {
    if (typeof item !== "object" || item === null) return `items[${i}] is not an object`;
    if (![1, 2, 3].includes(item.tier)) return `items[${i}].tier is not 1, 2 or 3`;
    if (seen.has(item.tier)) return `items[${i}] repeats tier ${item.tier}`;
    seen.add(item.tier);
    if (typeof item.title !== "string" || !item.title) return `items[${i}].title missing`;
    if (typeof item.body !== "string" || !item.body) return `items[${i}].body missing`;
    if (!STATUSES.has(item.status)) return `items[${i}].status is not a known status`;
    if (!Array.isArray(item.left_out)) return `items[${i}].left_out missing`;
    for (const category of item.left_out) {
      // A free-text category would make the digest's left-out count
      // meaningless the first time the model phrased one differently.
      if (!LEFT_OUT.has(category)) return `items[${i}].left_out has an unknown category`;
    }
  }
  return null;
}

function asFlagged(item: QueuedItem, reason: string): Curation {
  return {
    source_item_id: item.private_item_id,
    outcome: "flagged",
    reason,
    flag_reason: reason,
    items: [],
  };
}

// --- the batch ------------------------------------------------------------------

/** Used only to decide whether the *next* item will fit in what is left of the
 *  day. Actual spending is billed from the token counts the model returns. */
const ESTIMATED_NEURONS_PER_ITEM = 70;
/** Before any call has been timed, assume a middling one. */
const ESTIMATED_CALL_MS = 30_000;

export async function runBatch(deps: CuratorDeps): Promise<void> {
  const settings = { ...CURATOR_DEFAULTS, ...deps.settings };

  // Opened before anything else. A batch that dies after this point leaves a
  // row that `brain status` will show as open for hours; one that died before
  // it would leave nothing at all (D8).
  const runId = await deps.openRun({ kind: "curate", model: settings.model });

  let spent = 0;
  let startingSpend = 0;
  let done = 0;
  let taken = 0;
  let stoppedBy: "ok" | "budget_reached" | "failed" = "ok";
  const durations: number[] = [];

  try {
    // Inside the try, so a failure here still closes the run row.
    spent = await deps.neuronsSpentToday();
    startingSpend = spent;

    const items = await deps.take(settings.batchSize);
    taken = items.length;

    for (const item of items) {
      const budgetLeft = settings.dailyNeuronCap - spent;
      if (budgetLeft < ESTIMATED_NEURONS_PER_ITEM) {
        // Cloudflare refuses requests over the free limit rather than charging,
        // so a run that walked past the cap would fail halfway through an item
        // instead of stopping cleanly (AC16).
        stoppedBy = "budget_reached";
        await deps.requeue(item.msg_id);
        continue;
      }

      const expected = durations.length
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : ESTIMATED_CALL_MS;
      if (deps.now() + expected > deps.deadline) {
        // AC19 — the deadline is the stop condition, not the count.
        await deps.requeue(item.msg_id);
        continue;
      }

      // AC20 — the third and last screen. By now the gather and brain-ingest
      // have both screened this text; this is the final chance before it
      // leaves the building.
      const screened = screenText(item.body);
      const body = screened.body;

      const startedAt = deps.now();
      let answer: ModelAnswer;
      try {
        answer = await deps.callModel({ prompt: prompt(await policy(), item), body });
      } catch (error) {
        // A model failure is this item's problem, not the batch's: it goes
        // back on the queue and the next item is tried.
        console.error(`brain-curator: model call failed for ${item.private_item_id}`, error);
        await deps.requeue(item.msg_id);
        continue;
      }
      durations.push(deps.now() - startedAt);
      spent += neuronsFor(settings.model, answer.tokensIn, answer.tokensOut);

      let curation = answer.json;
      let problem = invalidCuration(curation);

      if (problem) {
        // AC12 — one retry, not none and not a loop. There is no JSON mode on
        // this model (D5), so a malformed answer is expected occasionally.
        try {
          const retry = await deps.callModel({ prompt: prompt(await policy(), item), body });
          spent += neuronsFor(settings.model, retry.tokensIn, retry.tokensOut);
          curation = retry.json;
          problem = invalidCuration(curation);
        } catch (error) {
          console.error(`brain-curator: retry failed for ${item.private_item_id}`, error);
          problem = "the retry did not return an answer";
        }
      }

      if (problem) {
        curation = asFlagged(item, `the curator could not produce a valid answer: ${problem}`);
      }

      // The id comes from the queue, never from the model: an invented or
      // mistaken id would attach this outcome to another private item.
      curation = { ...curation, source_item_id: item.private_item_id };

      if (!settings.publishEnabled && curation.outcome === "published") {
        // AC22 — until the comparison against Claude passes, nothing this
        // model publishes can be read by anyone (D10). The model's answer is
        // still recorded, so the eval has real output to compare.
        curation = asFlagged(
          item,
          "publishing is switched off until the comparison check passes: " + curation.reason,
        );
      }

      const written: CuratedItem[] = curation.outcome === "published" ? curation.items : [];
      await deps.record(curation, written, item.msg_id);
      done += 1;
    }
  } catch (error) {
    stoppedBy = "failed";
    throw error;
  } finally {
    await deps.closeRun(runId, {
      status: stoppedBy,
      items_taken: taken,
      items_done: done,
      neurons: spent - startingSpend,
      model: settings.model,
      finished_at: new Date().toISOString(),
    });
  }

  await deps.writeDigest();
}

if (import.meta.main) {
  const { serveWithDatabaseDeps } = await import("./deps.ts");
  await serveWithDatabaseDeps(runBatch);
}

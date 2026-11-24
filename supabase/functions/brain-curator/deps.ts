// The database and Workers AI half of brain-curator, kept out of index.ts so
// the batch logic can be tested without a database, without a model and
// without a network.
//
// It connects as `brain_curator`, which may read brain_private and write the
// team layer, and nothing else (D2). The service key is never used.
//
// Slice 3 owns this file.

import postgres from "npm:postgres@3";
import { CURATOR_DEFAULTS, type Curation, type CuratedItem } from "../_shared/types.ts";
import type { CuratorDeps, ModelAnswer, QueuedItem } from "./index.ts";

const DB_URL = "BRAIN_CURATOR_DB_URL";
const CF_ACCOUNT = "CF_ACCOUNT_ID";
const CF_TOKEN = "CF_API_TOKEN";

// The free plan allows 150s of wall clock. The batch hands back what is left
// well before that, so a requeue is never racing the platform's own cut-off.
const BATCH_DEADLINE_MS = 110_000;
const MODEL_TIMEOUT_MS = 45_000;

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set; see the plan's Environment configuration`);
  return value;
}

function settings() {
  return {
    model: Deno.env.get("CF_MODEL") || CURATOR_DEFAULTS.model,
    batchSize: Number(Deno.env.get("CURATOR_BATCH_SIZE") || CURATOR_DEFAULTS.batchSize),
    // Off unless explicitly turned on: a missing or misspelt variable must
    // leave publishing disabled, never enable it (D10).
    publishEnabled: Deno.env.get("CURATOR_PUBLISH_ENABLED") === "true",
    dailyNeuronCap: Number(
      Deno.env.get("CURATOR_NEURON_CAP") || CURATOR_DEFAULTS.dailyNeuronCap,
    ),
  };
}

/** Workers AI, through its REST endpoint. AI Gateway is deliberately not used,
 *  because its logs can hold prompts (D6). */
async function callWorkersAI(
  model: string,
  call: { prompt: string; body: string },
): Promise<ModelAnswer> {
  const account = required(CF_ACCOUNT);
  const token = required(CF_TOKEN);

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`,
    {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: call.prompt },
          { role: "user", content: call.body },
        ],
        // Output tokens cost three times input on this model, and D9 allows up
        // to three tiered items, so this cap is the main lever on throughput.
        max_tokens: Number(Deno.env.get("CURATOR_MAX_TOKENS") || 1200),
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    },
  );

  if (response.status === 410) {
    // What happened on 20 November: Cloudflare retired 24 models, this one
    // among them. The message says what to do rather than leaving a bare 410
    // in the logs.
    throw new Error(
      `${model} has been retired by Cloudflare (410). Set CF_MODEL to a live model and ` +
        "re-run the comparison check (AC17) before publishing again.",
    );
  }
  if (!response.ok) {
    throw new Error(`Workers AI returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }

  const payload = await response.json();
  const text: string = payload?.result?.response ?? "";
  const usage = payload?.result?.usage ?? {};

  // The model has no JSON mode (D5), so its answer may carry prose around the
  // object. Take the outermost braces and let the schema check do the rest.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let json: Curation;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch {
    json = { source_item_id: "", outcome: "flagged", reason: "unparseable", items: [] } as Curation;
  }

  return {
    json,
    // Billed from what the response reports, not from an estimate (D7).
    tokensIn: Number(usage.prompt_tokens ?? 0),
    tokensOut: Number(usage.completion_tokens ?? 0),
  };
}

export async function serveWithDatabaseDeps(
  runBatch: (deps: CuratorDeps) => Promise<void>,
): Promise<void> {
  const sql = postgres(required(DB_URL), { max: 2, prepare: false });

  Deno.serve(async () => {
    const began = Date.now();
    const config = settings();

    const deps: CuratorDeps = {
      settings: config,
      now: () => Date.now() - began,
      deadline: BATCH_DEADLINE_MS,

      async take(n) {
        const rows = await sql<{ msg_id: number; message: { private_item_id: string } }[]>`
          select msg_id, message from pgmq.read('brain_curation', 120, ${n})
        `;
        if (!rows.length) return [];

        const ids = rows.map((r) => r.message.private_item_id);
        const items = await sql<QueuedItem[]>`
          select id as private_item_id, source, kind, title, body
          from brain_private.items where id = any(${ids})
        `;
        const byId = new Map(items.map((i) => [i.private_item_id, i]));
        return rows
          .filter((r) => byId.has(r.message.private_item_id))
          .map((r) => ({ ...byId.get(r.message.private_item_id)!, msg_id: r.msg_id }));
      },

      callModel: (call) => callWorkersAI(config.model, call),

      async record(curation: Curation, items: CuratedItem[]) {
        // One transaction per source item (AC9). A half-written item would
        // look curated while having neither a team item nor a flag, which is
        // the one state nothing downstream would ever surface.
        await sql.begin(async (tx) => {
          await tx`
            insert into brain.outcomes (private_item_id, outcome, reason, model)
            values (${curation.source_item_id}, ${curation.outcome}, ${curation.reason}, ${config.model})
          `;

          if (curation.outcome === "flagged") {
            await tx`
              insert into brain.flags (private_item_id, flag_reason)
              values (${curation.source_item_id}, ${curation.flag_reason ?? curation.reason})
            `;
          }

          for (const item of items) {
            await tx`
              insert into brain.items
                (tier, kind, title, body, status, source_ref, left_out, private_item_id)
              values
                (${item.tier}, ${item.kind}, ${item.title}, ${item.body}, ${item.status},
                 ${item.source_ref ?? null}, ${item.left_out}, ${curation.source_item_id})
            `;
          }

          // The queue message is deleted inside the same transaction, so an
          // item is never both recorded and still queued.
          await tx`select pgmq.delete('brain_curation', ${curation.source_item_id}::bigint)`;
        });
      },

      async requeue(msgId: number) {
        // Visible again immediately: the next cron tick picks it up.
        await sql`select pgmq.set_vt('brain_curation', ${msgId}, 0)`;
      },

      async openRun(row) {
        const [created] = await sql`
          insert into brain.runs (kind, model, status)
          values (${String(row.kind)}, ${String(row.model ?? "")}, 'running')
          returning id
        `;
        return created.id as string;
      },

      async closeRun(id, row) {
        await sql`
          update brain.runs set
            status = ${String(row.status)},
            items_taken = ${Number(row.items_taken ?? 0)},
            items_done = ${Number(row.items_done ?? 0)},
            neurons = ${Number(row.neurons ?? 0)},
            model = ${String(row.model ?? "")},
            finished_at = now()
          where id = ${id}
        `;
      },

      async neuronsSpentToday() {
        const [row] = await sql<{ total: number }[]>`
          select coalesce(sum(neurons), 0)::int as total from brain.runs
          where kind = 'curate' and started_at >= date_trunc('day', now() at time zone 'utc')
        `;
        return row.total;
      },

      async writeDigest() {
        // The digest's shape is contract/digest.schema.json, fixed in slice 0:
        // this function writes it and `brain digest` reads it, so neither owns
        // the format.
        await sql`
          insert into brain_private.digests (day, digest)
          select current_date, jsonb_build_object(
            'day', current_date::text,
            'outcomes', jsonb_build_object(
              'published', count(*) filter (where outcome = 'published'),
              'withheld',  count(*) filter (where outcome = 'withheld'),
              'flagged',   count(*) filter (where outcome = 'flagged')),
            'tiers', coalesce((
              select jsonb_object_agg(tier::text, n) from (
                select tier, count(*) as n from brain.items
                where created_at >= date_trunc('day', now() at time zone 'utc')
                group by tier) t), '{}'::jsonb),
            'neurons', jsonb_build_object(
              'spent', (select coalesce(sum(neurons), 0) from brain.runs
                        where kind = 'curate'
                          and started_at >= date_trunc('day', now() at time zone 'utc')),
              'cap', ${config.dailyNeuronCap}::int,
              'per_item', case when count(*) = 0 then 0
                          else round((select coalesce(sum(neurons), 0) from brain.runs
                                      where kind = 'curate'
                                        and started_at >= date_trunc('day', now() at time zone 'utc'))
                                     / count(*)::numeric, 1) end,
              'model', ${config.model}::text),
            'flags_waiting', (select count(*) from brain.flags where resolved_at is null),
            'left_out', coalesce((
              select jsonb_object_agg(category, n) from (
                select unnest(left_out) as category, count(*) as n from brain.items
                where created_at >= date_trunc('day', now() at time zone 'utc')
                group by 1) l), '{}'::jsonb),
            'waiting_for_budget', (select count(*) from pgmq.metrics('brain_curation')),
            'publish_enabled', ${config.publishEnabled},
            'sources', coalesce((
              select jsonb_agg(jsonb_build_object(
                'source', source, 'watermark', watermark, 'last_run_at', last_run_at))
              from brain_private.sources), '[]'::jsonb))
          from brain.outcomes
          where created_at >= date_trunc('day', now() at time zone 'utc')
          on conflict (day) do update
            set digest = excluded.digest, updated_at = now()
        `;
      },
    };

    try {
      await runBatch(deps);
      return new Response("ok");
    } catch (error) {
      // Nobody is listening for this: pg_net gave up long ago. The run row and
      // the log are the record (D8).
      console.error("brain-curator: batch failed", error);
      return new Response("failed", { status: 500 });
    }
  });
}

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
import { type CuratorDeps, type QueuedItem, type RecordExtra, triggerAllowed } from "./index.ts";
import { callWorkersAI } from "./model.ts";

const DB_URL = "BRAIN_CURATOR_DB_URL";
const TRIGGER_TOKEN = "BRAIN_CURATOR_TOKEN";

// The free plan allows 150s of wall clock. The batch hands back what is left
// well before that, so a requeue is never racing the platform's own cut-off.
const BATCH_DEADLINE_MS = 110_000;

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

export async function serveWithDatabaseDeps(
  runBatch: (deps: CuratorDeps) => Promise<void>,
): Promise<void> {
  const sql = postgres(required(DB_URL), { max: 2, prepare: false });
  // Refuse to start without it, as brain-ingest does with its own token.
  const triggerToken = required(TRIGGER_TOKEN);

  Deno.serve(async (request) => {
    if (!triggerAllowed(request, triggerToken)) {
      // No detail, and no run row: an unauthorised call must cost nothing.
      return new Response("unauthorised", { status: 401 });
    }
    const began = Date.now();
    const config = settings();

    const deps: CuratorDeps = {
      settings: config,
      now: () => Date.now() - began,
      deadline: BATCH_DEADLINE_MS,

      async take(n) {
        const rows = await sql<
          { msg_id: number; message: { private_item_id: string; failures?: number } }[]
        >`
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
          .map((r) => ({
            ...byId.get(r.message.private_item_id)!,
            msg_id: r.msg_id,
            failures: Number(r.message.failures ?? 0),
          }));
      },

      callModel: (call) => callWorkersAI(config.model, call),

      async record(curation: Curation, items: CuratedItem[], msgId: number, extra: RecordExtra) {
        // One transaction per source item (AC9). A half-written item would
        // look curated while having neither a team item nor a flag, which is
        // the one state nothing downstream would ever surface.
        await sql.begin(async (tx) => {
          await tx`
            insert into brain.outcomes (private_item_id, outcome, reason, model, attempt)
            values (${curation.source_item_id}, ${curation.outcome}, ${curation.reason},
                    ${config.model}, ${extra.attempt})
          `;

          if (extra.screenHits.length) {
            // AC20: what this third screen caught is added to the item's hit
            // list. The body is left as it is; the model saw the redacted copy.
            await tx`
              update brain_private.items
              set screen_hits = screen_hits || ${tx.json(extra.screenHits as unknown as Parameters<typeof tx.json>[0])}::jsonb,
                  updated_at = now()
              where id = ${curation.source_item_id}
            `;
          }

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
          await tx`select pgmq.delete('brain_curation', ${msgId}::bigint)`;
        });
      },

      async requeue(msgId: number) {
        // Visible again immediately: the next cron tick picks it up.
        await sql`select pgmq.set_vt('brain_curation', ${msgId}, 0)`;
      },

      async retryLater(item: QueuedItem) {
        // A pgmq message cannot be edited, so the failure count travels in a
        // fresh message. Send and delete together, so the item is never both
        // queued twice and never lost.
        await sql.begin(async (tx) => {
          await tx`select pgmq.send('brain_curation', ${
            tx.json({ private_item_id: item.private_item_id, failures: (item.failures ?? 0) + 1 })
          })`;
          await tx`select pgmq.delete('brain_curation', ${item.msg_id}::bigint)`;
        });
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
            'waiting_for_budget', (select queue_length from pgmq.metrics('brain_curation')),
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

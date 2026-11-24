// The database half of brain-ingest, kept out of index.ts so the handler can
// be tested without a database and without a network (the tests pass their own
// Deps).
//
// It connects as `brain_intake`, which may write brain_private.items,
// intake_review, sources and the queue, and nothing else — not the team layer,
// not em_tracker (D2). The service key is never used anywhere in the brain.
//
// One transaction per batch (D12): the whole batch lands or none of it does,
// so a failure part-way cannot leave items stored but unqueued, which would
// make them invisible to the curator for good.

import postgres from "npm:postgres@3";
import type { Deps, ScopeRule } from "./index.ts";
import type { InboxItem } from "../_shared/types.ts";

const DB_URL = "BRAIN_INTAKE_DB_URL";
const TOKEN = "BRAIN_INGEST_TOKEN";

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set; see the plan's Environment configuration`);
  return value;
}

export async function serveWithDatabaseDeps(
  handler: (request: Request, deps: Deps) => Promise<Response>,
): Promise<void> {
  const sql = postgres(required(DB_URL), { max: 2, prepare: false });
  const token = required(TOKEN);

  Deno.serve(async (request) => {
    // A read of the watermarks needs no transaction, and wrapping it in one
    // would hold a connection open for the cheapest call the endpoint serves.
    if (request.method === "GET") {
      return handler(request, { ...bind(sql), token, scopeRules: [] });
    }

    try {
      return await sql.begin(async (tx) => {
        const rules = await tx<ScopeRule[]>`
          select source, project, in_scope from brain_private.scope_rules
        `;
        return handler(request, { ...bind(tx), token, scopeRules: rules });
      });
    } catch (error) {
      console.error("brain-ingest: batch rolled back", error);
      return new Response(JSON.stringify({ error: "the batch was not stored" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  });
}

// deno-lint-ignore no-explicit-any
function bind(sql: any): Omit<Deps, "token" | "scopeRules"> {
  return {
    async upsert(item: InboxItem) {
      // The hash decides whether this is new work. An item whose body is
      // unchanged is not re-queued, which is what keeps eight gathers a day
      // costing little more than one (D8).
      const [row] = await sql`
        insert into brain_private.items
          (source, source_id, kind, title, body, url, occurred_at, project,
           body_sha256, screen_hits, patterns_version)
        values
          (${item.source}, ${item.source_id}, ${item.kind}, ${item.title ?? null},
           ${item.body}, ${item.url ?? null}, ${item.occurred_at ?? null},
           ${item.project ?? null}, ${item.body_sha256 ?? ""},
           ${sql.json(item.screened?.hits ?? [])}, ${item.screened?.patterns_version ?? null})
        on conflict (source, source_id) do update set
          kind = excluded.kind,
          title = excluded.title,
          body = excluded.body,
          url = excluded.url,
          occurred_at = excluded.occurred_at,
          project = excluded.project,
          body_sha256 = excluded.body_sha256,
          screen_hits = excluded.screen_hits,
          patterns_version = excluded.patterns_version,
          updated_at = now()
        returning id, (xmax = 0) as inserted,
                  (brain_private.items.body_sha256 is distinct from excluded.body_sha256) as changed
      `;

      const changed = row.inserted || row.changed;
      if (changed) {
        await sql`select pgmq.send('brain_curation', ${sql.json({ private_item_id: row.id })})`;
      }
      return { inserted: row.inserted, changed };
    },

    async sendToReview(item: InboxItem) {
      await sql`
        insert into brain_private.intake_review (source, source_id, payload, reason)
        values (${item.source}, ${item.source_id}, ${sql.json(item)},
                ${item.project ? `project ${item.project} matches no rule` : "no project set"})
        on conflict (source, source_id) do nothing
      `;
    },

    async setWatermark(source: string, at: string) {
      await sql`
        insert into brain_private.sources (source, watermark, last_run_at, updated_at)
        values (${source}, ${at}, now(), now())
        on conflict (source) do update set
          -- Never move a watermark backwards: a late batch from an earlier run
          -- would otherwise reopen a window already gathered.
          watermark = greatest(brain_private.sources.watermark, excluded.watermark),
          last_run_at = now(),
          updated_at = now()
      `;
    },

    async readWatermarks() {
      return await sql`select source, watermark from brain_private.sources order by source`;
    },
  };
}

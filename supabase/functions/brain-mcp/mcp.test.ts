// AC14 and AC15 — the MCP service.
//
// Every query runs as the signed-in caller, so the tier rules are enforced by
// Postgres and not by this function (D4). These tests exist because that is
// easy to get wrong in one place: a tool that reaches for the service key, or
// builds its own query, silently opts out of the protection.
//
// Slice T owns this file. It fails until slice 5 exists.

import { assertEquals } from "../_shared/testing.ts";
import { callTool, type McpDeps } from "./index.ts";

const DEVELOPER = "00000000-0000-0000-0000-000000000003"; // tier 3
const OWNER = "00000000-0000-0000-0000-00000000000f"; // tier 1, is_owner

const ROWS = [
  { id: "a1", tier: 1, kind: "decision", title: "Governance item", body: "The commercial reason for the slip." },
  { id: "a2", tier: 2, kind: "status", title: "Leads item", body: "Allocation across the two squads." },
  { id: "a3", tier: 3, kind: "date", title: "Delivery item", body: "Release moved to 5 Dec." },
];

/** Stands in for PostgREST with the caller's own JWT: it filters exactly as
 *  the RLS policy does, so a tool that bypasses it shows up as a test failure
 *  rather than as a quiet leak. */
function deps(userId: string) {
  const log: Record<string, unknown>[] = [];
  const d: McpDeps = {
    userId,
    tierOf: (uid) => Promise.resolve(uid === OWNER ? 1 : 3),
    query: async (opts) => {
      const tier = await d.tierOf(userId);
      // A caller with no membership row reads nothing — the same thing the
      // migration's coalesce(..., false) does (AC7).
      if (tier === null) return [];
      return ROWS.filter((r) => tier <= r.tier)
        .filter((r) => !opts.id || r.id === opts.id)
        .filter((r) => !opts.query || `${r.title} ${r.body}`.toLowerCase().includes(opts.query.toLowerCase()));
    },
    logAccess: (row) => {
      log.push(row);
      return Promise.resolve();
    },
    usesServiceKey: false,
  };
  return { deps: d, log };
}

Deno.test("mcp_tools_respect_tier: search", async () => {
  // AC14
  const { deps: d } = deps(DEVELOPER);
  const result = await callTool("search", { query: "item" }, d);

  const titles = result.items.map((i: { title: string }) => i.title);
  assertEquals(titles, ["Delivery item"]);
});

Deno.test("mcp_tools_respect_tier: get by id", async () => {
  // AC14 — the direct-object-reference case. A tier-3 caller who has somehow
  // learned a tier-1 id must get nothing back.
  const { deps: d } = deps(DEVELOPER);
  const result = await callTool("get", { id: "a1" }, d);

  assertEquals(result.items.length, 0);
});

Deno.test("mcp_tools_respect_tier: decisions and timeline", async () => {
  // AC14 — every tool, not just search. Each one is a separate query, so each
  // one is a separate chance to forget.
  const { deps: d } = deps(DEVELOPER);

  // Items come back with a tier *label* rather than a number, so this checks
  // the labels: a developer must never see one marked governance or leads.
  for (const tool of ["decisions", "timeline"]) {
    const result = await callTool(tool, { topic: "item" }, d);
    const tiers = result.items.map((i: { tier: string }) => i.tier);
    assertEquals(
      tiers.every((t: string) => t === "delivery"),
      true,
      `${tool} returned an item above the caller's tier: ${tiers.join(", ")}`,
    );
  }
});

Deno.test("mcp_tools_respect_tier: nothing hints that a hidden item exists", async () => {
  // DESIGN, Access tiers: "hidden, not blocked". A count, a gap in numbering or
  // a "you do not have access" message would each tell a developer that
  // something exists at a tier above them, which is itself information.
  const { deps: d } = deps(DEVELOPER);
  const result = await callTool("search", { query: "item" }, d);

  const blob = JSON.stringify(result).toLowerCase();
  for (const leak of ["governance", "leads item", "forbidden", "not permitted", "restricted"]) {
    assertEquals(blob.includes(leak), false, `the answer mentioned ${leak}`);
  }
  assertEquals("total" in result, false, "a total would count rows the caller cannot see");
});

Deno.test("mcp_tools_respect_tier: the owner sees every tier", async () => {
  // AC14 — the filter is a ladder, not a wall.
  const { deps: d } = deps(OWNER);
  const result = await callTool("search", { query: "item" }, d);

  assertEquals(result.items.length, 3);
});

Deno.test("mcp_access_log_has_no_content", async () => {
  // AC15 — who asked, which tool, how many rows, when. Not what came back,
  // and not what was asked: a search term can carry a person's name.
  const { deps: d, log } = deps(DEVELOPER);
  await callTool("search", { query: "Release" }, d);

  assertEquals(log.length, 1);
  const row = log[0];

  assertEquals(row.user_id, DEVELOPER);
  assertEquals(row.tool, "search");
  assertEquals(row.row_count, 1);

  const blob = JSON.stringify(row);
  assertEquals(blob.includes("Release"), false, "the query text itself must not be stored");
  assertEquals(blob.includes("5 Dec"), false, "no result body is stored");
  assertEquals(typeof row.query_sha256, "string");
  assertEquals((row.query_sha256 as string).length, 64, "the query is kept as a hash, or not at all");
});

Deno.test("mcp_access_log_has_no_content: a search for a person is logged, and empty", async () => {
  // The case the hash is for. Searching someone's name returns nothing,
  // because no team item carries it — but the search itself happened, and an
  // audit should see that it did without the log repeating the name.
  const { deps: d, log } = deps(DEVELOPER);
  await callTool("search", { query: "Priya's phone number" }, d);

  assertEquals(log.length, 1);
  assertEquals(log[0].row_count, 0);
  assertEquals(JSON.stringify(log[0]).includes("Priya"), false);
});

Deno.test("mcp_access_log_has_no_content: a tool that returns nothing is still logged", async () => {
  // Probing for a tier-1 id by guessing must leave the same trace as any
  // other call.
  const { deps: d, log } = deps(DEVELOPER);
  await callTool("get", { id: "a1" }, d);

  assertEquals(log.length, 1);
  assertEquals(log[0].row_count, 0);
});

Deno.test("the MCP service never holds the service key", async () => {
  // D4 — it queries as the caller. With the service key it would return rows
  // the database would have refused, and RLS would protect nothing.
  const { deps: d } = deps(DEVELOPER);

  assertEquals(d.usesServiceKey, false);
  assertEquals(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), undefined);
});

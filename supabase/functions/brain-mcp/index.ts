// brain-mcp — how Claude reaches the team layer.
//
// The thing to understand about this function is how little it does. Every
// query runs as the signed-in caller, so the tier rules are enforced by
// Postgres, not here (D4). This file picks a tool, builds a query, hands it to
// a connection carrying the caller's own token, and writes an audit line. It
// holds no service key, and a bug in it cannot return a row the database would
// have refused that person.
//
// That is the whole security design, and it is why the tests check the shape
// of what comes back rather than the filtering: the filtering is the
// migration's job, and supabase/tests/00_brain_items_tier_visibility.sql is
// where it is proved.
//
// Slice 5 owns this file.

export interface QueryOptions {
  id?: string;
  query?: string;
  kinds?: string[];
  status?: string;
  since?: string;
  order?: "relevance" | "occurred_at";
  limit?: number;
}

export interface TeamItem {
  id: string;
  tier: number;
  kind: string;
  title: string;
  body: string;
  source_ref?: string | null;
  occurred_at?: string | null;
}

export interface McpDeps {
  userId: string;
  tierOf(userId: string): Promise<number | null>;
  query(options: QueryOptions): Promise<TeamItem[]>;
  logAccess(row: Record<string, unknown>): Promise<void>;
  usesServiceKey: boolean;
}

export const TIER_LABELS: Record<number, string> = { 1: "governance", 2: "leads", 3: "delivery" };

const DEFAULT_LIMIT = 20;
const SNIPPET = 300;

export const TOOLS = [
  {
    name: "search",
    description:
      "Search the MyTT brain. Returns only what your tier allows; it never says that anything else exists.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for." },
        kinds: { type: "array", items: { type: "string" } },
        since: { type: "string", description: "ISO date; only items on or after it." },
      },
      required: ["query"],
    },
  },
  {
    name: "get",
    description: "One item by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "decisions",
    description: "The decisions register. Agreed decisions by default; pass status for others.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        status: { type: "string", enum: ["proposed", "agreed", "superseded"] },
      },
    },
  },
  {
    name: "timeline",
    description: "Everything about a topic, in date order.",
    inputSchema: {
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
    },
  },
] as const;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function present(item: TeamItem) {
  return {
    id: item.id,
    title: item.title,
    // A snippet rather than the whole body: an answer is something to read in
    // a conversation, and `get` is there when the whole thing is wanted.
    snippet: item.body.length > SNIPPET ? item.body.slice(0, SNIPPET) + "…" : item.body,
    tier: TIER_LABELS[item.tier] ?? String(item.tier),
    source_ref: item.source_ref ?? null,
    occurred_at: item.occurred_at ?? null,
  };
}

function optionsFor(tool: string, args: Record<string, unknown>): QueryOptions {
  switch (tool) {
    case "search":
      return {
        query: args.query ? String(args.query) : undefined,
        kinds: Array.isArray(args.kinds) ? args.kinds.map(String) : undefined,
        since: args.since ? String(args.since) : undefined,
        limit: DEFAULT_LIMIT,
      };
    case "get":
      return { id: String(args.id ?? "") };
    case "decisions":
      return {
        query: args.topic ? String(args.topic) : undefined,
        kinds: ["decision"],
        // Agreed by default: a proposed decision read as settled is the
        // mistake the whole register exists to prevent.
        status: args.status ? String(args.status) : "agreed",
        limit: DEFAULT_LIMIT,
      };
    case "timeline":
      return {
        query: args.topic ? String(args.topic) : undefined,
        order: "occurred_at",
        limit: 100,
      };
    default:
      throw new Error(`unknown tool: ${tool}`);
  }
}

/** What the audit line is allowed to carry (AC15). A search term can be a
 *  person's name, so it is hashed; a hash still tells an audit that the same
 *  search ran twice, without repeating the name. */
async function auditLine(
  deps: McpDeps,
  tool: string,
  options: QueryOptions,
  rowCount: number,
): Promise<Record<string, unknown>> {
  const subject = options.query ?? options.id ?? "";
  return {
    user_id: deps.userId,
    tool,
    row_count: rowCount,
    query_sha256: subject ? await sha256Hex(subject) : null,
  };
}

export async function callTool(
  tool: string,
  args: Record<string, unknown>,
  deps: McpDeps,
): Promise<{ items: ReturnType<typeof present>[] }> {
  const options = optionsFor(tool, args);
  const rows = await deps.query(options);

  await deps.logAccess(await auditLine(deps, tool, options, rows.length));

  // No total, no "N results hidden", no error for a row that exists at a tier
  // the caller cannot see. An item they may not read must be indistinguishable
  // from one that does not exist — a count would itself be information
  // (DESIGN, "hidden, not blocked").
  return { items: rows.map(present) };
}

// --- MCP over HTTP ---------------------------------------------------------

/** Enough of MCP to serve four read-only tools. Written out rather than taken
 *  from a library because jsr.io and npm are not reachable from every
 *  environment this runs in, and because the surface is this small. */
export async function handleRpc(
  body: { id?: unknown; method?: string; params?: Record<string, unknown> },
  deps: McpDeps,
): Promise<Record<string, unknown>> {
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: body.id ?? null, result });
  const fail = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id: body.id ?? null,
    error: { code, message },
  });

  switch (body.method) {
    case "initialize":
      return reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mytt-brain", version: "0.1.0" },
      });

    case "tools/list":
      return reply({ tools: TOOLS });

    case "tools/call": {
      const name = String(body.params?.name ?? "");
      const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
      if (!TOOLS.some((t) => t.name === name)) return fail(-32601, `unknown tool: ${name}`);

      // A caller with no membership row reads nothing, and is told nothing
      // about why. The database would refuse them anyway (AC7); this saves a
      // round trip and keeps the message identical to an empty result.
      const tier = await deps.tierOf(deps.userId);
      if (tier === null) {
        await deps.logAccess(await auditLine(deps, name, optionsFor(name, args), 0));
        return reply({ content: [{ type: "text", text: JSON.stringify({ items: [] }) }] });
      }

      const result = await callTool(name, args, deps);
      return reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
    }

    case "ping":
      return reply({});

    default:
      return fail(-32601, `unknown method: ${body.method}`);
  }
}

if (import.meta.main) {
  const { serveWithCallerDeps } = await import("./deps.ts");
  await serveWithCallerDeps(handleRpc);
}

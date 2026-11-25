// The connection half of brain-mcp: the caller's own token, and nothing else.
//
// Every query goes out over PostgREST carrying the JWT the caller arrived
// with, so Postgres decides what comes back. This function never holds the
// service key — with it, every policy in the migration would be bypassed and
// the tier ladder would protect nothing (D4).
//
// Sign-in is Supabase Auth's OAuth server. An MCP client that meets a 401 here
// is told where the authorisation server is, in the form the spec expects, and
// does the rest itself.
//
// Slice 5 owns this file.

import type { McpDeps, QueryOptions, TeamItem } from "./index.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

const SELECT = "id,tier,kind,title,body,source_ref,occurred_at";

function restHeaders(token: string, schema = "brain", write = false) {
  const headers: Record<string, string> = {
    apikey: ANON_KEY,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  headers[write ? "Content-Profile" : "Accept-Profile"] = schema;
  return headers;
}

function buildParams(options: QueryOptions): URLSearchParams {
  const params = new URLSearchParams({ select: SELECT });

  if (options.id) {
    params.set("id", `eq.${options.id}`);
    return params;
  }

  // The search term itself is NOT set here: a query string ends up in the
  // platform's request logs. It goes to brain.search_items in the request
  // body (see query() below), and these filters apply to that function's rows.
  if (options.kinds?.length) params.set("kind", `in.(${options.kinds.join(",")})`);
  if (options.status) params.set("status", `eq.${options.status}`);
  if (options.since) params.set("occurred_at", `gte.${options.since}`);

  // Phase 0 orders by date rather than by rank: ranking through PostgREST
  // needs an RPC, and full-text search over a few hundred items finds things
  // without it. Worth revisiting when the brain is bigger.
  params.set("order", options.order === "occurred_at" ? "occurred_at.asc" : "occurred_at.desc");
  params.set("limit", String(options.limit ?? 20));
  return params;
}

export function depsForToken(token: string, userId: string): McpDeps {
  return {
    userId,
    usesServiceKey: false,

    async tierOf(uid: string): Promise<number | null> {
      // A member may read their own row, and only their own (the migration's
      // member_self policy), so this needs no elevated access.
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/members?select=tier&user_id=eq.${uid}`,
        { headers: restHeaders(token) },
      );
      if (!response.ok) return null;
      const rows = await response.json();
      return rows.length ? Number(rows[0].tier) : null;
    },

    async query(options: QueryOptions): Promise<TeamItem[]> {
      const params = buildParams(options);
      // A search goes through brain.search_items, a SECURITY INVOKER RPC, so
      // the term travels in the body. websearch_to_tsquery inside it: quoted
      // phrases and OR behave as a search box suggests, and a stray operator
      // cannot become a syntax error. The tier ladder applies as for a select.
      const response = options.query && !options.id
        ? await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_items?${params}`, {
          method: "POST",
          headers: restHeaders(token, "brain", true),
          body: JSON.stringify({ q: options.query }),
        })
        : await fetch(`${SUPABASE_URL}/rest/v1/items?${params}`, { headers: restHeaders(token) });
      if (!response.ok) {
        // Including the caller's own 401 or 403: an empty result is the right
        // answer either way, because the service never distinguishes "you may
        // not see this" from "there is nothing".
        console.error("brain-mcp: query refused", response.status);
        return [];
      }
      return await response.json();
    },

    async logAccess(row: Record<string, unknown>) {
      // Written as the caller, under the caller_appends policy: they may add
      // a line about themselves and read none of it back. A failure here must
      // not fail the call — a lost audit line is bad, a search that breaks
      // because of one is worse.
      const response = await fetch(`${SUPABASE_URL}/rest/v1/access_log`, {
        method: "POST",
        headers: { ...restHeaders(token, "brain", true), Prefer: "return=minimal" },
        body: JSON.stringify([row]),
      });
      if (!response.ok) console.error("brain-mcp: the access log was not written", response.status);
    },
  };
}

/** The claims, read without verifying: Supabase verifies the token on every
 *  REST call, and a forged `sub` here would only mislabel an audit line that
 *  the database then refuses to act on. Nothing is authorised on this basis. */
function subjectOf(token: string): string | null {
  try {
    const [, payload] = token.split(".");
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json.sub === "string" ? json.sub : null;
  } catch {
    return null;
  }
}

export async function serveWithCallerDeps(
  handleRpc: (body: Record<string, unknown>, deps: McpDeps) => Promise<Record<string, unknown>>,
): Promise<void> {
  const resourceMetadata = `${SUPABASE_URL}/functions/v1/brain-mcp/.well-known/oauth-protected-resource`;

  Deno.serve(async (request) => {
    const url = new URL(request.url);

    // How an MCP client finds the authorisation server (RFC 9728). Without
    // this it has a 401 and nowhere to go.
    if (url.pathname.endsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({
        resource: `${SUPABASE_URL}/functions/v1/brain-mcp`,
        authorization_servers: [`${SUPABASE_URL}/auth/v1`],
        scopes_supported: ["openid", "email"],
        bearer_methods_supported: ["header"],
      });
    }

    const auth = request.headers.get("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const userId = token ? subjectOf(token) : null;

    if (!token || !userId) {
      return new Response(JSON.stringify({ error: "sign in required" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadata}"`,
        },
      });
    }

    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }

    try {
      return Response.json(await handleRpc(body, depsForToken(token, userId)));
    } catch (error) {
      console.error("brain-mcp:", error);
      return Response.json({
        jsonrpc: "2.0",
        id: body.id ?? null,
        error: { code: -32603, message: "internal error" },
      });
    }
  });
}

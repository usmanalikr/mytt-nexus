// The contract, as the Edge Functions see it.
//
// Slice 0 fixes these. brain-ingest (slice 1), brain-curator (slice 3) and
// brain-mcp (slice 5) all import from here, so the three functions and the
// Python CLI cannot drift apart.
//
// The JSON files in contract/ are the source of truth. These types name the
// same shapes; validate against the schemas, not against TypeScript.

export type Category = "secret" | "personal" | "money" | "never_published";
export type Outcome = "published" | "withheld" | "flagged";
export type Tier = 1 | 2 | 3;
export type ItemStatus = "proposed" | "agreed" | "superseded" | "n/a";

export type LeftOut =
  | "commercial"
  | "people"
  | "personal_data"
  | "credentials"
  | "client_relationship"
  | "security_detail"
  | "off_topic";

// --- the screen -------------------------------------------------------------

/** One entry of contract/patterns.json. Flags are given separately because
 *  Python has no inline-flag syntax that JavaScript also accepts. */
export interface PatternRule {
  id: string;
  category?: Category;
  pattern: string;
  flags?: string;
  replacement?: string;
  note?: string;
}

export interface Patterns {
  version: string;
  note?: string;
  /** Applied first; its matches are protected from every rule below. */
  allow: PatternRule[];
  rules: PatternRule[];
  never_published: string[];
}

export interface ScreenHit {
  pattern_id: string;
  category: Category;
  count: number;
}

export interface ScreenResult {
  body: string;
  hits: ScreenHit[];
  withheld: boolean;
  patterns_version: string;
}

// --- ingest -----------------------------------------------------------------

export interface InboxItem {
  source: string;
  source_id: string;
  kind: string;
  body: string;
  title?: string | null;
  url?: string | null;
  occurred_at?: string | null;
  project?: string | null;
  body_sha256?: string;
  screened: {
    patterns_version: string;
    hits: ScreenHit[];
    withheld?: boolean;
  };
}

export interface WatermarkUpdate {
  source: string;
  watermark: string;
  last_run_at?: string;
}

export interface IngestBatch {
  batch_id: string;
  gathered_at: string;
  items: InboxItem[];
  watermarks: WatermarkUpdate[];
}

export interface IngestResponse {
  accepted: number;
  queued: number;
  sent_to_review: number;
  rejected: number;
  /** Never-published sources, or items the gather already withheld: dropped. */
  withheld: number;
}

/** The ingest token's header. Never `Authorization`: the cloud environment
 *  attaches network secrets by host, and the project host also serves the REST
 *  API and Auth, which other callers reach with their own bearer token (D12). */
export const INGEST_TOKEN_HEADER = "X-Brain-Ingest-Token";

/** The curator's trigger token. pg_cron sends it, read from Supabase Vault
 *  (`brain_curator_token`); the function compares it with the Edge Function
 *  secret BRAIN_CURATOR_TOKEN. The function is deployed without the JWT check
 *  so pg_net can reach it, so this header is the only thing standing between
 *  its URL and the neuron budget. */
export const CURATOR_TOKEN_HEADER = "X-Brain-Curator-Token";

/** A batch above this is refused; the endpoint is public by design. */
export const INGEST_MAX_BODY_BYTES = 1_048_576;

// --- curation ---------------------------------------------------------------

export interface CuratedItem {
  tier: Tier;
  kind: string;
  title: string;
  body: string;
  status: ItemStatus;
  left_out: LeftOut[];
  source_ref?: string;
}

export interface Curation {
  source_item_id: string;
  outcome: Outcome;
  reason: string;
  flag_reason?: string | null;
  /** Empty unless the outcome is "published"; at most one entry per tier (D9). */
  items: CuratedItem[];
}

// --- the digest -------------------------------------------------------------

export interface Digest {
  day: string;
  outcomes: { published: number; withheld: number; flagged: number };
  tiers: Partial<Record<"1" | "2" | "3", number>>;
  neurons: { spent: number; cap: number; per_item: number; model?: string };
  new_items?: { tier: number; title: string }[];
  flags_waiting: number;
  /** Category to count. Categories, never content. */
  left_out: Record<string, number>;
  waiting_for_budget: number;
  publish_enabled?: boolean;
  sources: { source: string; watermark: string | null; last_run_at?: string | null }[];
}

// --- the curator's settings -------------------------------------------------

/** Edge Function secrets, so none of these needs a redeploy to change (D5, D8, D10). */
export interface CuratorSettings {
  /** Cloudflare retired 24 models on two weeks' notice; this is why it is a secret. */
  model: string;
  batchSize: number;
  /** Off until the comparison check has passed. While off, every item is flagged (AC22). */
  publishEnabled: boolean;
  /** The guard stops here, leaving headroom under Cloudflare's 10,000 a day (D7). */
  dailyNeuronCap: number;
}

export const CURATOR_DEFAULTS: CuratorSettings = {
  model: "@cf/google/gemma-4-26b-a4b-it",
  batchSize: 3,
  publishEnabled: false,
  dailyNeuronCap: 9_000,
};

/** Neurons per million tokens, for the budget guard. Billed from the token
 *  counts Workers AI returns, not estimated; these are only used to decide
 *  whether the next item fits in what is left of the day (D7). */
export const NEURON_RATES: Record<string, { in: number; out: number }> = {
  "@cf/google/gemma-4-26b-a4b-it": { in: 9_091, out: 27_273 },
  "@cf/openai/gpt-oss-20b": { in: 18_182, out: 27_273 },
};

export function neuronsFor(model: string, tokensIn: number, tokensOut: number): number {
  const rate = NEURON_RATES[model];
  if (!rate) throw new Error(`no neuron rate known for ${model}; add it before using the model`);
  return Math.ceil((tokensIn * rate.in + tokensOut * rate.out) / 1_000_000);
}

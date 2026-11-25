// The screen, on the TypeScript side.
//
// The twin of brain/screen.py. Both read contract/patterns.json, and
// contract/screen-cases.json is what "the same behaviour" means for the two of
// them — supabase/functions/_shared/screen.test.ts and
// tests/test_screen_parity.py run the identical cases.
//
// The screen runs three times (D6): in the gather (Python), in brain-ingest and
// again in the curator before each model call. By the time text reaches this
// file it has usually been screened once already, so screening has to be
// idempotent: a second pass must not redact the first pass's markers.
//
// A redaction is permanent — brain_private holds screened text, not originals —
// so the allow pass, which holds ticket ids, versions and dates out of reach of
// every rule, matters as much as the redaction rules do.
//
// Slice 2 owns this file. It is shared by slices 1 and 3, so neither of those
// could own it: see the note on the digest's shape in the plan, which is the
// same problem.

// ./patterns.json is a copy of contract/patterns.json, placed here by
// scripts/prepare-functions.sh. It has to live inside supabase/ because
// `supabase functions deploy` uploads that directory and nothing above it,
// so an import reaching ../../../ escapes the bundle entirely.
// contract/ stays the source of truth; contract/check.py fails if this copy
// has drifted from it.
import patternsJson from "./patterns.json" with { type: "json" };
import type { Category, Patterns, PatternRule, ScreenHit, ScreenResult } from "./types.ts";

const patterns = patternsJson as unknown as Patterns;

// Carries no digits and no word characters, so no redaction rule can match one.
// A placeholder that looked like an id would be redacted and then restored as
// the marker, losing the ticket number it was protecting.
const SENTINEL = "\u0000";

function holdKey(n: number): string {
  const letters = String(n).split("").map((d) => String.fromCharCode(97 + Number(d))).join("");
  return SENTINEL + letters + SENTINEL;
}

function compile(rule: PatternRule): RegExp {
  const flags = rule.flags ?? "g";
  return new RegExp(rule.pattern, flags.includes("g") ? flags : flags + "g");
}

const ALLOW = patterns.allow.map((r) => ({ id: r.id, regex: compile(r) }));
const RULES = patterns.rules.map((r) => ({
  id: r.id,
  regex: compile(r),
  category: r.category as Category,
  replacement: r.replacement ?? "[redacted]",
}));
const NEVER_PUBLISHED = new Set(patterns.never_published);

/** AC6. A list, not a default: an unknown source is screened normally and
 *  reaches the curator, where the policy decides. */
export function isNeverPublished(source: string): boolean {
  return NEVER_PUBLISHED.has(source);
}

export function screenText(text: string): ScreenResult {
  if (!text) {
    return { body: "", hits: [], withheld: false, patterns_version: patterns.version };
  }

  const held = new Map<string, string>();
  let working = text;
  const hits: ScreenHit[] = [];

  const apply = (rule: (typeof RULES)[number]) => {
    rule.regex.lastIndex = 0;
    const count = [...working.matchAll(rule.regex)].length;
    if (count === 0) return;
    rule.regex.lastIndex = 0;
    working = working.replace(rule.regex, rule.replacement);
    hits.push({ pattern_id: rule.id, category: rule.category, count });
  };

  // Secrets first, on the raw text. Nothing the allow pass protects — a ticket
  // id, a date, a version — may shield part of a secret: "password=ADMIN-1234"
  // must not survive because ADMIN-1234 looks like a ticket.
  for (const rule of RULES) if (rule.category === "secret") apply(rule);

  // Hold aside everything the contract says must survive, longest first:
  // "v2.14.1" has to be taken before "2.14.1", or the shorter match would cut
  // the longer one in half.
  for (const rule of ALLOW) {
    rule.regex.lastIndex = 0;
    const found = [...new Set([...working.matchAll(rule.regex)].map((m) => m[0]))]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);

    for (const match of found) {
      if ([...held.values()].includes(match)) continue;
      const key = holdKey(held.size);
      held.set(key, match);
      working = working.split(match).join(key);
    }
  }

  for (const rule of RULES) if (rule.category !== "secret") apply(rule);

  for (const [key, value] of held) {
    working = working.split(key).join(value);
  }

  return { body: working, hits, withheld: false, patterns_version: patterns.version };
}

/** The hash is of the screened body, not the original: brain-ingest re-queues
 *  an item whose hash changed (AC1), and it only ever sees screened text. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const patternsVersion = patterns.version;

// The free model's half of the comparison check (AC17).
//
// It calls Workers AI with the same policy prefix and the same validation the
// curator uses, and writes eval/free.json. It touches no database at all: this
// is the "dry-run mode of the curator" the plan asks for, achieved by not
// giving it a database rather than by giving it a flag it might ignore.
//
//   deno run -A eval/curate.ts            # reads eval/sample.json
//
// Needs CF_ACCOUNT_ID and CF_API_TOKEN. CF_MODEL picks the model; the default
// is the one the curator would use.
//
// Slice 8 owns this file.

import { invalidCuration, policy } from "../supabase/functions/brain-curator/index.ts";
import { screenText } from "../supabase/functions/_shared/screen.ts";
import { CURATOR_DEFAULTS, neuronsFor } from "../supabase/functions/_shared/types.ts";

const MODEL = Deno.env.get("CF_MODEL") ?? CURATOR_DEFAULTS.model;
const ACCOUNT = Deno.env.get("CF_ACCOUNT_ID") ?? "";
const TOKEN = Deno.env.get("CF_API_TOKEN") ?? "";

if (!ACCOUNT || !TOKEN) {
  console.error("CF_ACCOUNT_ID and CF_API_TOKEN must be set. Nothing was called.");
  Deno.exit(1);
}

const sample = JSON.parse(await Deno.readTextFile("eval/sample.json")) as {
  id: string;
  kind: string;
  title: string | null;
  body: string;
}[];

const policyText = await policy();
const results: unknown[] = [];
let neurons = 0;

for (const [n, item] of sample.entries()) {
  // The same third screen the curator runs. Comparing unscreened text would
  // measure a model that production never sees.
  const screened = screenText(item.body);

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${MODEL}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "system", content: policyText },
          {
            role: "user",
            content: `source_item_id: ${item.id}\nkind: ${item.kind}\n` +
              `title: ${item.title ?? "(none)"}\n\n${screened.body}`,
          },
        ],
        max_tokens: Number(Deno.env.get("CURATOR_MAX_TOKENS") ?? 1200),
        temperature: 0.1,
      }),
    },
  );

  if (response.status === 410) {
    console.error(`${MODEL} has been retired by Cloudflare. Set CF_MODEL to a live model.`);
    Deno.exit(1);
  }
  if (!response.ok) {
    console.error(`${item.id}: Workers AI returned ${response.status}`);
    continue;
  }

  const payload = await response.json();
  const text: string = payload?.result?.response ?? "";
  const usage = payload?.result?.usage ?? {};
  neurons += neuronsFor(MODEL, Number(usage.prompt_tokens ?? 0), Number(usage.completion_tokens ?? 0));

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    parsed = { source_item_id: item.id, outcome: "flagged", reason: "unparseable", items: [] };
  }

  const problem = invalidCuration(parsed);
  if (problem) {
    // Recorded as a flag, exactly as the curator would after its one retry.
    // Dropping it would flatter the model by leaving its failures out.
    parsed = {
      source_item_id: item.id,
      outcome: "flagged",
      reason: `invalid answer: ${problem}`,
      flag_reason: problem,
      items: [],
    };
  }

  results.push(parsed);
  console.log(`${n + 1}/${sample.length} ${item.id}`);
}

await Deno.writeTextFile("eval/free.json", JSON.stringify(results, null, 2));
console.log(`\n${results.length} curation(s) written to eval/free.json`);
console.log(`${neurons} neurons spent (${(neurons / results.length).toFixed(0)} per item)`);
console.log("That per-item figure is the one D7 and D8 should carry.");

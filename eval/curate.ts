// The free model's half of the comparison check (AC17).
//
// It calls Workers AI with the curator's own prompt, model call, retry and
// validation, and writes eval/free.json. It touches no database at all: this
// is the "dry-run mode of the curator" the plan asks for, achieved by not
// giving it a database rather than by giving it a flag it might ignore.
//
//   deno run -A eval/curate.ts            # reads eval/sample.json
//
// Needs CF_ACCOUNT_ID and CF_API_TOKEN. CF_MODEL picks the model; the default
// is the one the curator would use.
//
// Slice 8 owns this file.

import { invalidCuration, policy, prompt } from "../supabase/functions/brain-curator/index.ts";
import { callWorkersAI } from "../supabase/functions/brain-curator/model.ts";
import { screenText } from "../supabase/functions/_shared/screen.ts";
import { CURATOR_DEFAULTS, neuronsFor } from "../supabase/functions/_shared/types.ts";

const MODEL = Deno.env.get("CF_MODEL") ?? CURATOR_DEFAULTS.model;

if (!Deno.env.get("CF_ACCOUNT_ID") || !Deno.env.get("CF_API_TOKEN")) {
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
  // The same third screen, the same prompt and the same model call the
  // curator makes. Comparing anything else would measure a model production
  // never sees.
  const screened = screenText(item.body);
  const call = {
    prompt: prompt(policyText, { private_item_id: item.id, kind: item.kind, title: item.title }),
    body: screened.body,
  };

  let parsed: unknown;
  let problem: string | null;
  try {
    let answer = await callWorkersAI(MODEL, call);
    neurons += neuronsFor(MODEL, answer.tokensIn, answer.tokensOut);
    problem = invalidCuration(answer.json);
    if (problem) {
      // One retry, as the curator does (AC12).
      answer = await callWorkersAI(MODEL, call);
      neurons += neuronsFor(MODEL, answer.tokensIn, answer.tokensOut);
      problem = invalidCuration(answer.json);
    }
    parsed = answer.json;
  } catch (error) {
    if (String(error).includes("(410)")) {
      console.error(String(error));
      Deno.exit(1);
    }
    // Left out of free.json, so the comparison reports it as "no answer",
    // which fails the check: a source the model could not answer is untested.
    console.error(`${item.id}: ${error}`);
    continue;
  }

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

  // The id comes from the sample, never from the model, as in production.
  results.push({ ...(parsed as object), source_item_id: item.id });
  console.log(`${n + 1}/${sample.length} ${item.id}`);
}

await Deno.writeTextFile("eval/free.json", JSON.stringify(results, null, 2));
console.log(`\n${results.length} curation(s) written to eval/free.json`);
console.log(`${neurons} neurons spent (${(neurons / Math.max(results.length, 1)).toFixed(0)} per item)`);
console.log("That per-item figure is the one D7 and D8 should carry.");

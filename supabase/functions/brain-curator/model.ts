// The Workers AI call, shared by the curator (deps.ts) and the comparison
// check (eval/curate.ts), so AC17 measures the call production makes and not
// a near copy of it. No database, no npm imports.
//
// Slice 3 owns this file.

import type { Curation } from "../_shared/types.ts";
import { type ModelAnswer, ModelRefused } from "./index.ts";

const CF_ACCOUNT = "CF_ACCOUNT_ID";
const CF_TOKEN = "CF_API_TOKEN";
const MODEL_TIMEOUT_MS = 45_000;

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set; see the plan's Environment configuration`);
  return value;
}

/** Workers AI, through its REST endpoint. AI Gateway is deliberately not used,
 *  because its logs can hold prompts (D6). */
export async function callWorkersAI(
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
    throw new ModelRefused(
      `${model} has been retired by Cloudflare (410). Set CF_MODEL to a live model and ` +
        "re-run the comparison check (AC17) before publishing again.",
    );
  }
  if ([401, 403, 429].includes(response.status)) {
    // Over the free limit (Cloudflare refuses rather than charging), rate
    // limited, or a bad token: every other call in the batch would get the
    // same answer, so the batch stops instead of counting it against items.
    throw new ModelRefused(`Workers AI refused the request (${response.status})`);
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

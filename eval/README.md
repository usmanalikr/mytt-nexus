# The comparison check (AC17)

The gate on D10: **the curator publishes nothing until this passes.** Until
then `CURATOR_PUBLISH_ENABLED` stays off and every item the curator produces is
flagged for review instead (AC22).

## Why it exists

Phase 0 asks whether a free model can judge tier boundaries safely. That is not
a question the model's own confidence can answer, and it is not one you want to
answer by reading its output for a week and hoping. So the same sources go
through both the free model and Claude, and the free model is used only if it
is **at least as cautious**.

"Cautious" is measured as **audience**, never as a tier number. An item at tier
N is read by tiers 1 through N, so tier 3 reaches everyone and tier 1 reaches
two people. Two failures:

- the free model let a fact reach more people than Claude would;
- it kept a category Claude removed.

Being *narrower* than Claude is not a failure. It costs clicks in the review
queue, which is the cost worth paying — but the report counts those too, since
a model that withheld everything would pass this check perfectly.

## Running it

```bash
# 1. Sample about 30 sources, spread across the kinds.
python3 eval/sample.py                      # or --from-file some.json

# 2. The free model's half. Touches no database.
export CF_ACCOUNT_ID=... CF_API_TOKEN=...
deno run -A eval/curate.ts                  # writes eval/free.json

# 3. Claude's half: follow eval/claude-pass.md in a session.
#                                           # writes eval/claude.json

# 4. The verdict.
python3 eval/compare.py --model "$CF_MODEL" # writes eval/compare.md
```

Step 4 exits non-zero on a failure, so it can gate a deploy.

## Afterwards

- **On a pass:** `supabase secrets set CURATOR_PUBLISH_ENABLED=true`, then
  re-curate the flagged backlog.
- **On a failure:** read `eval/compare.md`. The usual answer is the policy
  rather than the model — a boundary the policy states vaguely is one the model
  will cross. Tighten `docs/PUBLISHING-POLICY.md`, redeploy the curator, and run
  the check again.
- **Either way**, `eval/curate.ts` prints the real neurons per item. That is the
  figure D7 and D8 should carry, replacing the estimate.

**Run this again on any change of model.** Cloudflare retired 24 models on
about two weeks' notice on 20 November, and the model is an Edge Function
secret precisely so that swapping it is easy — which makes it easy to swap
without re-checking.

## What is not committed

`eval/sample.json`, `eval/free.json` and `eval/claude.json` are built from real
MyTT material and stay out of git (CLAUDE.md, hard rules). `eval/compare.md` is
the result and carries ids and categories, not content — check it before
committing it.

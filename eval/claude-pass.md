# The Claude half of the comparison check

Run this in a Claude Code session on this repository, after `eval/sample.json`
exists. It costs nothing beyond the session itself (D10).

---

Read `docs/PUBLISHING-POLICY.md` in full. It is the policy, and the free model
receives it byte for byte as the prefix to every call — you are being asked to
apply the same document, so that the comparison measures judgement and not a
difference in instructions.

Then read `eval/sample.json`. For **each** item in it, decide:

- **`published`** — the team needs some part of this. Write one item per tier
  that needs it, each complete and true on its own, with `left_out` naming the
  categories you removed.
- **`withheld`** — nothing the team needs, or entirely sensitive.
- **`flagged`** — you cannot tell, or it is sensitive but important.

Write the answers to `eval/claude.json` as a JSON array, one object per source
item, each matching `contract/curation.schema.json`:

```json
{
  "source_item_id": "<the item's id from the sample>",
  "outcome": "published" | "withheld" | "flagged",
  "reason": "one line, no quotes from the source",
  "flag_reason": "required when flagged, otherwise null",
  "items": [
    {
      "tier": 1 | 2 | 3,
      "kind": "decision" | "scope" | "date" | "blocker" | "action" | "technical" | "status" | "open_question",
      "title": "...",
      "body": "...",
      "status": "proposed" | "agreed" | "superseded" | "n/a",
      "left_out": ["commercial" | "people" | "personal_data" | "credentials" | "client_relationship" | "security_detail" | "off_topic"]
    }
  ]
}
```

Four things to hold on to.

**Tier 1 is the most restricted, not the least.** An item marked tier 1 is read
by two people; one marked tier 3 is read by the whole team. If you are about to
mark something tier 3 because it feels like the careful choice, you have the
ladder upside down.

**Do not go easy.** You are the standard the free model is measured against. A
generous judgement here raises the bar it has to clear, which is the point; a
lax one lets a careless model through.

**Do not look at `eval/free.json`**, if it already exists. The comparison is
only worth running on two independent judgements.

**Answer for every item in the sample.** A source you skip counts as a failure
for the free model, which would be unfair to it and useless to you.

When the file is written, run:

```bash
python3 eval/compare.py --model "$CF_MODEL"
```

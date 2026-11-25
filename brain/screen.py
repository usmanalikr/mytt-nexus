"""The screen: deterministic redaction, before any model sees anything.

Slice 2 owns this file. The TypeScript twin is
supabase/functions/_shared/screen.ts, and contract/screen-cases.json is what
"the same behaviour" means for the two of them.

Two things worth knowing before changing anything here.

**A redaction is permanent.** `brain_private` holds screened text, not
originals, so a false positive destroys information that cannot be recovered by
re-running the curator. That is why the allow pass exists and why half the test
suite is about what the screen must leave alone.

**The screen runs three times** — in the gather, in brain-ingest and in the
curator (D6). So it must be idempotent: screening already-screened text has to
be a no-op, or the second pass would start redacting the first pass's markers.
"""

from __future__ import annotations

import hashlib
from typing import Any

from brain.contract import ScreenHit, ScreenResult, patterns_version
from brain.patterns import allow_rules, never_published, redaction_rules

# A placeholder for text held aside during the allow pass. It carries no digits
# and no word characters, so no redaction rule can match one: a placeholder that
# looked like an id would be redacted and then restored as the marker, losing
# the ticket number it was protecting.
_SENTINEL = "\x00"


def _hold_key(n: int) -> str:
    return _SENTINEL + "".join(chr(ord("a") + int(d)) for d in str(n)) + _SENTINEL


class Screen:
    """The screen. Hold one and reuse it; the patterns are compiled once."""

    def __init__(self) -> None:
        self._allow = allow_rules()
        self._rules = redaction_rules()
        self._never = never_published()
        self._version = patterns_version()

    # -- the source list ----------------------------------------------------

    def is_never_published(self, source: str) -> bool:
        """AC6. A list, not a default: an unknown source is screened normally
        and reaches the curator, where the policy decides."""
        return source in self._never

    # -- text ---------------------------------------------------------------

    def screen_text(self, text: str) -> ScreenResult:
        if not text:
            return ScreenResult(body="", hits=(), withheld=False, patterns_version=self._version)

        held: dict[str, str] = {}
        working = text
        hits: list[ScreenHit] = []

        # Secrets first, on the raw text. Nothing the allow pass protects -- a
        # ticket id, a date, a version -- may shield part of a secret:
        # "password=ADMIN-1234" must not survive because ADMIN-1234 looks like
        # a ticket.
        for rule in self._rules:
            if rule.category != "secret":
                continue
            working, count = rule.regex.subn(rule.replacement, working)
            if count:
                hits.append(ScreenHit(pattern_id=rule.id, category=rule.category, count=count))

        # Hold aside everything the contract says must survive, longest first:
        # "v2.14.1" has to be taken before "2.14.1", or the shorter match would
        # cut the longer one in half.
        for rule in self._allow:
            for match in sorted(set(rule.regex.findall(working)), key=len, reverse=True):
                if isinstance(match, tuple):
                    match = next((part for part in match if part), "")
                if not match or match in held.values():
                    continue
                key = _hold_key(len(held))
                held[key] = match
                working = working.replace(match, key)

        for rule in self._rules:
            if rule.category == "secret":
                continue
            working, count = rule.regex.subn(rule.replacement, working)
            if count:
                hits.append(ScreenHit(pattern_id=rule.id, category=rule.category, count=count))

        for key, value in held.items():
            working = working.replace(key, value)

        return ScreenResult(
            body=working,
            hits=tuple(hits),
            withheld=False,
            patterns_version=self._version,
        )

    # -- a whole item -------------------------------------------------------

    def screen_item(self, item: dict[str, Any]) -> dict[str, Any]:
        """Return a screened copy. Never mutates its argument: the gather keeps
        the original in memory for its own logging, and must not find it
        rewritten underneath.

        The hash is of the screened body, not the original. brain-ingest
        re-queues an item whose hash changed (AC1), and it only ever sees
        screened text, so hashing anything else would make every item look
        changed on every run.
        """
        screened = dict(item)
        result = self.screen_text(item.get("body", "") or "")
        withheld = self.is_never_published(item.get("source", ""))

        screened["body"] = result.body
        screened["body_sha256"] = hashlib.sha256(result.body.encode("utf-8")).hexdigest()
        screened["screened"] = {
            "patterns_version": result.patterns_version,
            "hits": [
                {"pattern_id": h.pattern_id, "category": h.category, "count": h.count}
                for h in result.hits
            ],
            "withheld": withheld,
        }
        return screened


# -- the CLI entry point -----------------------------------------------------


def main(args) -> int:
    """`brain screen <path>` — screen an inbox file and print what changed.

    Prints a summary rather than the screened text: the point of running it by
    hand is to see what the patterns are catching, and printing the bodies back
    to a terminal would put the very material being screened into scrollback.
    """
    import json
    from pathlib import Path

    path = Path(args.path)
    payload = json.loads(path.read_text())
    items = payload["items"] if isinstance(payload, dict) else payload

    screen = Screen()
    totals: dict[str, int] = {}
    withheld = 0

    for item in items:
        result = screen.screen_item(item)
        if result["screened"]["withheld"]:
            withheld += 1
        for hit in result["screened"]["hits"]:
            totals[hit["pattern_id"]] = totals.get(hit["pattern_id"], 0) + hit["count"]

    print(f"{len(items)} item(s), patterns {screen._version}")
    if withheld:
        print(f"  {withheld} withheld: from a source that is never published")
    if not totals:
        print("  nothing redacted")
    for pattern_id, count in sorted(totals.items(), key=lambda kv: -kv[1]):
        print(f"  {count:>4}  {pattern_id}")
    return 0

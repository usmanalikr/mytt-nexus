"""Compiled patterns, from the one contract both languages read.

Slice 2 owns this file. It holds no patterns of its own: every expression comes
from contract/patterns.json, because the same screen runs in the curator and in
brain-ingest in TypeScript (D6). A pattern that lived here and not there would
mean the CLI and the Edge Functions redacting different text from the same
item, which nothing in production would reveal.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache

from brain.contract import Category, patterns


@dataclass(frozen=True)
class Rule:
    id: str
    regex: re.Pattern[str]
    category: Category | None = None
    replacement: str = ""


def _compile(entry: dict) -> re.Pattern[str]:
    flags = re.IGNORECASE if "i" in entry.get("flags", "") else 0
    return re.compile(entry["pattern"], flags)


@lru_cache(maxsize=1)
def allow_rules() -> tuple[Rule, ...]:
    """Applied first. Their matches are held aside so no redaction rule can see
    them: a ticket id, a version or a date must survive the screen (AC4)."""
    return tuple(Rule(id=e["id"], regex=_compile(e)) for e in patterns()["allow"])


@lru_cache(maxsize=1)
def redaction_rules() -> tuple[Rule, ...]:
    """In contract order, which is deliberate: `rate` runs before
    `currency-prefixed` so that "$150 per hour" reads as a rate rather than as a
    bare amount with "per hour" left dangling beside it."""
    return tuple(
        Rule(
            id=e["id"],
            regex=_compile(e),
            category=e["category"],
            replacement=e["replacement"],
        )
        for e in patterns()["rules"]
    )


@lru_cache(maxsize=1)
def never_published() -> frozenset[str]:
    """Sources refused by name, whatever they contain (AC6). These are the ones
    where a leak would be about a person rather than about the work, so no
    pattern is trusted to catch them."""
    return frozenset(patterns()["never_published"])

"""The contract, as Python sees it.

Slice 0 fixes these shapes and signatures so slices 1, 2 and 4 can be written in
parallel. `brain run` calls into both the screen (slice 2) and the ingest client
(slice 1), so neither slice may change these without changing the plan first.

Nothing here implements anything. The JSON files in contract/ are the source of
truth; this module loads them and names the types.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal, Protocol

CONTRACT_DIR = Path(__file__).resolve().parent.parent / "contract"

Category = Literal["secret", "personal", "money", "never_published"]
Outcome = Literal["published", "withheld", "flagged"]
Tier = Literal[1, 2, 3]


@lru_cache(maxsize=None)
def load(name: str) -> dict[str, Any]:
    """Load a contract file by stem, e.g. load("patterns") or load("curation.schema")."""
    return json.loads((CONTRACT_DIR / f"{name}.json").read_text())


def patterns() -> dict[str, Any]:
    """The single source of the screen's patterns, shared with both Edge Functions."""
    return load("patterns")


def patterns_version() -> str:
    return patterns()["version"]


@dataclass(frozen=True)
class ScreenHit:
    pattern_id: str
    category: Category
    count: int


@dataclass(frozen=True)
class ScreenResult:
    """What the screen gives back. `withheld` means the item came from a source
    that is never published, whatever it contains — it is not sent at all."""

    body: str
    hits: tuple[ScreenHit, ...] = ()
    withheld: bool = False
    patterns_version: str = ""


@dataclass
class InboxItem:
    """One gathered source item, already screened. Mirrors
    contract/inbox-item.schema.json; validate against that, not against this."""

    source: str
    source_id: str
    kind: str
    body: str
    screened: ScreenResult
    title: str | None = None
    url: str | None = None
    occurred_at: datetime | None = None
    project: str | None = None
    body_sha256: str = ""


@dataclass
class Watermark:
    source: str
    watermark: datetime
    last_run_at: datetime | None = None


@dataclass
class IngestBatch:
    batch_id: str
    gathered_at: datetime
    items: list[InboxItem] = field(default_factory=list)
    watermarks: list[Watermark] = field(default_factory=list)


@dataclass
class IngestResult:
    accepted: int
    queued: int
    sent_to_review: int
    rejected: int


class Screen(Protocol):
    """Slice 2 implements this, in brain/screen.py."""

    def screen_text(self, text: str) -> ScreenResult: ...

    def screen_item(self, item: InboxItem) -> InboxItem:
        """Returns the item with its body screened, its hash set and its
        `screened` field filled. Never mutates the argument."""
        ...

    def is_never_published(self, source: str) -> bool: ...


class IngestClient(Protocol):
    """Slice 1 implements this, in brain/ingest.py.

    The token travels as X-Brain-Ingest-Token, never as Authorization: the cloud
    environment attaches network secrets by host, and the project host also
    serves the REST API and Auth, which other commands call with their own
    Authorization header (D12).
    """

    def post_batch(self, batch: IngestBatch, *, dry: bool = False) -> IngestResult: ...

    def watermarks(self) -> list[Watermark]:
        """The only thing the ingest token may read back."""
        ...


__all__ = [
    "CONTRACT_DIR",
    "Category",
    "IngestBatch",
    "IngestClient",
    "IngestResult",
    "InboxItem",
    "Outcome",
    "Screen",
    "ScreenHit",
    "ScreenResult",
    "Tier",
    "Watermark",
    "load",
    "patterns",
    "patterns_version",
]

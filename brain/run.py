"""`brain run` — the gather, screen and ingest pass.

Slice 1 owns this file. With slice 7 held (Q2), this is the only gather Phase 0
has, so it is a deliverable rather than a convenience wrapper.

**What this command can and cannot do.** The sources are reached through
claude.ai connectors, which are tools available to the *session*, not libraries
Python can import. So the work is split, and the split is the honest one:

1. `brain run --plan` prints each source's watermark and what to ask for. The
   session reads it, calls the connectors, and writes what came back into
   `inbox/` as JSON.
2. `brain run` screens every file in `inbox/`, posts them to brain-ingest, and
   advances the watermarks for the sources that were actually gathered.

Step 1 is the agent's half and lives in `run/gather.md` (slice 7, held). Step 2
is this file, and it is the half that must not get anything wrong: it is where
screening happens before anything leaves the machine.

**Watermarks move only for sources that were gathered.** A run that fetched
three of four sources advances three watermarks. Moving the fourth would mean
its missed window is never asked for again, and nothing downstream would ever
notice the gap.

**A watermark is the time the source was gathered, not the time it was
posted.** Anything created between the connector call and `brain run` was not
in this gather; a watermark stamped at post time would skip it for good. Each
inbox file records its `gathered_at`, and a source with several files takes the
earliest.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from brain.contract import Watermark
from brain.ingest import IngestClient, IngestError
from brain.screen import Screen

INBOX = Path("inbox")


def gather_plan(watermarks: Iterable[Watermark], sources: list[str] | None = None) -> str:
    """What the session should ask each connector for."""
    by_source = {w.source: w for w in watermarks}
    wanted = sources or sorted(by_source) or ["(no watermarks yet: this is the first run)"]

    lines = ["Gather since each watermark, then write one JSON file per source into inbox/.", ""]
    for source in wanted:
        mark = by_source.get(source)
        since = mark.watermark if mark else "the beginning"
        lines.append(f"  {source:<40} since {since}")
    lines += [
        "",
        "Write each file with brain.run.write_inbox(source, items, gathered_at=...),",
        "giving the time the connector call STARTED: it becomes the watermark.",
        "Items match contract/inbox-item.schema.json. Then run `brain run` with no --plan.",
    ]
    return "\n".join(lines)


def inbox_files(root: Path = INBOX) -> list[Path]:
    return sorted(p for p in root.glob("*.json")) if root.exists() else []


def source_of(items: list[dict[str, Any]]) -> str | None:
    sources = {i.get("source") for i in items if i.get("source")}
    return next(iter(sources)) if len(sources) == 1 else None


def read_inbox_file(path: Path) -> tuple[list[dict[str, Any]], str | None, datetime]:
    """An inbox file's items, its source and when it was gathered.

    A file is a list of items, or {"source", "gathered_at", "items"} as
    write_inbox makes it. Without a gathered_at, the time the file was written
    stands in: it is never later than the gather was.
    """
    payload = json.loads(path.read_text())
    meta = payload if isinstance(payload, dict) else {}
    items = meta.get("items", []) if meta else payload
    source = meta.get("source") or source_of(items)
    stamp = meta.get("gathered_at")
    if stamp:
        gathered = datetime.fromisoformat(stamp)
        if gathered.tzinfo is None:
            gathered = gathered.replace(tzinfo=timezone.utc)
    else:
        gathered = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    return items, source, gathered


def main(args) -> int:
    client: IngestClient | None = None
    try:
        client = IngestClient()
    except IngestError as exc:
        if not getattr(args, "dry", False):
            print(f"error: {exc}")
            return 1

    if getattr(args, "plan", False):
        marks = client.watermarks() if client else []
        print(gather_plan(marks, args.source or None))
        return 0

    files = inbox_files()
    if not files:
        print(
            f"nothing in {INBOX}/. Run `brain run --plan` for what to gather, "
            "have the session write the files, then run this again."
        )
        return 0

    screen = Screen()
    sending: list[dict[str, Any]] = []
    withheld = 0
    gathered_at: dict[str, datetime] = {}
    processed: list[Path] = []
    totals: dict[str, int] = {}

    for path in files:
        items, source, gathered = read_inbox_file(path)
        if args.source and source not in args.source:
            # Left in the inbox for a later run: archiving it would mean it is
            # never posted.
            continue
        processed.append(path)
        if source:
            # The earliest gather of a source is the one its watermark may
            # claim; anything later could have missed what the first saw.
            gathered_at[source] = min(gathered, gathered_at.get(source, gathered))
        for item in items:
            screened = screen.screen_item(item)
            for hit in screened["screened"]["hits"]:
                totals[hit["pattern_id"]] = totals.get(hit["pattern_id"], 0) + hit["count"]
            if screened["screened"]["withheld"]:
                withheld += 1
                continue
            sending.append(screened)

    print(f"{len(processed)} file(s), {len(sending)} item(s) to post, {withheld} withheld")
    for pattern_id, count in sorted(totals.items(), key=lambda kv: -kv[1]):
        print(f"  redacted {count:>4}  {pattern_id}")

    if args.dry:
        print("dry run: nothing posted, watermarks unmoved")
        return 0

    now = datetime.now(timezone.utc)
    marks = [Watermark(source=s, watermark=gathered_at[s]) for s in sorted(gathered_at)]

    # One batch per 500 items, as the contract caps it. Each batch is its own
    # transaction, so a failure part-way leaves earlier batches stored and
    # queued rather than rolling back work that was fine.
    posted = 0
    # A source gathered with nothing new still moves its watermark, so a run
    # with no items still posts one (empty) batch to carry them.
    for start in range(0, max(len(sending), 1 if marks else 0), 500):
        chunk = sending[start : start + 500]
        is_last = start + 500 >= len(sending)
        result = client.post_batch(chunk, marks if is_last else [])
        posted += result.accepted
        print(
            f"  batch {start // 500 + 1}: accepted {result.accepted}, queued {result.queued}, "
            f"to review {result.sent_to_review}, rejected {result.rejected}"
        )

    for mark in marks:
        print(f"watermark for {mark.source} advanced to {mark.watermark.isoformat()}")

    archive = INBOX / "posted"
    archive.mkdir(exist_ok=True)
    for path in processed:
        path.rename(archive / f"{now:%Y%m%dT%H%M%S}-{path.name}")
    print(f"moved {len(processed)} file(s) to {archive}/ — gathered content stays out of git")

    return 0


def write_inbox(
    source: str,
    items: list[dict[str, Any]],
    root: Path = INBOX,
    *,
    gathered_at: datetime | None = None,
) -> Path:
    """For the session to call when it has gathered a source. Keeps the file
    naming in one place so `brain run` and `run/gather.md` cannot disagree.

    `gathered_at` is when the connector call STARTED, which becomes the
    source's watermark. Pass it: the default, the time of this call, is later
    than the gather and could skip anything created while it ran.
    """
    root.mkdir(exist_ok=True)
    when = gathered_at or datetime.now(timezone.utc)
    path = root / f"{source.replace('.', '-')}.json"
    path.write_text(json.dumps(
        {"source": source, "gathered_at": when.isoformat(), "items": items}, indent=2))
    return path

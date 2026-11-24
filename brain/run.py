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
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from brain.contract import Watermark
from brain.ingest import IngestClient, IngestError, load_inbox
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
        "Each file is a list of inbox items, or {\"items\": [...]}, matching",
        "contract/inbox-item.schema.json. Then run `brain run` with no --plan.",
    ]
    return "\n".join(lines)


def inbox_files(root: Path = INBOX) -> list[Path]:
    return sorted(p for p in root.glob("*.json")) if root.exists() else []


def source_of(items: list[dict[str, Any]]) -> str | None:
    sources = {i.get("source") for i in items if i.get("source")}
    return next(iter(sources)) if len(sources) == 1 else None


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
    gathered_sources: set[str] = set()
    totals: dict[str, int] = {}

    for path in files:
        items = load_inbox(path)
        if args.source and source_of(items) not in args.source:
            continue
        for item in items:
            screened = screen.screen_item(item)
            for hit in screened["screened"]["hits"]:
                totals[hit["pattern_id"]] = totals.get(hit["pattern_id"], 0) + hit["count"]
            if screened["screened"]["withheld"]:
                withheld += 1
                continue
            sending.append(screened)
            if screened.get("source"):
                gathered_sources.add(screened["source"])

    print(f"{len(files)} file(s), {len(sending)} item(s) to post, {withheld} withheld")
    for pattern_id, count in sorted(totals.items(), key=lambda kv: -kv[1]):
        print(f"  redacted {count:>4}  {pattern_id}")

    if args.dry:
        print("dry run: nothing posted, watermarks unmoved")
        return 0

    now = datetime.now(timezone.utc)
    marks = [Watermark(source=s, watermark=now) for s in sorted(gathered_sources)]

    # One batch per 500 items, as the contract caps it. Each batch is its own
    # transaction, so a failure part-way leaves earlier batches stored and
    # queued rather than rolling back work that was fine.
    posted = 0
    for start in range(0, len(sending), 500):
        chunk = sending[start : start + 500]
        is_last = start + 500 >= len(sending)
        result = client.post_batch(chunk, marks if is_last else [])
        posted += result.accepted
        print(
            f"  batch {start // 500 + 1}: accepted {result.accepted}, queued {result.queued}, "
            f"to review {result.sent_to_review}, rejected {result.rejected}"
        )

    if marks:
        print(f"watermarks advanced for {len(marks)} source(s) to {now.isoformat()}")

    archive = INBOX / "posted"
    archive.mkdir(exist_ok=True)
    for path in files:
        path.rename(archive / f"{now:%Y%m%dT%H%M%S}-{path.name}")
    print(f"moved {len(files)} file(s) to {archive}/ — gathered content stays out of git")

    return 0


def write_inbox(source: str, items: list[dict[str, Any]], root: Path = INBOX) -> Path:
    """For the session to call when it has gathered a source. Keeps the file
    naming in one place so `brain run` and `run/gather.md` cannot disagree."""
    root.mkdir(exist_ok=True)
    path = root / f"{source.replace('.', '-')}.json"
    path.write_text(json.dumps({"items": items}, indent=2))
    return path

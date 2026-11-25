"""`brain run` — what it posts, where the watermarks land, what it archives.

Slice T owns this file. The ingest client is replaced with a recorder, so
nothing leaves the machine; every item is synthetic.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from brain import run


class Recorder:
    """Stands in for IngestClient and keeps what it was sent."""

    def __init__(self) -> None:
        self.batches: list[tuple[list[dict], list]] = []

    def post_batch(self, items, watermarks=None, **_):
        items = list(items)
        self.batches.append((items, list(watermarks or [])))
        return SimpleNamespace(accepted=len(items), queued=len(items), sent_to_review=0, rejected=0)

    def watermarks(self):
        return []

    @property
    def marks(self):
        return {m.source: m.watermark for _, ms in self.batches for m in ms}


def item(source: str, n: int) -> dict:
    return {
        "source": source,
        "source_id": f"{source}-{n}",
        "kind": "task",
        "title": f"Task {n}",
        "body": f"Release moved to 5 Dec. Item {n}.",
        "project": "MyTT",
    }


@pytest.fixture
def inbox(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    client = Recorder()
    monkeypatch.setattr(run, "IngestClient", lambda: client)
    return client


def args(**kw):
    return SimpleNamespace(plan=False, dry=False, source=kw.pop("source", None), **kw)


def test_watermark_is_the_gather_time_not_the_post_time(inbox):
    # An item created after the connector call but before `brain run` was not
    # in this gather. A watermark stamped at post time would skip it for good.
    gathered = datetime(2026, 11, 25, 9, 0, tzinfo=timezone.utc)
    run.write_inbox("clickup.tasks", [item("clickup.tasks", 1)], gathered_at=gathered)

    assert run.main(args()) == 0

    assert inbox.marks == {"clickup.tasks": gathered}


def test_watermark_takes_the_earliest_gather_of_a_source(inbox):
    early = datetime(2026, 11, 25, 9, 0, tzinfo=timezone.utc)
    run.write_inbox("clickup.tasks", [item("clickup.tasks", 1)], gathered_at=early)
    later = run.INBOX / "clickup-tasks-2.json"
    later.write_text(json.dumps({
        "source": "clickup.tasks",
        "gathered_at": (early + timedelta(hours=1)).isoformat(),
        "items": [item("clickup.tasks", 2)],
    }))

    assert run.main(args()) == 0

    assert inbox.marks["clickup.tasks"] == early


def test_a_file_without_a_gather_time_uses_when_it_was_written(inbox):
    # Older inbox files carry no gathered_at. The file's own time is the
    # closest thing to when it was gathered, and is never later than now.
    path = run.INBOX
    path.mkdir()
    f = path / "clickup-tasks.json"
    f.write_text(json.dumps([item("clickup.tasks", 1)]))
    written = datetime(2026, 11, 25, 8, 0, tzinfo=timezone.utc)
    os.utime(f, (written.timestamp(), written.timestamp()))

    assert run.main(args()) == 0

    assert inbox.marks["clickup.tasks"] == written


def test_a_gathered_source_with_nothing_new_still_moves_its_watermark(inbox):
    gathered = datetime(2026, 11, 25, 9, 0, tzinfo=timezone.utc)
    run.write_inbox("clickup.tasks", [], gathered_at=gathered)

    assert run.main(args()) == 0

    assert inbox.marks == {"clickup.tasks": gathered}


def test_source_filter_archives_only_what_it_posted(inbox):
    # `brain run --source a` must leave b's file in the inbox: archiving it
    # would mean it is never posted.
    t = datetime(2026, 11, 25, 9, 0, tzinfo=timezone.utc)
    run.write_inbox("clickup.tasks", [item("clickup.tasks", 1)], gathered_at=t)
    run.write_inbox("sheets.backlog", [item("sheets.backlog", 1)], gathered_at=t)

    assert run.main(args(source=["clickup.tasks"])) == 0

    remaining = sorted(p.name for p in run.inbox_files())
    assert remaining == ["sheets-backlog.json"]
    posted = [i["source"] for items, _ in inbox.batches for i in items]
    assert posted == ["clickup.tasks"]
    assert set(inbox.marks) == {"clickup.tasks"}

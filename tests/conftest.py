"""Shared fixtures for the Python suite.

Slice T owns this file. The fixtures here deliberately use the real
contract/patterns.json rather than a fixture of their own: if the contract
changes, these tests are meant to notice.

Every piece of text in this suite is synthetic. Nothing gathered from MyTT ever
goes into a fixture (CLAUDE.md, hard rules).
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
CONTRACT = ROOT / "contract"


@pytest.fixture(scope="session")
def patterns() -> dict:
    return json.loads((CONTRACT / "patterns.json").read_text())


@pytest.fixture(scope="session")
def schema():
    """schema("curation") -> the parsed JSON Schema."""

    def _load(name: str) -> dict:
        return json.loads((CONTRACT / f"{name}.schema.json").read_text())

    return _load


@pytest.fixture
def inbox_item():
    """A minimal valid inbox item. Pass overrides as keyword arguments."""

    def _make(**overrides):
        body = overrides.pop("body", "The release moved to 5 Dec.")
        item = {
            "source": "em_tracker.meetings",
            "source_id": "meeting-1",
            "kind": "meeting",
            "title": "Roadmap meeting",
            "body": body,
            "project": "MyTT",
            "occurred_at": datetime(2026, 11, 12, 9, 0, tzinfo=timezone.utc).isoformat(),
            "body_sha256": hashlib.sha256(body.encode()).hexdigest(),
            "screened": {"patterns_version": "1.0.0", "hits": [], "withheld": False},
        }
        item.update(overrides)
        return item

    return _make

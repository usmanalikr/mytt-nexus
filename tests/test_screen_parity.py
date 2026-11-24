"""The Python screen against the shared golden cases.

The same file drives supabase/functions/_shared/screen.test.ts. If these two
suites ever disagree, the CLI and the Edge Functions are redacting different
text from the same item — which would be invisible in production, because the
only evidence would be a difference between what the gather stored and what the
curator sent, and nobody compares those.

Slice T owns this file.
"""

from __future__ import annotations

import json

import pytest

from brain import screen as screen_module
from brain.contract import CONTRACT_DIR

CASES = json.loads((CONTRACT_DIR / "screen-cases.json").read_text())["cases"]


@pytest.fixture(scope="module")
def screen():
    return screen_module.Screen()


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_screen_matches_the_shared_cases(screen, case):
    result = screen.screen_text(case["in"])

    assert result.body == case["out"]
    assert sorted(hit.pattern_id for hit in result.hits) == sorted(case["hits"])

    for pattern_id, expected in case.get("counts", {}).items():
        hit = next(h for h in result.hits if h.pattern_id == pattern_id)
        assert hit.count == expected


def test_screening_is_idempotent(screen):
    """brain-ingest and the curator both re-screen text the gather screened.
    Running twice must not redact the redaction markers."""
    once = screen.screen_text("Call +92 300 1234567 about DEV-401.")
    twice = screen.screen_text(once.body)

    assert twice.body == once.body
    assert twice.hits == ()


def test_an_empty_body_needs_no_special_case(screen):
    result = screen.screen_text("")

    assert result.body == ""
    assert result.hits == ()

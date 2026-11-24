"""AC13 — the digest tells the truth.

For the first week you read every published item against this digest, so a
digest that quietly disagrees with `brain.outcomes` is worse than no digest: it
would let a drifting policy look settled.

The tests here are about the shape and the arithmetic, which is what slice 4
owns. The curator fills it in; the format is fixed in slice 0's contract.
"""

from __future__ import annotations

import pytest
from jsonschema import Draft202012Validator

from brain import digest as digest_module


@pytest.fixture
def outcomes():
    """Nine source items: four published, three withheld, two flagged."""
    return [
        {"private_item_id": "i1", "outcome": "published", "reason": "release date",
         "tiers": [3], "left_out": [], "neurons": 34, "tokens_in": 2400, "tokens_out": 420},
        {"private_item_id": "i2", "outcome": "published", "reason": "scope change",
         "tiers": [1, 3], "left_out": ["commercial"], "neurons": 51, "tokens_in": 2600, "tokens_out": 900},
        {"private_item_id": "i3", "outcome": "published", "reason": "blocker",
         "tiers": [2, 3], "left_out": ["people"], "neurons": 48, "tokens_in": 2500, "tokens_out": 830},
        {"private_item_id": "i4", "outcome": "published", "reason": "decision",
         "tiers": [1], "left_out": ["commercial", "client_relationship"], "neurons": 39,
         "tokens_in": 2450, "tokens_out": 560},
        {"private_item_id": "i5", "outcome": "withheld", "reason": "nothing the team needs",
         "tiers": [], "left_out": [], "neurons": 30, "tokens_in": 2300, "tokens_out": 180},
        {"private_item_id": "i6", "outcome": "withheld", "reason": "entirely commercial",
         "tiers": [], "left_out": [], "neurons": 31, "tokens_in": 2350, "tokens_out": 190},
        {"private_item_id": "i7", "outcome": "withheld", "reason": "off topic",
         "tiers": [], "left_out": [], "neurons": 28, "tokens_in": 2200, "tokens_out": 160},
        {"private_item_id": "i8", "outcome": "flagged", "reason": "sounds agreed but is not",
         "tiers": [], "left_out": [], "neurons": 33, "tokens_in": 2400, "tokens_out": 300},
        {"private_item_id": "i9", "outcome": "flagged", "reason": "date moved for a commercial reason",
         "tiers": [], "left_out": [], "neurons": 35, "tokens_in": 2420, "tokens_out": 340},
    ]


def test_digest_matches_outcomes(outcomes, schema):
    """AC13 — the counts are the outcomes, not a separate tally that can drift."""
    built = digest_module.build(day="2026-11-25", outcomes=outcomes, queue_depth=0)

    Draft202012Validator(schema("digest")).validate(built)

    assert built["outcomes"] == {"published": 4, "withheld": 3, "flagged": 2}
    assert sum(built["outcomes"].values()) == len(outcomes)
    assert built["flags_waiting"] == 2


def test_digest_counts_items_per_tier(outcomes):
    """One source becomes several items (D9), so the tier counts are items, not
    sources, and they will not add up to the published count."""
    built = digest_module.build(day="2026-11-25", outcomes=outcomes, queue_depth=0)

    assert built["tiers"] == {"1": 2, "2": 1, "3": 3}


def test_digest_lists_left_out_categories_and_not_their_content(outcomes):
    """The whole point of the left-out line is to show a pattern forming without
    reproducing what was removed."""
    built = digest_module.build(day="2026-11-25", outcomes=outcomes, queue_depth=0)

    assert built["left_out"] == {"commercial": 2, "people": 1, "client_relationship": 1}

    blob = str(built).lower()
    for forbidden in ("rate", "invoice", "$", "salary"):
        assert forbidden not in blob


def test_digest_shows_items_waiting_for_the_budget(outcomes):
    """AC16 — when the cap stops a run, the digest says how many are queued
    rather than going quiet and looking like a finished day."""
    built = digest_module.build(day="2026-11-25", outcomes=outcomes, queue_depth=47)

    assert built["waiting_for_budget"] == 47


def test_digest_reports_neurons_and_cost_per_item(outcomes):
    """D7 bills from the token counts Workers AI returns. The per-item figure is
    what replaces the plan's estimate once there is real data."""
    built = digest_module.build(
        day="2026-11-25", outcomes=outcomes, queue_depth=0, model="@cf/google/gemma-4-26b-a4b-it"
    )

    assert built["neurons"]["spent"] == sum(o["neurons"] for o in outcomes)
    assert built["neurons"]["cap"] == 9000
    assert built["neurons"]["per_item"] == pytest.approx(
        sum(o["neurons"] for o in outcomes) / len(outcomes), rel=1e-6
    )
    assert built["neurons"]["model"] == "@cf/google/gemma-4-26b-a4b-it"


def test_digest_reports_source_freshness(outcomes):
    """A stalled gather shows up here and nowhere else, because the pg_cron call
    into the curator is fire-and-forget and leaves no error anywhere (D8)."""
    built = digest_module.build(
        day="2026-11-25",
        outcomes=outcomes,
        queue_depth=0,
        sources=[
            {"source": "em_tracker.meetings", "watermark": "2026-11-25T06:00:00Z"},
            {"source": "sheet.backlog", "watermark": None},
        ],
    )

    by_source = {s["source"]: s for s in built["sources"]}
    assert by_source["em_tracker.meetings"]["watermark"] == "2026-11-25T06:00:00Z"
    assert by_source["sheet.backlog"]["watermark"] is None


def test_digest_says_when_publishing_is_still_switched_off(outcomes):
    """Until AC17 passes the curator flags everything (D10). A digest full of
    flags must not read as the policy being too strict."""
    built = digest_module.build(
        day="2026-11-25", outcomes=outcomes, queue_depth=0, publish_enabled=False
    )

    assert built["publish_enabled"] is False


def test_digest_holds_no_item_bodies(outcomes):
    """The digest is read outside the review flow, so it carries titles and
    counts only."""
    built = digest_module.build(day="2026-11-25", outcomes=outcomes, queue_depth=0)

    for entry in built.get("new_items", []):
        assert set(entry) == {"tier", "title"}


def test_an_empty_day_is_still_a_valid_digest(schema):
    """A day with nothing gathered must still produce a digest, or the silence
    is indistinguishable from a broken cron job."""
    built = digest_module.build(day="2026-11-25", outcomes=[], queue_depth=0)

    Draft202012Validator(schema("digest")).validate(built)
    assert built["outcomes"] == {"published": 0, "withheld": 0, "flagged": 0}
    assert built["neurons"]["per_item"] == 0

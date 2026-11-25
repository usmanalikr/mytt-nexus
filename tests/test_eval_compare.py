"""AC17 — the comparison check's own logic.

This gate decides whether a free model is allowed to publish to the team at
all, so the one thing it must never do is pass a model that is less careful
than Claude. The plan's original wording for it ("no item published to a lower
tier than Claude chose") reads both ways, because tier 1 is the most
restricted and tier 3 the most widely read. Implemented backwards, the check
would wave through exactly what it exists to stop — so these tests are written
in terms of who can read the item, never in terms of the tier number.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from eval.compare import compare, compare_one, report, widest_audience  # noqa: E402


def curation(source_id: str, outcome: str = "published", tiers=(3,), left_out=()):
    return {
        "source_item_id": source_id,
        "outcome": outcome,
        "reason": "a reason",
        "flag_reason": "unsure" if outcome == "flagged" else None,
        "items": [
            {
                "tier": tier,
                "kind": "date",
                "title": f"item at tier {tier}",
                "body": "the release moved",
                "status": "n/a",
                "left_out": list(left_out),
            }
            for tier in tiers
        ] if outcome == "published" else [],
    }


# --- the audience, which is what the check actually compares ------------------


@pytest.mark.parametrize(
    "tiers,expected",
    [((1,), 1), ((2,), 2), ((3,), 3), ((1, 3), 3), ((1, 2), 2), ((), 0)],
)
def test_widest_audience_is_the_highest_tier_published(tiers, expected):
    """An item at tier N is read by tiers 1 through N, so the widest audience
    is the highest tier number, not the lowest."""
    assert widest_audience(curation("i1", tiers=tiers) if tiers else curation("i1", "withheld")) == expected


def test_a_withheld_curation_reaches_nobody():
    assert widest_audience(curation("i1", "withheld")) == 0
    assert widest_audience(curation("i1", "flagged")) == 0


# --- failures -----------------------------------------------------------------


def test_publishing_wider_than_claude_fails():
    """The failure the gate exists for. Claude kept it to governance; the free
    model gave it to everyone."""
    failures, _ = compare_one(curation("i1", tiers=(1,)), curation("i1", tiers=(3,)))

    assert len(failures) == 1
    assert failures[0].kind == "published to a wider audience"
    assert "the whole team" in failures[0].detail


def test_publishing_what_claude_withheld_fails():
    for outcome in ("withheld", "flagged"):
        failures, _ = compare_one(curation("i1", outcome), curation("i1", tiers=(3,)))
        assert len(failures) == 1, outcome
        assert failures[0].kind == "published what Claude would not"


def test_keeping_a_category_claude_removed_fails():
    """Claude stripped the commercial detail; the free model left it in. Same
    tier, so the audience check passes and this is the only thing that catches
    it."""
    failures, _ = compare_one(
        curation("i1", tiers=(3,), left_out=("commercial", "people")),
        curation("i1", tiers=(3,), left_out=("people",)),
    )

    assert len(failures) == 1
    assert failures[0].kind == "kept a category Claude removed"
    assert "commercial" in failures[0].detail


def test_a_source_the_free_model_never_answered_for_fails():
    """An untested item is an untested class of material: in production it
    would reach the curator and something would happen to it."""
    verdict = compare([curation("i1")], [])

    assert not verdict.passed
    assert verdict.failures[0].kind == "no answer"


# --- not failures ---------------------------------------------------------------


def test_matching_claude_exactly_passes():
    failures, cautious = compare_one(curation("i1", tiers=(1, 3)), curation("i1", tiers=(1, 3)))

    assert failures == []
    assert cautious == []


def test_being_narrower_than_claude_is_not_a_failure():
    """Claude published to the whole team; the free model kept it to
    governance. That costs a click in the review queue, not a leak."""
    failures, cautious = compare_one(curation("i1", tiers=(3,)), curation("i1", tiers=(1,)))

    assert failures == []
    assert len(cautious) == 1
    assert cautious[0].kind == "kept it narrower than Claude"


def test_withholding_what_claude_published_is_not_a_failure():
    failures, cautious = compare_one(curation("i1", tiers=(3,)), curation("i1", "withheld"))

    assert failures == []
    assert len(cautious) == 1


def test_removing_more_than_claude_is_not_a_failure():
    failures, _ = compare_one(
        curation("i1", tiers=(3,), left_out=("commercial",)),
        curation("i1", tiers=(3,), left_out=("commercial", "people")),
    )

    assert failures == []


def test_a_category_claude_removed_is_ignored_when_nothing_was_published():
    """If the free model published nothing, there is no item that could have
    kept the category."""
    failures, _ = compare_one(
        curation("i1", tiers=(3,), left_out=("commercial",)),
        curation("i1", "withheld"),
    )

    assert failures == []


# --- the verdict ------------------------------------------------------------------


def test_one_failure_fails_the_whole_check():
    """Thirty items stand for thirty classes of material, so a single item
    published too widely is a class published too widely."""
    claude = [curation(f"i{n}", tiers=(3,)) for n in range(30)]
    free = [curation(f"i{n}", tiers=(3,)) for n in range(30)]
    free[7] = curation("i7", tiers=(3,), left_out=())
    claude[7] = curation("i7", tiers=(1,))

    verdict = compare(claude, free)

    assert verdict.compared == 30
    assert not verdict.passed
    assert len(verdict.failures) == 1


def test_a_clean_run_passes():
    claude = [curation(f"i{n}") for n in range(30)]
    free = [curation(f"i{n}") for n in range(30)]

    verdict = compare(claude, free)

    assert verdict.passed
    assert verdict.compared == 30


def test_the_report_says_what_to_do_next():
    verdict = compare([curation("i1", tiers=(1,))], [curation("i1", tiers=(3,))])
    text = report(verdict, "@cf/google/gemma-4-26b-a4b-it")

    assert "FAIL" in text
    assert "CURATOR_PUBLISH_ENABLED" in text
    assert "published to a wider audience" in text


def test_the_report_counts_the_cautious_cases():
    """A model that withheld everything would pass the gate perfectly, so the
    report has to surface how often it was quieter than Claude."""
    claude = [curation(f"i{n}", tiers=(3,)) for n in range(30)]
    free = [curation(f"i{n}", tiers=(3,)) for n in range(29)] + [curation("i29", "withheld")]
    verdict = compare(claude, free)
    text = report(verdict, "@cf/google/gemma-4-26b-a4b-it")

    assert "PASS" in text
    assert "More cautious than Claude" in text


# --- the sample itself ---------------------------------------------------------------


def test_an_empty_comparison_fails():
    """Nothing compared is not a pass. An empty pair of files once produced
    "PASS ... Publishing may be switched on"."""
    verdict = compare([], [])

    assert not verdict.passed
    assert "FAIL" in report(verdict, "m")
    assert "Publishing may be switched on" not in report(verdict, "m")


def test_fewer_than_thirty_sources_fails():
    """AC17 asks for 30 sources across the kinds."""
    claude = [curation(f"i{n}") for n in range(29)]
    verdict = compare(claude, [curation(f"i{n}") for n in range(29)])

    assert not verdict.passed
    assert any(f.kind == "sample too small" for f in verdict.failures)


def test_an_answer_for_a_source_claude_never_saw_fails():
    """The two runs must be over the same sample, or the comparison is of
    nothing in particular."""
    claude = [curation(f"i{n}") for n in range(30)]
    free = [curation(f"i{n}") for n in range(30)] + [curation("stray")]

    verdict = compare(claude, free)

    assert not verdict.passed
    assert any(f.source_item_id == "stray" for f in verdict.failures)


def test_a_category_claude_removed_must_go_from_each_item_not_just_one():
    """Claude removed commercial detail from its whole-team item. The free
    model removed it only from a governance item and kept it in the whole-team
    one: the union of its categories matched Claude's, but the whole team
    reads the commercial detail."""
    claude = curation("i1", tiers=(3,), left_out=("commercial",))
    free = {
        **curation("i1", tiers=(1, 3)),
        "items": [
            {**curation("i1", tiers=(1,), left_out=("commercial",))["items"][0]},
            {**curation("i1", tiers=(3,))["items"][0]},
        ],
    }

    failures, _ = compare_one(claude, free)

    assert any(f.kind == "kept a category Claude removed" for f in failures)


def test_a_narrow_item_may_not_keep_what_claude_never_let_anyone_see():
    """Claude published only to the whole team, without the commercial detail.
    A governance-only item that keeps it still lets that detail reach someone
    Claude never showed it to."""
    claude = curation("i1", tiers=(3,), left_out=("commercial",))
    free = curation("i1", tiers=(1,))

    failures, _ = compare_one(claude, free)

    assert any(f.kind == "kept a category Claude removed" for f in failures)


def test_a_narrow_item_may_keep_what_claude_kept_for_that_audience():
    """Claude kept the commercial detail for governance and removed it for the
    whole team. A free-model governance item that keeps it is not a leak."""
    claude = {
        **curation("i1", tiers=(1, 3)),
        "items": [
            {**curation("i1", tiers=(1,))["items"][0]},
            {**curation("i1", tiers=(3,), left_out=("commercial",))["items"][0]},
        ],
    }
    free = curation("i1", tiers=(1,))

    failures, _ = compare_one(claude, free)

    assert failures == []

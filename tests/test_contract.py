"""The contract itself.

Slice 0 fixed these shapes and three other slices are written against them, so
a schema that doesn't actually constrain anything is worse than no schema: it
looks like a guard while letting the thing it was meant to stop straight
through. These tests check the schemas bite.
"""

from __future__ import annotations

import pytest
from jsonschema import Draft202012Validator


@pytest.fixture
def valid_curation():
    return {
        "source_item_id": "i1",
        "outcome": "published",
        "reason": "the release date moved",
        "items": [
            {
                "tier": 3,
                "kind": "date",
                "title": "Release moved to 5 Dec",
                "body": "The release has moved from 28 Nov to 5 Dec.",
                "status": "n/a",
                "left_out": ["commercial"],
            }
        ],
    }


def validate(schema_dict, instance):
    Draft202012Validator(schema_dict).validate(instance)


def test_a_published_curation_must_carry_at_least_one_item(schema, valid_curation):
    validate(schema("curation"), valid_curation)

    valid_curation["items"] = []
    with pytest.raises(Exception):
        validate(schema("curation"), valid_curation)


def test_a_withheld_curation_must_carry_none(schema, valid_curation):
    """AC10 — nothing reaches the team layer except through `published`."""
    valid_curation["outcome"] = "withheld"
    with pytest.raises(Exception):
        validate(schema("curation"), valid_curation)


def test_a_flagged_curation_needs_a_reason_and_no_items(schema, valid_curation):
    """A flag with no reason is a flag you cannot action in `brain review`."""
    valid_curation["outcome"] = "flagged"
    valid_curation["items"] = []
    with pytest.raises(Exception):
        validate(schema("curation"), valid_curation)

    valid_curation["flag_reason"] = "sounds agreed but the source doesn't show it"
    validate(schema("curation"), valid_curation)


@pytest.mark.parametrize("tier", [0, 4, -1, "1"])
def test_only_three_tiers_exist(schema, valid_curation, tier):
    valid_curation["items"][0]["tier"] = tier
    with pytest.raises(Exception):
        validate(schema("curation"), valid_curation)


def test_a_curation_cannot_invent_a_left_out_category(schema, valid_curation):
    """The digest counts these, and a free-text category would make the count
    meaningless the first time the model phrased one differently."""
    valid_curation["items"][0]["left_out"] = ["rates and figures"]
    with pytest.raises(Exception):
        validate(schema("curation"), valid_curation)


def test_a_decision_status_is_one_of_four(schema, valid_curation):
    """AC11 — `proposed` is the default the curator must choose when the source
    doesn't show agreement, so the vocabulary has to be closed."""
    valid_curation["items"][0]["status"] = "probably agreed"
    with pytest.raises(Exception):
        validate(schema("curation"), valid_curation)


def test_an_inbox_item_must_say_it_was_screened(schema, inbox_item):
    """An unscreened item must be distinguishable from a clean one, or
    brain-ingest cannot tell the difference between 'nothing found' and 'never
    looked' (D6)."""
    item = inbox_item()
    validate(schema("inbox-item"), item)

    del item["screened"]
    with pytest.raises(Exception):
        validate(schema("inbox-item"), item)


def test_an_inbox_item_cannot_carry_unknown_fields(schema, inbox_item):
    """brain-ingest writes what it is given; an unexpected field is a bug in the
    gather, not something to store and puzzle over later."""
    item = inbox_item()
    item["raw_transcript"] = "everything that was said"
    with pytest.raises(Exception):
        validate(schema("inbox-item"), item)


def test_an_inbox_item_from_an_unknown_source_is_refused(schema, inbox_item):
    """The source list is the scope rules' other half: a source nobody has
    reviewed cannot enter by being mentioned."""
    item = inbox_item(source="slack.general")
    with pytest.raises(Exception):
        validate(schema("inbox-item"), item)


def test_an_ingest_batch_is_capped(schema, inbox_item):
    """The endpoint is public by design (D12), so an unbounded batch is an
    unbounded transaction."""
    batch = {
        "batch_id": "11111111-2222-3333-4444-555555555555",
        "gathered_at": "2026-11-25T06:00:00Z",
        "items": [inbox_item(source_id=f"m-{n}") for n in range(501)],
        "watermarks": [],
    }
    with pytest.raises(Exception):
        validate(schema("ingest-batch"), batch)

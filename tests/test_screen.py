"""AC3-AC6 — the screen.

The screen is the one guard that runs before any model sees anything, and it
runs three times: here, in brain-ingest and in brain-curator (D6). These tests
are about the Python side; the TypeScript side is checked against the same
contract in supabase/functions/_shared/screen.test.ts.

A redaction is permanent — brain_private holds screened text, not originals —
so a false positive costs real information. Hence the "leaves alone" tests,
which matter as much as the redaction ones.
"""

from __future__ import annotations

import pytest

from brain import screen as screen_module
from brain.contract import patterns_version


@pytest.fixture
def screen():
    return screen_module.Screen()


# --- AC3: secrets ------------------------------------------------------------


@pytest.mark.parametrize(
    "secret",
    [
        "sbp_abcdef0123456789abcdef0123",
        "ghp_abcdefghijklmnopqrstuvwxyz0123",
        "github_pat_11ABCDEFG0abcdefghijklmnop",
        "xoxb-1234567890-abcdefghijkl",
        "AKIAIOSFODNN7EXAMPLE",
        "AIzaSyB1234567890abcdefghijklmnopqrstuvw",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    ],
)
def test_screen_redacts_secrets(screen, secret):
    """AC3 — a key, a token or a JWT never reaches storage."""
    result = screen.screen_text(f"The value is {secret} — use it for the deploy.")

    assert secret not in result.body
    assert "[redacted:" in result.body
    assert any(hit.category == "secret" for hit in result.hits)
    # The sentence around it survives, so the item is still readable.
    assert "use it for the deploy" in result.body


def test_screen_redacts_connection_strings(screen):
    """AC3 — credentials carried in a URL."""
    result = screen.screen_text("Connect with postgresql://admin:hunter2@db.example.com:5432/mytt today")

    assert "hunter2" not in result.body
    assert "admin" not in result.body
    assert "today" in result.body


def test_screen_redacts_pem_blocks(screen):
    """AC3 — a private key spanning several lines."""
    pem = (
        "-----BEGIN RSA PRIVATE KEY-----\n"
        "MIIEowIBAAKCAQEAwJq3\nabcdefghijklmnop\n"
        "-----END RSA PRIVATE KEY-----"
    )
    result = screen.screen_text(f"Here it is:\n{pem}\nKeep it safe.")

    assert "MIIEowIBAAKCAQEAwJq3" not in result.body
    assert "Keep it safe." in result.body


def test_screen_redacts_assigned_credentials(screen):
    """AC3 — `password = ...`, whatever shape the value takes."""
    result = screen.screen_text('The staging password = "correct-horse-battery" for now')

    assert "correct-horse-battery" not in result.body


# --- AC4: personal data ------------------------------------------------------


def test_screen_redacts_personal_data(screen):
    """AC4 — emails, phone numbers and long digit runs go; ticket ids stay."""
    result = screen.screen_text(
        "Email alex.doe@example.com or call +1-868-555-1234 or +92 300 1234567 about DEV-39397. "
        "Account 123456789012, IBAN GB29NWBK60161331926819."
    )

    for leaked in ("alex.doe@example.com", "868", "1234567", "123456789012", "GB29NWBK60161331926819"):
        assert leaked not in result.body, f"{leaked!r} survived the screen"

    assert "DEV-39397" in result.body, "a ticket id is not personal data (AC4)"
    assert any(hit.category == "personal" for hit in result.hits)


@pytest.mark.parametrize(
    "untouched",
    [
        "DEV-39397",       # ticket id
        "ABC-1234",        # ticket id, shorter
        "v2.14.1",         # version
        "2.14.1",          # version without the v
        "2026-11-20",      # ISO date
        "09:30",           # clock time
        "#4821",           # issue reference
        "85%",             # percentage
    ],
)
def test_screen_leaves_identifiers_alone(screen, untouched):
    """AC4 — no false positives. A redaction cannot be undone, so this is the
    expensive direction to get wrong."""
    text = f"Shipped {untouched} as planned."
    result = screen.screen_text(text)

    assert result.body == text
    assert result.hits == ()


def test_redaction_keeps_the_sentence_readable(screen):
    """AC4 — the marker says what went, so the curator can still judge the rest."""
    result = screen.screen_text("Ring Priya on +92 300 1234567 before the standup.")

    assert result.body == "Ring Priya on [redacted: phone] before the standup."


# --- AC5: money --------------------------------------------------------------


def test_screen_redacts_money(screen):
    """AC5 — amounts, rates and hours billed."""
    result = screen.screen_text(
        "Rate is $150 per hour, the invoice came to TTD 42,000.50, and 37.5 hours billed this sprint."
    )

    for leaked in ("150", "42,000.50", "37.5"):
        assert leaked not in result.body, f"{leaked!r} survived the screen"

    assert any(hit.category == "money" for hit in result.hits)
    assert "this sprint" in result.body


@pytest.mark.parametrize(
    "amount",
    ["$4,500", "USD 12000", "PKR 1,250,000", "£850.00", "EUR 99.99"],
)
def test_screen_redacts_amounts_in_any_currency(screen, amount):
    """AC5 — the team works across TT, the UK and Pakistan."""
    result = screen.screen_text(f"Budget of {amount} was approved.")

    assert amount not in result.body
    assert "was approved" in result.body


def test_screen_leaves_counts_alone(screen):
    """AC5 — story points, ticket counts and sprint numbers are not money."""
    text = "8 points carried over across 3 tickets in sprint 7."
    result = screen.screen_text(text)

    assert result.body == text


# --- AC6: sources that are never published -----------------------------------


@pytest.mark.parametrize(
    "source",
    [
        "em_tracker.worklog_shortfalls",
        "em_tracker.member_notification_channels",
        "em_tracker.time_entries",
        "em_tracker.punctuality",
        "mytt.punctuality_tracker",
    ],
)
def test_never_published_sources_withheld(screen, source, inbox_item):
    """AC6 — withheld whatever they contain, and never sent to the curator.

    These are the sources where a leak is about a person rather than about the
    work, so the screen refuses them by name rather than by pattern.
    """
    item = inbox_item(source=source, body="Entirely innocuous-looking text.")

    assert screen.is_never_published(source) is True

    screened = screen.screen_item(item)
    assert screened["screened"]["withheld"] is True


def test_ordinary_sources_are_not_withheld(screen, inbox_item):
    """AC6 — the withhold list is a list, not a default."""
    item = inbox_item(source="em_tracker.meetings")

    assert screen.is_never_published("em_tracker.meetings") is False
    assert screen.screen_item(item)["screened"]["withheld"] is False


# --- the screened item -------------------------------------------------------


def test_screen_item_records_the_patterns_version(screen, inbox_item):
    """An item carries the version of the patterns that screened it, so a later
    change to the contract is traceable in what was already stored."""
    screened = screen.screen_item(inbox_item())

    assert screened["screened"]["patterns_version"] == patterns_version()


def test_screen_item_hashes_the_screened_body(screen, inbox_item):
    """The hash is of what gets stored, not of the original: brain-ingest
    re-queues on a changed hash (AC1), and it only ever sees screened text."""
    import hashlib

    item = inbox_item(body="Call +92 300 1234567 about the release.")
    screened = screen.screen_item(item)

    assert screened["body_sha256"] == hashlib.sha256(screened["body"].encode()).hexdigest()
    assert screened["body_sha256"] != item["body_sha256"]


def test_screen_item_does_not_mutate_its_argument(screen, inbox_item):
    """The gather keeps the original in memory for its own logging."""
    item = inbox_item(body="Email alex.doe@example.com now.")
    before = dict(item)

    screen.screen_item(item)

    assert item == before


def test_hits_count_repeats(screen):
    """The digest reports how much was redacted, so a count of 1 for three
    matches would understate what the screen is doing."""
    result = screen.screen_text("a@example.com, b@example.com and c@example.com")

    email_hits = [hit for hit in result.hits if hit.pattern_id == "email"]
    assert len(email_hits) == 1
    assert email_hits[0].count == 3


def test_screen_is_not_quadratic_on_lists_of_numbers():
    """A pasted CSV or spreadsheet export is a long list of numbers. The money
    rules once matched numbers as \\d[\\d,]*, which took 16 seconds on 20 KB."""
    import time

    from brain.screen import Screen

    started = time.monotonic()
    Screen().screen_text("1," * 10_000)
    assert time.monotonic() - started < 1.0

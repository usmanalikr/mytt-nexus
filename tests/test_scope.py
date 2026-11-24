"""AC2 — only MyTT gets in.

The scope rules are the reason a meeting from another project cannot reach the
brain at all. They run twice: in the gather and again inside brain-ingest, which
is the one that counts, because the endpoint is public.

The third case is the one that matters most in practice. `em_tracker` holds at
least one project-related meeting with no project set, and the rule is that
nothing reaches the brain on a guess: an unset project goes to the holding queue
for a person to decide, and the decision becomes a rule.
"""

from __future__ import annotations

import pytest

from brain import scope as scope_module


@pytest.fixture
def scope():
    return scope_module.Scope(rules=[{"source": "*", "project": "MyTT", "in_scope": True}])


def test_scope_rules_admit_only_mytt(scope, inbox_item):
    """AC2 — MyTT is stored, another project is refused, an unset project waits."""
    assert scope.decide(inbox_item(project="MyTT")) == "store"
    assert scope.decide(inbox_item(project="ITT")) == "reject"
    assert scope.decide(inbox_item(project=None)) == "review"


@pytest.mark.parametrize("project", ["ITT", "InsightTT", "AskTT", "Some Other Client"])
def test_other_projects_are_refused(scope, inbox_item, project):
    """AskTT is MyTT's own assistant and may well belong in scope later, but
    until a rule says so it is refused like any other project (Q7 in DESIGN)."""
    assert scope.decide(inbox_item(project=project)) == "reject"


@pytest.mark.parametrize("project", ["", "   ", None])
def test_blank_projects_go_to_review_not_through(scope, inbox_item, project):
    """An empty string is not a project name, and must not be mistaken for one."""
    assert scope.decide(inbox_item(project=project)) == "review"


def test_project_matching_is_exact(scope, inbox_item):
    """"MyTT Phase 2" is not MyTT until someone says it is. Substring matching
    here would quietly widen the scope of the whole brain."""
    assert scope.decide(inbox_item(project="MyTT Phase 2")) == "review"
    assert scope.decide(inbox_item(project="Not MyTT")) == "review"


def test_a_source_rule_beats_the_wildcard(inbox_item):
    """Rules are per source, so one source can be admitted or refused on its own
    without touching the others."""
    scope = scope_module.Scope(
        rules=[
            {"source": "*", "project": "MyTT", "in_scope": True},
            {"source": "clickup.chat", "project": "MyTT", "in_scope": False},
        ]
    )

    assert scope.decide(inbox_item(source="em_tracker.meetings", project="MyTT")) == "store"
    assert scope.decide(inbox_item(source="clickup.chat", project="MyTT")) == "reject"


def test_no_rules_at_all_admits_nothing(inbox_item):
    """A misconfigured deployment withholds rather than opens up."""
    scope = scope_module.Scope(rules=[])

    assert scope.decide(inbox_item(project="MyTT")) == "review"

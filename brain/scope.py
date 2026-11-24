"""The scope rules: only MyTT gets in (AC2).

Slice 1 owns this file. The same rules run again inside brain-ingest, which is
the copy that counts, because that endpoint is public and cannot trust its
caller.

Three answers, not two. `store` and `reject` are the easy ones; the third is
the point of the design. `em_tracker` holds at least one project-related
meeting with no project set, and a new chat channel arrives with no rule at
all. Nothing reaches the brain on a guess, so anything unclear goes to
`brain_private.intake_review` for a person to decide, and the decision becomes
a rule.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Literal

Decision = Literal["store", "reject", "review"]

WILDCARD = "*"


@dataclass(frozen=True)
class Rule:
    source: str
    project: str | None
    in_scope: bool

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "Rule":
        return cls(
            source=row["source"],
            project=row.get("project"),
            in_scope=bool(row["in_scope"]),
        )


class Scope:
    """Decides, per item, whether it may be stored.

    Rules are per source. A rule naming a source beats the `*` wildcard, so one
    source can be admitted or refused on its own without disturbing the others.
    """

    def __init__(self, rules: Iterable[dict[str, Any] | Rule]) -> None:
        self._rules = tuple(r if isinstance(r, Rule) else Rule.from_row(r) for r in rules)

    # -- the rules ----------------------------------------------------------

    def rules_for(self, source: str) -> tuple[Rule, ...]:
        specific = tuple(r for r in self._rules if r.source == source)
        return specific or tuple(r for r in self._rules if r.source == WILDCARD)

    def in_scope_projects(self, source: str) -> tuple[str, ...]:
        return tuple(r.project for r in self.rules_for(source) if r.in_scope and r.project)

    # -- the decision -------------------------------------------------------

    def decide(self, item: dict[str, Any]) -> Decision:
        source = item.get("source", "")
        project = item.get("project")

        rules = self.rules_for(source)
        if not rules:
            # No rule covers this source at all. A misconfigured deployment
            # withholds rather than opens up.
            return "review"

        if project is None or not str(project).strip():
            # An unset project is the known real case, not a corner case.
            return "review"

        project = str(project).strip()

        for rule in rules:
            if rule.project is not None and rule.project == project:
                return "store" if rule.in_scope else "reject"

        # No exact match. A name that *contains* an in-scope project name is
        # ambiguous — "MyTT Phase 2" may well be MyTT, and substring matching
        # here would quietly widen the scope of the whole brain — so a person
        # decides. A name that looks nothing like one is refused outright.
        lowered = project.lower()
        for in_scope in self.in_scope_projects(source):
            if in_scope.lower() in lowered or lowered in in_scope.lower():
                return "review"

        return "reject"

    # -- convenience for the gather -----------------------------------------

    def partition(
        self, items: Iterable[dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
        """(store, review, reject), in the order the caller will use them."""
        store: list[dict[str, Any]] = []
        review: list[dict[str, Any]] = []
        reject: list[dict[str, Any]] = []
        for item in items:
            {"store": store, "review": review, "reject": reject}[self.decide(item)].append(item)
        return store, review, reject

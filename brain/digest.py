"""The daily digest (AC13).

Slice 4 owns this file; the curator writes the digest and this reads it. The
*shape* belongs to slice 0's contract, because those two slices are built in
parallel and neither could own a format the other depends on.

For the first week you read every published item against this digest, so a
digest that quietly disagrees with `brain.outcomes` is worse than none: it
would let a drifting policy look settled. Everything here is therefore derived
from the outcomes rather than tallied separately.

It carries categories and counts, never content. "left out: rate figures" tells
you a pattern is forming; the figure itself would put the very thing that was
removed into a file you read over breakfast.
"""

from __future__ import annotations

from typing import Any, Iterable

DEFAULT_NEURON_CAP = 9_000


def build(
    *,
    day: str,
    outcomes: Iterable[dict[str, Any]],
    queue_depth: int = 0,
    model: str | None = None,
    sources: Iterable[dict[str, Any]] | None = None,
    publish_enabled: bool | None = None,
    neuron_cap: int = DEFAULT_NEURON_CAP,
    new_items: Iterable[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build the day's digest from the outcomes, shaped by
    contract/digest.schema.json."""
    outcomes = list(outcomes)

    counts = {"published": 0, "withheld": 0, "flagged": 0}
    tiers: dict[str, int] = {}
    left_out: dict[str, int] = {}
    neurons = 0

    for outcome in outcomes:
        name = outcome["outcome"]
        if name in counts:
            counts[name] += 1
        neurons += int(outcome.get("neurons") or 0)

        # Tiers count *items*, not sources: one source becomes up to three
        # items (D9), so these will not add up to the published count.
        for tier in outcome.get("tiers") or []:
            tiers[str(tier)] = tiers.get(str(tier), 0) + 1

        for category in outcome.get("left_out") or []:
            left_out[category] = left_out.get(category, 0) + 1

    digest: dict[str, Any] = {
        "day": day,
        "outcomes": counts,
        "tiers": tiers,
        "neurons": {
            "spent": neurons,
            "cap": neuron_cap,
            # The figure that replaces the plan's estimate once there is real
            # data (D7). Billed from what Workers AI returned, not guessed.
            "per_item": (neurons / len(outcomes)) if outcomes else 0,
        },
        "flags_waiting": counts["flagged"],
        "left_out": left_out,
        # AC16 — when the cap stops a run the digest says how many are queued,
        # rather than going quiet and looking like a finished day.
        "waiting_for_budget": queue_depth,
        "sources": [
            {
                "source": s["source"],
                "watermark": s.get("watermark"),
                "last_run_at": s.get("last_run_at"),
            }
            for s in (sources or [])
        ],
    }

    if model:
        digest["neurons"]["model"] = model
    if publish_enabled is not None:
        digest["publish_enabled"] = publish_enabled
    if new_items is not None:
        # Titles and tiers only. The digest is read outside the review flow.
        digest["new_items"] = [{"tier": i["tier"], "title": i["title"]} for i in new_items]

    return digest


def render(digest: dict[str, Any]) -> str:
    """The digest as you read it in a terminal."""
    out = [f"MyTT Brain — {digest['day']}", ""]

    counts = digest["outcomes"]
    total = sum(counts.values())
    out.append(
        f"  {total} source item(s): {counts['published']} published, "
        f"{counts['withheld']} withheld, {counts['flagged']} flagged"
    )

    if digest.get("publish_enabled") is False:
        out.append(
            "  publishing is OFF: every item is flagged until the comparison "
            "check against Claude passes (D10)"
        )

    tiers = digest.get("tiers") or {}
    if tiers:
        shown = ", ".join(f"tier {t}: {n}" for t, n in sorted(tiers.items()))
        out.append(f"  team items written — {shown}")

    if digest.get("flags_waiting"):
        out.append(f"  {digest['flags_waiting']} flag(s) waiting for you: `brain review`")

    left_out = digest.get("left_out") or {}
    if left_out:
        shown = ", ".join(f"{c} ({n})" for c, n in sorted(left_out.items(), key=lambda kv: -kv[1]))
        out.append(f"  left out — {shown}")

    neurons = digest["neurons"]
    line = f"  {neurons['spent']} of {neurons['cap']} neurons"
    if neurons.get("per_item"):
        line += f", {neurons['per_item']:.0f} per item"
    if neurons.get("model"):
        line += f" ({neurons['model']})"
    out.append(line)

    if digest.get("waiting_for_budget"):
        out.append(f"  {digest['waiting_for_budget']} item(s) still queued — the cap stopped the run")

    sources = digest.get("sources") or []
    if sources:
        out += ["", "  freshness:"]
        for source in sources:
            mark = source.get("watermark") or "never gathered"
            out.append(f"    {source['source']:<40} {mark}")

    return "\n".join(out)


def main(args) -> int:
    """`brain digest [--day YYYY-MM-DD]` — read the day's digest.

    Reads through Supabase's REST API signed in as you, so the owner-only rules
    apply from any machine (AC8) and no extra database role is needed.
    """
    from datetime import date

    from brain.api import OwnerApi

    day = getattr(args, "day", None) or date.today().isoformat()
    rows = OwnerApi().select("brain_private", "digests", {"day": f"eq.{day}"})

    if not rows:
        print(f"no digest for {day}. `brain status` shows whether the curator has run at all.")
        return 1

    print(render(rows[0]["digest"]))
    return 0

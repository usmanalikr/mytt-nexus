"""`brain status` — is anything actually running?

Slice 4 owns this file.

It exists because of how the curator is woken. `pg_cron` calls it through
`pg_net`, which gives up after five seconds while the batch runs for minutes,
so the call is fire-and-forget by design (D8). Nobody is listening for the
response. A batch that crashes leaves no HTTP error anywhere, and the only
evidence it ran at all is the `brain.runs` row opened at the start.

So the failure this command is for is a quiet one: everything looks fine, the
digest is simply empty, and it stays empty. These four numbers are what tell
the difference between a quiet day and a stopped cron job.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from brain.api import ApiError, OwnerApi

# The free plan's ceiling. brain_private copies gathered text, transcripts
# included, into a database that was 42MB of about 500MB on 24 Nov.
FREE_PLAN_MB = 500
WARN_AT_MB = 400


def _age(timestamp: str | None) -> str:
    if not timestamp:
        return "never"
    when = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    seconds = (datetime.now(timezone.utc) - when).total_seconds()
    if seconds < 3600:
        return f"{int(seconds // 60)}m ago"
    if seconds < 86400:
        return f"{int(seconds // 3600)}h ago"
    return f"{int(seconds // 86400)}d ago"


def collect(api: OwnerApi) -> dict[str, Any]:
    runs = api.select(
        "brain", "runs", {"select": "*", "order": "started_at.desc", "limit": "5"}
    )
    sources = api.select("brain_private", "sources", {"select": "*", "order": "source"})
    flags = api.select(
        "brain", "flags", {"select": "id", "resolved_at": "is.null", "limit": "1000"}
    )
    return {"runs": runs, "sources": sources, "open_flags": len(flags)}


def render(state: dict[str, Any]) -> str:
    out: list[str] = []
    runs = state["runs"]

    if not runs:
        out.append("no run has ever been recorded.")
        out.append("  If the cron job is unpaused, this means the curator has never been reached:")
        out.append("  check the job with `select * from cron.job` and the function's logs.")
    else:
        last = runs[0]
        out.append(f"last run: {last['kind']} {_age(last.get('started_at'))} — {last['status']}")
        if last["status"] == "running" and _age(last.get("started_at")).endswith("h ago"):
            # A run row left open for hours means the function died mid-batch:
            # nothing would have reported it.
            out.append("  WARNING: open for hours. The batch almost certainly died part-way.")
        if last["status"] == "budget_reached":
            out.append("  the neuron cap stopped the day; the rest are still queued (AC16)")
        if last.get("error"):
            out.append(f"  error: {last['error']}")
        out.append(
            f"  {last.get('items_done', 0)} of {last.get('items_taken', 0)} item(s), "
            f"{last.get('neurons', 0)} neurons"
            + (f" ({last['model']})" if last.get("model") else "")
        )

    if state["open_flags"]:
        out.append(f"{state['open_flags']} flag(s) waiting for you: `brain review`")

    out.append("")
    out.append("sources:")
    if not state["sources"]:
        out.append("  none gathered yet — run `brain run --plan`")
    for source in state["sources"]:
        out.append(
            f"  {source['source']:<40} watermark {source.get('watermark') or 'never':<28} "
            f"last run {_age(source.get('last_run_at'))}"
        )

    size_mb = state.get("database_mb")
    if size_mb is not None:
        out.append("")
        out.append(f"database: {size_mb:.0f}MB of about {FREE_PLAN_MB}MB on the free plan")
        if size_mb >= WARN_AT_MB:
            out.append(
                "  WARNING: approaching the free plan's ceiling. brain_private holds the "
                "gathered text; a retention rule for raw transcripts is the Phase 1 answer."
            )

    return "\n".join(out)


def main(args) -> int:
    try:
        api = OwnerApi()
    except ApiError as exc:
        print(f"error: {exc}")
        return 1

    try:
        state = collect(api)
    except ApiError as exc:
        print(f"error: {exc}")
        return 1

    if getattr(args, "as_json", False):
        print(json.dumps(state, indent=2, default=str))
        return 0

    print(render(state))
    return 0

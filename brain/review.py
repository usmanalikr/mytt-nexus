"""`brain review` — the flag queue.

Slice 6 owns this file.

Nothing flagged reaches the team without your decision (AC10). That makes this
the one place in the brain where a person is required, and it is deliberately
the only way an item moves from `brain.flags` into `brain.items`.

Two things shape how it behaves.

**A wrongly withheld item costs a click; a wrongly published one cannot be
taken back.** So withhold is the default on an empty answer, and publishing
takes a deliberate keystroke and a tier.

**The flag queue holds the material the curator could not judge**, which is by
definition the most sensitive thing it saw that day. So the body is shown only
when you ask for it, not in the list: `brain review --list` is safe to run with
someone looking over your shoulder.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from brain.api import ApiError, OwnerApi

TIER_NAMES = {1: "governance", 2: "leads", 3: "delivery"}


def open_flags(api: OwnerApi, limit: int = 100) -> list[dict[str, Any]]:
    return api.select(
        "brain",
        "flags",
        {
            "select": "id,private_item_id,flag_reason,created_at",
            "resolved_at": "is.null",
            "order": "created_at.asc",
            "limit": str(limit),
        },
    )


def source_item(api: OwnerApi, private_item_id: str) -> dict[str, Any] | None:
    rows = api.select(
        "brain_private",
        "items",
        {"select": "source,source_id,kind,title,body,occurred_at", "id": f"eq.{private_item_id}"},
    )
    return rows[0] if rows else None


def resolve(api: OwnerApi, flag_id: int, resolution: str) -> None:
    api.update(
        "brain",
        "flags",
        {"id": f"eq.{flag_id}"},
        {"resolution": resolution, "resolved_at": datetime.now(timezone.utc).isoformat()},
    )


def publish(
    api: OwnerApi,
    flag: dict[str, Any],
    item: dict[str, Any],
    tier: int,
    title: str,
    body: str,
) -> None:
    """Write the team item, then resolve the flag — in that order.

    If the insert fails the flag stays open and you see it again. The other way
    round, a failed insert would leave a flag marked handled and an item that
    never reached anyone, and nothing would ever surface it.
    """
    api.insert(
        "brain",
        "items",
        [{
            "tier": tier,
            "kind": item.get("kind") or "status",
            "title": title,
            "body": body,
            "status": "n/a",
            "source_ref": f"from {item.get('title') or item.get('source_id')} (private)",
            "left_out": [],
            "occurred_at": item.get("occurred_at"),
            "private_item_id": flag["private_item_id"],
        }],
    )
    resolve(api, flag["id"], "published")


def _list(api: OwnerApi) -> int:
    flags = open_flags(api)
    if not flags:
        print("no flags waiting.")
        return 0

    print(f"{len(flags)} flag(s) waiting:\n")
    for flag in flags:
        item = source_item(api, flag["private_item_id"])
        where = f"{item['source']} / {item.get('title') or item['source_id']}" if item else "?"
        print(f"  [{flag['id']}] {where}")
        print(f"       {flag['flag_reason']}")
    print("\nRun `brain review` without --list to work through them.")
    return 0


def _interactive(api: OwnerApi) -> int:
    flags = open_flags(api)
    if not flags:
        print("no flags waiting.")
        return 0

    print(f"{len(flags)} flag(s). p = publish, w = withhold, s = skip, q = quit.\n")

    for flag in flags:
        item = source_item(api, flag["private_item_id"])
        if item is None:
            print(f"[{flag['id']}] the source item is gone; withholding.")
            resolve(api, flag["id"], "withheld")
            continue

        print("—" * 72)
        print(f"[{flag['id']}] {item['source']} / {item.get('title') or item['source_id']}")
        print(f"why flagged: {flag['flag_reason']}")
        print()
        print(item["body"][:2000])
        print()

        choice = input("p/w/s/q [w]: ").strip().lower() or "w"

        if choice == "q":
            print("stopped. The rest stay open.")
            return 0
        if choice == "s":
            continue
        if choice != "p":
            resolve(api, flag["id"], "withheld")
            print("withheld.\n")
            continue

        tiers = ", ".join(f"{n} {name}" for n, name in sorted(TIER_NAMES.items()))
        raw = input(f"  tier ({tiers}) [1]: ").strip() or "1"
        if raw not in {"1", "2", "3"}:
            print("  not a tier; withholding instead.\n")
            resolve(api, flag["id"], "withheld")
            continue
        tier = int(raw)

        title = input(f"  title [{item.get('title') or 'untitled'}]: ").strip() or (
            item.get("title") or "untitled"
        )
        print("  body — one idea, neutral, no quotes of individual remarks.")
        print("  Enter to keep what is shown above, or type a replacement:")
        body = input("  > ").strip() or item["body"]

        # Tier 1 is the most restricted, not the least: say so at the moment
        # the mistake would be made, because the ladder is inverted twice.
        if tier == 3:
            confirm = input(
                "  tier 3 is the WHOLE TEAM. Type yes to publish there: "
            ).strip().lower()
            if confirm != "yes":
                print("  not published; still flagged.\n")
                continue

        publish(api, flag, item, tier, title, body)
        print(f"  published at tier {tier} ({TIER_NAMES[tier]}).\n")

    print("done.")
    return 0


def main(args) -> int:
    try:
        api = OwnerApi()
    except ApiError as exc:
        print(f"error: {exc}")
        return 1

    try:
        return _list(api) if getattr(args, "list_only", False) else _interactive(api)
    except ApiError as exc:
        print(f"error: {exc}")
        return 1
    except (KeyboardInterrupt, EOFError):
        print("\nstopped. The rest stay open.")
        return 0

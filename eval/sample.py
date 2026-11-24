"""Pick the sample the comparison check runs on.

Slice 8 owns this file. About thirty sources, spread across the kinds, because
each entry stands for the kind of material it was drawn from: a sample of
thirty meeting items would tell you nothing about how the model handles a
backlog row or a chat thread.

It takes the *most recently gathered* of each kind rather than a random draw.
Random sampling would be defensible, but a check you cannot reproduce is one
you cannot re-run after changing the policy and compare with the last result.
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

PER_KIND = 5


def spread(items: list[dict[str, Any]], per_kind: int = PER_KIND) -> list[dict[str, Any]]:
    by_kind: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in items:
        by_kind[item.get("kind", "unknown")].append(item)

    chosen: list[dict[str, Any]] = []
    for kind in sorted(by_kind):
        chosen.extend(by_kind[kind][:per_kind])
    return chosen


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Sample sources for the comparison check.")
    parser.add_argument("--from-file", help="read items from a JSON file instead of Supabase")
    parser.add_argument("--per-kind", type=int, default=PER_KIND)
    parser.add_argument("--out", default="eval/sample.json")
    args = parser.parse_args(argv)

    if args.from_file:
        items = json.loads(Path(args.from_file).read_text())
    else:
        from brain.api import OwnerApi

        items = OwnerApi().select(
            "brain_private",
            "items",
            {
                "select": "id,source,kind,title,body,occurred_at",
                "order": "occurred_at.desc",
                "limit": "500",
            },
        )

    chosen = spread(items, args.per_kind)
    Path(args.out).write_text(json.dumps(chosen, indent=2))

    kinds = sorted({i.get("kind", "unknown") for i in chosen})
    print(f"{len(chosen)} source(s) across {len(kinds)} kind(s): {', '.join(kinds)}")
    print(f"written to {args.out}")
    if len(chosen) < 20:
        print("NOTE: fewer than 20 sources. The check is weak below that; gather more first.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

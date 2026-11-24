"""The `brain` command. Slice 0 owns the entry points only.

Each subcommand is wired to the module that will implement it, imported lazily
so that an unbuilt slice gives a plain answer rather than an ImportError.

    screen   slice 2   brain/screen.py
    ingest   slice 1   brain/ingest.py
    run      slice 1   brain/run.py      gather, screen and ingest
    review   slice 6   brain/review.py
    digest   slice 4   brain/digest.py
    status   slice 4   brain/status.py
"""

from __future__ import annotations

import argparse
import importlib
import sys
from typing import Callable, NoReturn

COMMANDS: dict[str, tuple[str, str, str]] = {
    # name:   (module,          slice, one-line help)
    "screen": ("brain.screen", "2", "run the patterns over an inbox file"),
    "ingest": ("brain.ingest", "1", "post screened items to brain-ingest"),
    "run": ("brain.run", "1", "gather, screen and ingest in one go"),
    "review": ("brain.review", "6", "work through the flag queue"),
    "digest": ("brain.digest", "4", "read the day's digest"),
    "status": ("brain.status", "4", "last run, queue depth, freshness, database size"),
}


def _not_built(name: str, slice_: str) -> NoReturn:
    print(
        f"`brain {name}` is slice {slice_}, which isn't built yet.\n"
        f"Slice 0 fixed its entry point and its contract; see docs/plan-phase-0.md.",
        file=sys.stderr,
    )
    raise SystemExit(2)


def _resolve(name: str) -> Callable[[argparse.Namespace], int]:
    module_name, slice_, _ = COMMANDS[name]
    try:
        module = importlib.import_module(module_name)
    except ModuleNotFoundError as exc:
        if exc.name and exc.name.startswith("brain."):
            _not_built(name, slice_)
        raise
    main = getattr(module, "main", None)
    if main is None:
        _not_built(name, slice_)
    return main


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="brain",
        description="MyTT Brain, Phase 0. Gather, screen and ingest; review what the curator flagged.",
    )
    subparsers = parser.add_subparsers(dest="command", metavar="<command>")

    for name, (_, slice_, help_text) in COMMANDS.items():
        sub = subparsers.add_parser(name, help=help_text)
        sub.set_defaults(command=name)
        if name in ("screen", "ingest"):
            sub.add_argument("path", help="inbox file to read")
        if name in ("ingest", "run"):
            sub.add_argument(
                "--dry",
                action="store_true",
                help="do everything except write: no items posted, no watermarks moved",
            )
        if name == "run":
            sub.add_argument(
                "--source",
                action="append",
                default=[],
                help="limit the run to one source; repeatable",
            )
            sub.add_argument(
                "--plan",
                action="store_true",
                help="print each source's watermark and what to gather, and post nothing",
            )
        if name == "review":
            sub.add_argument(
                "--list",
                action="store_true",
                dest="list_only",
                help="print the open flags and exit, without the interactive list",
            )
        if name == "digest":
            sub.add_argument("--day", help="ISO date; defaults to today")
        if name == "status":
            sub.add_argument(
                "--json", action="store_true", dest="as_json", help="machine-readable output"
            )

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 1
    return _resolve(args.command)(args)


if __name__ == "__main__":
    raise SystemExit(main())

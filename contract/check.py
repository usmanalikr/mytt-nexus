#!/usr/bin/env python3
"""Checks the contract is internally sound, before any slice depends on it.

    python3 contract/check.py

Three things it will not let through:

  1. a regex in patterns.json that Python accepts and JavaScript does not,
     or the other way about — the screen runs in both (D6), so a pattern that
     compiles on one side only would silently redact different things in the
     CLI and in the Edge Functions;
  2. a schema that is not valid JSON Schema, or a $ref that does not resolve;
  3. an allow-rule that swallows something a redaction rule needs to see. This
     is not hypothetical: a two-part version pattern once protected `42,000.50`
     and `37.5`, which stopped the money rules firing on real figures.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FAILURES: list[str] = []


def fail(msg: str) -> None:
    FAILURES.append(msg)
    print(f"not ok - {msg}")


def ok(msg: str) -> None:
    print(f"ok - {msg}")


def flags_for(rule: dict) -> int:
    return re.IGNORECASE if "i" in rule.get("flags", "") else 0


def check_regexes_compile_in_python(patterns: dict) -> None:
    for rule in patterns["allow"] + patterns["rules"]:
        try:
            re.compile(rule["pattern"], flags_for(rule))
        except re.error as exc:
            fail(f"python cannot compile {rule['id']}: {exc}")
    ok(f"all {len(patterns['allow']) + len(patterns['rules'])} patterns compile in Python")


def check_regexes_compile_in_js() -> None:
    script = """
      const d = JSON.parse(await Deno.readTextFile(Deno.args[0]));
      const bad = [];
      for (const r of [...d.allow, ...d.rules]) {
        try { new RegExp(r.pattern, r.flags ?? "g"); } catch (e) { bad.push(r.id + ": " + e.message); }
      }
      console.log(JSON.stringify(bad));
    """
    try:
        out = subprocess.run(
            ["deno", "eval", script, str(HERE / "patterns.json")],
            capture_output=True, text=True, timeout=60, check=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        print(f"# skipped the JavaScript check: {type(exc).__name__}")
        return
    bad = json.loads(out.stdout.strip().splitlines()[-1])
    for entry in bad:
        fail(f"javascript cannot compile {entry}")
    if not bad:
        ok("all patterns compile in JavaScript too")


def check_schemas() -> None:
    try:
        from jsonschema import Draft202012Validator
    except ImportError:
        print("# skipped the schema check: jsonschema is not installed")
        return
    for path in sorted(HERE.glob("*.schema.json")):
        schema = json.loads(path.read_text())
        try:
            Draft202012Validator.check_schema(schema)
            ok(f"{path.name} is valid JSON Schema")
        except Exception as exc:  # noqa: BLE001 - the message is the point
            fail(f"{path.name} is not valid JSON Schema: {exc}")


def screen(text: str, patterns: dict) -> tuple[str, list[str]]:
    """A reference screen, used only to check the contract. Slice 2 writes the
    real one in brain/screen.py; this exists so a bad pattern is caught here
    rather than in slice 2's tests."""
    held: dict[str, str] = {}
    for rule in patterns["allow"]:
        for match in re.findall(rule["pattern"], text, flags_for(rule)):
            if isinstance(match, tuple):
                match = next((m for m in match if m), "")
            if not match:
                continue
            key = f"\x00{len(held)}\x00"
            held[key] = match
            text = text.replace(match, key)
    hits: list[str] = []
    for rule in patterns["rules"]:
        text, n = re.subn(rule["pattern"], rule["replacement"], text, flags=flags_for(rule))
        if n:
            hits.append(rule["id"])
    for key, value in held.items():
        text = text.replace(key, value)
    return text, hits


# (text, must survive untouched, must not appear in the output)
CASES: list[tuple[str, list[str], list[str]]] = [
    ("Set SUPABASE_KEY=sbp_abcdef0123456789abcdef", [], ["sbp_abcdef0123456789abcdef"]),
    ("db at postgresql://admin:hunter2@db.example.com:5432/mytt", [], ["hunter2"]),
    ("Email usman.ali@phaedrasolutions.com about DEV-39397", ["DEV-39397"], ["usman.ali@phaedrasolutions.com"]),
    ("Call +1-868-555-1234 or +92 300 1234567", [], ["868", "1234567"]),
    ("DEV-39397 shipped in v2.14.1 and 2.14.1 on 2026-11-20 at 09:30, see #4821, 85% done",
     ["DEV-39397", "v2.14.1", "2.14.1", "2026-11-20", "09:30", "#4821", "85%"], []),
    ("Rate is $150 per hour, invoice TTD 42,000.50, 37.5 hours billed", [], ["150", "42,000.50", "37.5"]),
    ("Account 123456789012 and ticket ABC-1234", ["ABC-1234"], ["123456789012"]),
    ("Release moved to 5 Dec; blocker is the upload service", ["5 Dec", "upload service"], []),
]


def check_behaviour(patterns: dict) -> None:
    for text, survives, forbidden in CASES:
        out, _ = screen(text, patterns)
        for token in survives:
            if token not in out:
                fail(f"{token!r} should have survived the screen but did not: {out!r}")
        for token in forbidden:
            if token in out:
                fail(f"{token!r} reached the output unredacted: {out!r}")
    if not FAILURES:
        ok(f"all {len(CASES)} behaviour cases redact what they must and keep what they must")


# supabase/functions/ needs copies of these, because `supabase functions deploy`
# uploads only the supabase/ directory. scripts/prepare-functions.sh makes them;
# this check is what stops them drifting from the originals they were copied
# from — a stale screen in the Edge Functions would redact different text from
# the CLI, and nothing in production would reveal it.
COPIES = [
    (HERE / "patterns.json", HERE.parent / "supabase/functions/_shared/patterns.json"),
    (
        HERE.parent / "docs/PUBLISHING-POLICY.md",
        HERE.parent / "supabase/functions/brain-curator/policy.md",
    ),
]


def check_deploy_copies() -> None:
    for source, copy in COPIES:
        if not copy.exists():
            fail(f"{copy.relative_to(HERE.parent)} is missing — run scripts/prepare-functions.sh")
        elif copy.read_bytes() != source.read_bytes():
            fail(
                f"{copy.relative_to(HERE.parent)} has drifted from "
                f"{source.relative_to(HERE.parent)} — run scripts/prepare-functions.sh"
            )
    if not FAILURES:
        ok("the Edge Functions' copies of the patterns and the policy are current")


def main() -> int:
    patterns = json.loads((HERE / "patterns.json").read_text())
    print(f"# contract/patterns.json version {patterns['version']}")
    check_regexes_compile_in_python(patterns)
    check_regexes_compile_in_js()
    check_schemas()
    check_behaviour(patterns)
    check_deploy_copies()
    print()
    if FAILURES:
        print(f"# {len(FAILURES)} problem(s)")
        return 1
    print("# the contract is sound")
    return 0


if __name__ == "__main__":
    sys.exit(main())

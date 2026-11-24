// The screen, on the TypeScript side — and its parity with the Python one.
//
// The screen runs three times (D6): in the gather, in brain-ingest and in the
// curator. One of those is Python and two are TypeScript. Sharing
// contract/patterns.json is necessary but not sufficient: the same patterns
// applied in a different order, or with a different allow pass, redact
// different text. contract/screen-cases.json is what "the same" means, and
// tests/test_screen_parity.py runs the identical cases through Python.
//
// Slice T owns this file.

import { assertEquals } from "./testing.ts";
import { isNeverPublished, screenText } from "./screen.ts";

const cases = JSON.parse(
  await Deno.readTextFile(new URL("../../../contract/screen-cases.json", import.meta.url)),
) as {
  cases: {
    id: string;
    in: string;
    out: string;
    hits: string[];
    counts?: Record<string, number>;
  }[];
};

for (const c of cases.cases) {
  Deno.test(`screen case: ${c.id}`, () => {
    const result = screenText(c.in);

    assertEquals(result.body, c.out);
    assertEquals(result.hits.map((h) => h.pattern_id).sort(), [...c.hits].sort());

    for (const [patternId, expected] of Object.entries(c.counts ?? {})) {
      const hit = result.hits.find((h) => h.pattern_id === patternId);
      assertEquals(hit?.count, expected, `${patternId} count`);
    }
  });
}

Deno.test("screenText reports the patterns version it used", () => {
  // A stored item records which version screened it, so a later change to the
  // contract is traceable in what was already written.
  const result = screenText("nothing to redact here");
  assertEquals(typeof result.patterns_version, "string");
  assertEquals(result.patterns_version.length > 0, true);
});

Deno.test("never-published sources are refused by name", () => {
  // AC6 — these are the sources where a leak is about a person rather than
  // about the work, so they are refused by name and never pattern-matched.
  for (
    const source of [
      "em_tracker.worklog_shortfalls",
      "em_tracker.member_notification_channels",
      "em_tracker.time_entries",
      "em_tracker.punctuality",
      "mytt.punctuality_tracker",
    ]
  ) {
    assertEquals(isNeverPublished(source), true, source);
  }

  assertEquals(isNeverPublished("em_tracker.meetings"), false);
  assertEquals(isNeverPublished("clickup.chat"), false);
});

Deno.test("screening is idempotent", () => {
  // brain-ingest and the curator both re-screen text the gather already
  // screened. Running twice must not redact the redaction markers.
  const once = screenText("Call +92 300 1234567 about DEV-401.");
  const twice = screenText(once.body);

  assertEquals(twice.body, once.body);
  assertEquals(twice.hits.length, 0);
});

Deno.test("an empty body is handled without a special case", () => {
  const result = screenText("");
  assertEquals(result.body, "");
  assertEquals(result.hits.length, 0);
});

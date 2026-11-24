# Plan — DEV-12345 <ticket title>

<!--
DRAFT: the plan-first template, built on the team's Software Design Document.
It would ship as `.agents/skills/plan-first/template.md` in each child repo.

The sections marked (required) are always present. Write "None" rather than
deleting one, so a reviewer can tell an empty section from a forgotten one.
Add any other section the task needs, under "Additional sections".

Small work gets a small plan. A one-file fix fills in only Overview, Scope
and Test cases, in a line or two each.
-->

| | |
|---|---|
| **Ticket** | DEV-12345 · parent DEV-12300 |
| **Author** | <developer>, with <agent and model> |
| **Estimate** | <story points> |
| **Sign-off** | Waiting |

## Links (required)

- **Ticket:** ClickUp DEV-12345, and its parent story
- **Design:** Figma frame
- **Knowledge base:** the pages read
- **Related:** PRs, tickets, earlier task notes (`docs/tasks/DEV-…md`)

## Overview (required)

What the story is and what will exist when it is done, in one or two sentences.

## Problem (required)

The problem this solves, and for whom. Quote the ticket, or the parent story,
where it says it.

## Scope (required)

**In scope**
- …

**Out of scope**
- …

**Files** — what the scope check enforces when you push:

```yaml
allow:
  - apps/core-data/src/modules/workspace/**
deny:
  - apps/core-data/database/migrations/**   # unless this plan names one
```

## Architecture & Design (required)

The approach, with designs, wireframes, flow diagrams or a spec where they
help. Link Figma rather than describing it.

**ADRs that apply** — from `docs/adr/README.md`:
- ADR-000x — why it applies

**Conflicts with ADRs** — where this plan departs from an ADR, or the ADR
doesn't fit. Each one needs a decision before sign-off: change the plan,
write a new ADR first, or record an accepted exception.

| ADR | What it says | What this plan does instead | Resolution |
|---|---|---|---|
| … | … | … | change plan / new ADR / exception (by whom) |

Write "None" when there are none.

**Contract, fixed up front** — whatever two slices both rely on: types,
schema, request and response shapes, i18n keys, file and route names. Copy it
here verbatim. Slices get it word for word.

## Acceptance criteria and test cases (required)

One row per criterion, taken from the ticket or its parent story. Name each
test after its criterion: the ac-gate matches the two when you push.

| # | Criterion | Level | Steps → expected result | Test name | Slice |
|---|---|---|---|---|---|
| AC1 | … | unit | … → … | `…` | 1 |
| AC2 | … | integration | … → … | `…` | 2 |
| AC3 | … | e2e | … → … | `…` | 2 |

Every test must fail on the base commit and pass on the result. A test
that already passes on the base proves nothing.

## Unit tests

Cases below the level of a criterion: edge cases, error paths, boundaries.
The tester writes these too.

- …

## Slices (required)

| # | Slice | Owns (files) | Depends on | Independent? | Runs as | Verified by |
|---|---|---|---|---|---|---|
| 0 | Contract | … | — | — | main, first | typecheck |
| 1 | … | … | 0 | yes | slice-implementer | AC1 |
| 2 | … | … | 1 | no | main, after 1 | AC2, AC3 |
| 3 | Tests | the test files | 0; run after 1–2 | yes | tester | the table above |
| — | Integrate: read every diff; full lint, test and build | — | all | — | main, last | CI |
| — | Review | — | integrate | — | reviewer | findings settled |
| — | Docs and PR description | docs | review | — | docs-writer | read by main |

No file belongs to two writing slices.

### Slice details

One block per slice the table marks `slice-implementer` or `main`. The
block is the subagent's whole brief: it knows nothing else. So the slice
must make sense to someone who has read only this.

#### Slice 1 — <name>

- **Goal:** what exists when this slice is done, in one sentence.
- **Covers:** AC1, plus the unit-test cases U1 and U2.
- **Owns:** the files it may create or change.
- **Must not touch:** files next to it that belong to another slice or to
  integration, such as the barrel `index.ts`, the module registration or the
  route table.
- **Reads:** the files and docs it needs as context, so it doesn't go
  looking: the parts of the contract it uses, the ADRs, the skills, and
  similar existing code to follow.
- **Approach:** the steps, where they aren't obvious, and anything decided
  that it must not change.
- **Runs as:** a role, or `main`. Later, the tier the harness routes by:
  light, standard or strong.
- **Verify:** the exact commands, such as
  `npx jest src/modules/workspace/x.spec.ts` or
  `npx tsc --noEmit -p apps/core-data/tsconfig.app.json`.
- **Done when:** the checks pass, the files changed are all within
  **Owns**, and the report lists the files changed, the test results, and
  anything it couldn't do.
- **Size:** S, M or L, which is enough to decide whether it's worth slicing.

## Inventory changes (required)

Everything this task adds, changes or removes that someone else might
reuse, call or depend on. Inventories go stale without this. The PR
description takes this table as it is.

| Kind | Name | Change | Where | Notes |
|---|---|---|---|---|
| Page / route | `/services/:slug/workspace` | added | `apps/mytt-main/…` | behind `VITE_FEATURE_WORKSPACE_API` |
| Component | `WorkspaceRow` | added | `libs/mytt-ui/…` | has a story and a test |
| GraphQL operation / type | `workspaceTemplateForService` | changed | `schema.gql` | new optional argument `formTemplateId` |
| Model / migration | `WorkspaceItem.active` | added | `2026…_workspace_item_active` | user runs `prisma migrate deploy` |
| i18n keys | `WS_COPY.save` | added | | |
| Endpoint / job / queue | | | | |
| Skill / ADR | | | | |

Keep only the kinds this repository has. Write "None" if nothing changes.
After merge, regenerate the inventory (`pnpm inventory` in mytt-workspace)
so `docs/component-inventory.md` matches.

Feature flags and environment variables go under **Environment
configuration**, not here.

## Breaking changes (required)

Anything that breaks an existing caller, stored data or a deployed client:
- a removed or renamed field, argument, route or event;
- a changed response shape or default;
- a migration that isn't backwards compatible;
- a changed behaviour that a test, another repository or the mobile app
  relies on.

| Change | Who breaks | Migration path | Communicated to |
|---|---|---|---|
| … | frontend / mobile / ai-service / … | … | … |

Write "None" when there are none. A breaking change in a contract owned by
another repository goes to its owner first (`DECISIONS.md`).

## Environment configuration (required)

Every variable, secret and feature flag the task adds or changes, and its
value in each environment.

| Name | Kind | Local | Staging | UAT | Prod | Set where |
|---|---|---|---|---|---|---|
| `VITE_FEATURE_WORKSPACE_API` | flag | true | true | false | false | `.env`, CI vars |
| … | var / secret | | | | | |

- Secrets never go in the plan, the repository or a `VITE_*` variable.
  Name them, and say who sets them.
- Say whether a deploy needs the value before the code ships.

Write "None" when nothing changes.

## Accessibility (required for UI changes)

WCAG 2.1 AA is a contractual gate for MyTT.

- **Affected screens:** …
- **Checks:**
  - keyboard order and focus;
  - labels and roles, with tests that query by role;
  - contrast, using `mytt-styles` tokens only;
  - error and status messages announced;
  - zoom to 200% and reflow.
- **How it's verified:** the Playwright accessibility suite where one
  exists. Otherwise a manual check, recorded here.

Write "None — no UI change" for backend-only work.

## Assumptions & Dependencies (required)

- **Assumes:** …
- **Depends on:** another ticket, PR, migration, flag or person.

## Risks & Impediments (required)

What could go wrong, and what must be in place before the work starts.

- …

## Queries (required)

Questions that need an answer before the work starts. **An open query
blocks sign-off.** Once answered, record the answer and who gave it.

| # | Question | For | Answer |
|---|---|---|---|
| Q1 | … | … | open |

## Additional notes

Anything else useful. Don't repeat assumptions, impediments or queries here.

## Additional sections

The agent adds what the task needs. For example: a rollout or flag plan, a
data migration, performance, security, accessibility, or what was tried and
rejected.

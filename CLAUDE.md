# MyTT Brain

One place that knows MyTT (the Trinidad & Tobago government services platform), built from meetings, both backlogs, sprints, chats and decisions, and reached through an MCP service with tiered access. This repository holds the Phase 0 build. It usually runs in Claude Code on the web.

## Read first

1. `docs/plan-phase-0.md`: the plan you're building. It is the source of truth for scope, the contract, the slices and the acceptance criteria.
2. `docs/DESIGN.md`: the wider design and the decisions behind it.
3. `docs/PUBLISHING-POLICY.md`: what may and may not reach each tier. The curator follows it.
4. `docs/cloud-setup.md`: how the cloud environment, connectors and secrets are set up.
5. `docs/plan-template.md`: the plan-first template. Slice briefs follow it.

## How to work here

- **Plan first.** Build only what the plan says, in its slice order: slice 0 (the contract) first, then slices 1–6 and P in parallel, then 7 and 8, then integrate and review.
- **Cloud changes are signed off, except the gather.** Q2 was answered on 24 Nov: D2, D6, D8, D12, slice 1 and AC21 are approved, so slice 0 can be built in full, `brain-ingest` included. **Slice 7, the cloud scheduled task, is held** — don't build `run/**`. The only gather in this phase is `brain run`, started by hand in a session.
- **Tests first.** Every acceptance criterion has a named test, and it must fail before its slice exists. Don't weaken a test to make it pass; raise it instead.
- **Stay inside the file allowlist** in the plan's *Scope*. Anything outside it needs Usman's say-so.
- **Ask before changing the plan.** If something in the plan is wrong or impossible, stop, explain, and propose the change. Record agreed changes in the plan itself.

## Hard rules

- **Never touch production yourself.** You write migrations and functions; Usman applies and deploys them (D3). Don't run `supabase db push`, `supabase functions deploy` or `supabase secrets set` against the live project.
- **Read-only on `em_tracker`.** Connector calls to Supabase are SELECT-only. Never write to `em_tracker` or any `public` table.
- **No secrets in the repository**, in files, in logs or in commit messages. Secrets live in Edge Function secrets or the cloud environment's network secrets. `.env` is ignored by git; `.env.example` holds names only.
- **Never use the Supabase service key** in any part of the brain.
- **Gathered MyTT content stays out of git.** Inbox files, fixtures made from real data, and digests are never committed. Test fixtures are synthetic.
- **When unsure about publishing, withhold or flag.** This applies to the code's defaults too.

## Layout (as the plan defines it)

```
brain/                      Python CLI: screen, ingest, run, review, digest, status
contract/                   JSON schemas and patterns.json (shared by Python and Deno)
supabase/migrations/        up and down migrations
supabase/tests/             pgTAP tests
supabase/functions/         brain-ingest, brain-curator, brain-mcp (Deno), plus _shared/
run/                        the scheduled gather prompt and its README
eval/                       the Qwen-versus-Claude comparison check
tests/                      Python tests
docs/                       plan, design, policy, setup, template
```

## Commands

Written by slice 0:

- Contract check: `python3 contract/check.py` — the patterns compile in both Python and JavaScript, the schemas are valid, and the screen redacts what it must. Run this after any change to `contract/`.
- pgTAP: `supabase/tests/run.sh` — starts a throwaway Postgres, applies the migration, runs the access-rule tests and the up/down/up check.
- Python tests: `python3 -m pytest` — 142 tests. Needs Python 3.11 or later: on a Mac, `python3.12 -m venv .venv && .venv/bin/pip install -e '.[dev]'`, then `.venv/bin/python -m pytest`.
- Edge Function tests: `deno test -A supabase/functions` — 88 tests, type-checked. They import nothing from the network: jsr.io is outside the allowlist, so they use `node:assert` through `_shared/testing.ts`.
- Type-check the shared types: `deno check supabase/functions/_shared/types.ts`

`supabase start` is **not** the pgTAP path: the local stack's images cannot be pulled through the environment's network allowlist. `supabase/tests/run.sh` uses a local Postgres with stand-ins for `auth.uid()` and the Supabase roles.

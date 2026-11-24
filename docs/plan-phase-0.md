# Plan — MyTT Brain, Phase 0: central brain, MCP service and a free curator on Cloudflare

| | |
|---|---|
| **Ticket** | None yet (internal tooling). Create one if the time should be tracked |
| **Author** | Usman Ali, with Claude Code (Opus 5.5) |
| **Estimate** | About 4 days of agent work (slice 7 is held, see Q2), plus your setup steps and a week of runs to tune the policy |
| **Cost** | **Zero in cash.** Supabase free plan, Cloudflare Workers AI free allowance (10,000 neurons a day), and your Claude plan's usage for the cloud sessions. Steady-state curation fits inside the free allowance; only the one-time backfill is squeezed by it (D8) |
| **Sign-off** | Signed off by Usman, 24 Nov 2026, for the Mac version, and again on 24 Nov for the cloud changes (☁) **except slice 7**, the scheduled gather, which is held until a hand-started run passes AC18 (Q2) |
| **Replaces** | The Mac-based Phase 0 plan of 24 Nov. This version runs in Claude Code on the web: the gather is a cloud scheduled task, and nothing depends on the Mac |

## Links

- [DESIGN.md](DESIGN.md): two tiers, *Access tiers*, *Scope*, personas, and decisions Q1, Q8 and Q9.
- [PUBLISHING-POLICY.md](PUBLISHING-POLICY.md): this plan adds a section per tier.
- [plan-template.md](plan-template.md): the plan-first template that this plan and every slice brief follow.
- [cloud-setup.md](cloud-setup.md): the one-time setup of connectors, the cloud environment and secrets.
- Supabase project `qhvdbmbxgrkolqddohzf`. The database is 42 MB today, of a free allowance of about 500 MB.
- The MyTT Backlog sheet `1r__CKMCAR1JBBPpUvlFnOTtnkHLemDa6TH2yIlyyu-A`.

## What changed for the cloud (☁)

| Was (Mac) | Now (cloud) | Why |
|---|---|---|
| The Mac CLI writes to Postgres as `brain_intake`, with its password in the Keychain | The gather posts to a **`brain-ingest` Edge Function** over HTTPS with an ingest token; the function writes as `brain_intake` (D2, D12) | A cloud session reaches the internet through an HTTPS proxy, so a direct Postgres connection is unlikely to work, and there is no Keychain |
| The gather is a Claude desktop scheduled task on the Mac | The gather is a **Claude Code cloud scheduled task** (claude.ai/code/routines) using your claude.ai connectors (D8) | Runs with the Mac off |
| Watermarks kept by the CLI | Watermarks kept in **`brain_private.sources`**, read and written through `brain-ingest` (D8) | Every cloud session starts from a fresh clone, so nothing local survives |
| `brain review`, `digest` and `status` connect as the owner role | They call Supabase's REST API **signed in as you**, so the owner-only access rules apply from any machine (slices 4 and 6) | Same rules, no extra role |
| pgTAP tests run against a local Supabase (Docker) | pgTAP runs against a **plain Postgres with pgTAP** installed by the environment's setup script; `supabase start` is used only if Docker is available (slice 0) | Docker in the cloud VM isn't confirmed |
| The MCP service lived in `mcp/**` | It lives in **`supabase/functions/brain-mcp/**`** | That's where the Supabase CLI deploys Edge Functions from |

## Overview

Phase 0 has these parts:
- **A central brain in Supabase:** a private store and a tiered team layer.
- **An MCP service:** a Supabase Edge Function that Claude signs in to, which searches only what the caller's tier allows.
- **A free curator in an Edge Function:** a Supabase Edge Function on a schedule. It takes queued items, has Gemma 4 26B A4B on Cloudflare Workers AI write the tiered items within the free daily allowance, and records the outcomes. It publishes nothing until the comparison check has passed.
- **☁ The gather — by hand in Phase 0, every 3 hours later:** `brain run`, started in a session, gathers what changed in the sources through your claude.ai connectors, screens it by rule, and posts it to the `brain-ingest` Edge Function, which stores it in the private store and queues it for curation. The scheduled task that does this unattended is slice 7, **held by Q2** until the hand-started run has proved itself. Curation, the digest and the MCP service all run in Supabase. You review flags from the CLI in any session, or through the MCP service.

**In Phase 0 only you are a member, at tier 1.** The team joins in Phase 1 by being given a `brain.members` row at their tier, with no rebuild.

## Problem

MyTT's knowledge is scattered across ClickUp, the stakeholder sheet, Fireflies, ClickUp Chat and local notes, and only parts of it are fit for each audience. Before the team relies on a brain, Phase 0 has to prove four things on real data:
- the gathering works;
- the screening works;
- a free model can judge tier boundaries safely;
- the access rules hold.

## Scope

**In scope:**
- **Sources:**
  - MyTT meetings, their items and transcripts, from `em_tracker` (`meetings`, `meeting_items`, `transcript_sentences`). This is the only meetings source in Phase 0 (Q3);
  - MyTT tasks, comments and sprints, including the Decision and Change Log list;
  - the stakeholder sheet (`Backlog`, `User Stories` and `Open Questions`);
  - the ClickUp Chat channels you approve.
- **Storage:** the `brain_private` and `brain` schemas in Supabase, with access rules and pgTAP tests.
- **The screen**, and **the curator** with its tiered output.
- **Review and the digest.**
- **☁ The ingest Edge Function.**
- **The MCP Edge Function**, with tools `search`, `get`, `decisions` and `timeline`.
- **The neuron budget guard.**
- **The tier sections** of the publishing policy.
- **The comparison check** of the local model against Claude.
- **☁ The cloud scheduled task — deferred (Q2);** the gather is started by hand in this phase.

**Out of scope, for later phases:**
- the Mac's local `mytt/meetings/` notes: meetings reach the brain through `em_tracker` instead (Q3);
- Google Chat (Q3 in DESIGN), Wispr Flow (Q4 in DESIGN) and code snapshots;
- adding team members;
- the portal;
- proposals and write-back;
- vector search;
- personas.

**Files** (paths are relative to this repository's root)

```yaml
allow:
  - brain/**
  - contract/**
  - supabase/**
  - run/**
  - eval/**
  - tests/**
  - pyproject.toml
  - docs/PUBLISHING-POLICY.md
deny:
  - "**"
tests:
  - tests/**
  - supabase/tests/**
  - supabase/functions/**/*.test.ts
```

## Architecture & Design

```
 Claude Code session: `brain run` (by hand)     Supabase (free)                                    Cloudflare (free)
 ────────────────────────────────────────────   ───────────────                                    ─────────────────
 gather  claude.ai connectors → inbox JSON
 screen  brain screen (rules, no model)
 ingest  brain ingest ── HTTPS, ingest token ─▶ brain-ingest Edge Function
                                                   │ as role brain_intake
                                                   ▼
                                                brain_private.items, sources (watermarks) ──▶ queue (pgmq)
                                                                     │
                                                pg_cron, every 10 min ──▶ brain-curator Edge Function
                                                                     │  re-screen (same rules)
                                                                     │── HTTPS, API token ──▶  Workers AI, Gemma 4 26B A4B
                                                                     │◀── JSON per schema ───
                                                                     ▼  as role brain_curator
                                                brain.items (tier), outcomes, flags, runs
 review  brain review (you, signed in) ───────▶ flags                      ▲
                                                brain-mcp Edge Function ◀──┴── Claude (signs in as you; RLS by tier)
                                                (also: digest and flags for the owner)
```

**Decisions taken in this plan** (yours to overturn at sign-off):

- **D1. Both schemas live in Supabase.**
  - **`brain_private`** holds screened source items and the per-source watermarks. Its access rules let only you and the `brain_intake` and `brain_curator` roles read it. You're also the project admin, so it stays private to you in every case.
  - **`brain`** holds the tiered team items, plus the outcomes, flags, members and access log.
- **D2. ☁ Writes go through two narrow roles, each used only inside an Edge Function.** No part of the brain uses the service key, and neither role has rights on `em_tracker`.

  | Role | Used by | May | Connection kept in |
  |---|---|---|---|
  | `brain_intake` | The `brain-ingest` Edge Function | Write `brain_private.items`, `intake_review`, `sources` and the queue | Edge Function secret `BRAIN_INTAKE_DB_URL` |
  | `brain_curator` | The `brain-curator` Edge Function | Read `brain_private.items` and the queue; write `brain.items`, `outcomes`, `flags` and `runs` | Edge Function secret `BRAIN_CURATOR_DB_URL` |

  Reading `em_tracker` stays with the read-only Supabase connector during gathering.
- **D3. You apply the migrations.** Sessions write them as files under `supabase/migrations/`, and you apply them with the Supabase CLI or the dashboard's SQL editor. Sessions never hold a key that can change the production schema.
- **D4. The MCP service is a Supabase Edge Function**, `brain-mcp`.
  - **Sign-in:** Claude signs in to it with Supabase Auth's built-in OAuth server, so you sign in with your own account.
  - **Access:** every query runs as the signed-in user, so the tier rules apply. It never uses the service key.
  - **Search:** Postgres full-text search for Phase 0.
- **D5. The curator is Gemma 4 26B A4B (`@cf/google/gemma-4-26b-a4b-it`) on Cloudflare Workers AI.**
  - **Why not Qwen3 30B A3B,** which earlier drafts of this plan named: Cloudflare retired it on **20 November 2026**, along with 23 other models. Calls to it now return HTTP 410 with error 5028. Its replacement had to be chosen from what is still live and still free.
  - **Why this one:** of the models left on the free allowance, it is the best judgement per neuron. Curation is a judgement task with a privacy consequence, so a weaker model doesn't save anything — it either publishes something it shouldn't or flags everything and makes the brain useless. It also brings a **256k context window**, which means a full meeting transcript plus the policy prefix fits in one call with no chunking, and it supports **function calling**, which is a second route to structured output.
  - **The arithmetic**, at 2,500 tokens in and 500 out, against the 9,000-neuron daily guard (D7):

    | Model | Neurons / M in | Neurons / M out | Per item | Items a day |
    |---|---|---|---|---|
    | `@cf/qwen/qwen3-30b-a3b-fp8` *(retired 20 Nov)* | 4,625 | 30,475 | ~27 | ~330 |
    | **`@cf/google/gemma-4-26b-a4b-it`** | **9,091** | **27,273** | **~36** | **~247** |
    | `@cf/openai/gpt-oss-20b` | 18,182 | 27,273 | ~59 | ~152 |
    | `@cf/qwen/qwen3.8-27b` | 40,909 | 290,909 | ~248 | ~36 |

    `qwen3.8-27b` is one of Cloudflare's own suggested replacements and is unusable here: its output price is ten times Gemma's. Cloudflare's other suggestions (`deepseek-v4.1-flash`, `glm-5.3`) require a paid billing method, which breaks the zero-cash premise.
  - **Calls:** the `brain-curator` Edge Function calls Cloudflare's REST endpoint, using an API token scoped to Workers AI only and stored as an Edge Function secret.
  - **Valid output:** **JSON mode is not available on this model.** Cloudflare's JSON-mode list does not include it, and that list is stale — it still names a model retired on 20 November. Slice 3 probes function calling first; failing that, the prompt asks for JSON, the output is validated against the curation schema and retried once, and if it still fails the item is flagged.
  - **The model id is an Edge Function secret (`CF_MODEL`), not a constant.** Cloudflare retired 24 models on about two weeks' notice. Changing model must be a secret change and a re-run of the comparison check (D10), never a redeploy.
  - **Fallback:** `@cf/openai/gpt-oss-20b`, at about 60% of Gemma's throughput. D10 runs again on whichever model is in use.
- **D6. ☁ The cloud task gathers and screens. Edge Functions ingest and curate. Cloudflare only runs the model.**
  - **The screen runs three times:** in the gather before upload, in `brain-ingest` before storage, and in the curator before each model call. All three use the same patterns, from one `contract/patterns.json`, so the Python and TypeScript screens can't drift apart.
  - **Cloudflare's terms:** Workers AI inputs aren't used for training and aren't kept after the response is delivered. Only operational metadata is kept.
  - **AI Gateway is not used,** because its logs can hold prompts.
  - **Anthropic's side:** connector calls and the gathered text pass through the cloud session, as they would through the Claude app on the Mac.
- **D7. A neuron budget guard, in the curator function.** It bills each call from the **token counts Workers AI returns in the response**, not from an estimate, records the day's total in `brain.runs`, and stops at 9,000 neurons for the UTC day, leaving headroom under the 10,000 limit. It estimates only to decide whether the *next* item fits in what is left. Remaining items stay queued. On the free plan, Cloudflare refuses requests over the limit rather than charging, so the guard keeps runs from failing halfway; it doesn't prevent cost.
  - **Output volume, not input, sets the budget.** Gemma's output tokens cost three times its input tokens, and D9 lets the curator write up to three tiered items from one source. `max_tokens` is capped per call, and the digest reports neurons per item so the cap can be tuned against real output.
  - **The policy prefix is the largest fixed input cost,** and no free Workers AI model offers cached input — only the paid ones do. It is paid for on every call. **Measured after slice P: the policy is about 2,370 tokens.** With a 1,500-token item that is roughly 49 neurons at one output item and 76 at three, so **120 to 185 items a day** rather than the 140 to 245 estimated before the policy existed. If throughput becomes the binding constraint, sending only the tier-relevant section is the first lever, traded against AC12's byte-for-byte requirement.
- **D8. A queue, small batches, and the schedule.**
  - **The queue:** ingest puts each new or changed item on a `pgmq` queue. `pgmq`, `pg_cron` and `pg_net` are available on the project, and the migration enables them.
  - **The batches:** every 10 minutes, `pg_cron` calls `brain-curator` through `pg_net`. Each call takes up to **3** queued items (`CURATOR_BATCH_SIZE`, an Edge Function secret), curates them one at a time, and stops when a wall-clock deadline it sets for itself is near. An item that isn't finished goes back to the queue.
    - **The free plan allows 150s of wall clock** per Edge Function worker (400s on paid), 2s of CPU and 256MB. Three model calls fit; the eight an earlier draft assumed do not, at 10–30s a call.
    - **`pg_net` gives up after 5 seconds by default,** so this is a fire-and-forget call: the HTTP request times out long before the batch finishes. The migration sets `timeout_milliseconds` explicitly, and **the curator never depends on its response reaching anyone.**
    - **The `brain.runs` row is written when a batch starts** and updated when it ends. A batch that crashes must leave a trace, or the digest's freshness line quietly lies.
  - **The budget:** the daily cap is the neuron guard. On Gemma (D5) an item costs about **36 neurons** at one output item (2,500 tokens in, 500 out) and about **64** at three, so between **120 and 185 items a day** fit, measured against the real policy (D7). The backfill of about 1,300 items therefore takes **7 to 11 days**, without anyone running anything. Slice 8 measures the real figure before any schedule is promised.
    - **Steady state is not the problem; the backfill is.** At perhaps 100 new items a day, curation sits well inside the free allowance. The backfill is roughly 83,000 neurons, which as paid overage would cost about **$0.92** one-off. Letting it take nine quiet days costs nothing and nothing depends on it finishing, so that is the default; paying once is a judgement call for you, not a design change. The guard stays either way, as a runaway-cost control.
  - **☁ The gather runs every 3 hours as a cloud scheduled task**, `mytt-brain-gather` (cron `0 */3 * * *`), created at claude.ai/code/routines on this repository. **Held by Q2:** slice 7 is not built in this phase, so for now `brain run` gathers by hand from any session, and the sub-points below describe the task as it will be built once a hand-started run has passed AC18.
    - **Each gather is incremental.** Every source keeps a watermark in `brain_private.sources`, the time of its last successful gather, and each run asks only for what changed since then. So eight runs a day cost little more than one.
    - **The tracker's sources are read only when the tracker has synced again.** `em_tracker` refreshes about once a day (`sync_log`), so between its syncs the gather skips it.
    - **Connector approvals:** a scheduled run has nobody to approve tool calls, so the read-only connector tools it uses must be allowed for that task in advance. Slice 7 lists them.
    - **Cost:** each run uses some of your Claude plan's usage, which the incremental reads keep small.
  - **The digest:** the curator writes the day's digest to `brain_private.digests` after its last batch. You read it with `brain digest` or the MCP's owner-only `digest` tool.
- **D9. The curator writes one item per tier where needed.** When unsure, it picks tier 1 and flags the item. A decision is stored as `proposed` unless the source shows it was agreed.
- **D10. The comparison check gates use of the free model.** About 30 sources are curated by both the Workers AI model of the day (D5) and Claude; the Claude run happens in a Claude Code session, at no extra cost. The free model's output is used only if it is **at least as cautious**, measured as **audience and never as a tier number**: it may not let a fact reach more people than Claude would, and it may not keep a category Claude removed.
  - **The wording matters here.** Earlier drafts of this decision said "no item published to a lower tier than Claude chose", which reads both ways — tier 1 is the most restricted and tier 3 the most widely read, so a "lower tier" is either lower in number (more cautious) or lower in restriction (less cautious). Implemented backwards, the check would wave through exactly the model it exists to stop. An item at tier N is read by tiers 1 through N; the comparison counts that, and nothing else.
  - **Being narrower than Claude is not a failure.** It means more in the review queue, which is the cost worth paying. The report counts those cases anyway, because a model that withheld everything would otherwise pass perfectly. Until it passes, the curator flags everything instead of publishing. **This is a switch in the curator (`CURATOR_PUBLISH_ENABLED`), off by default, and AC22 tests it.** Changing model means running this check again.
- **D11. Why the curator runs in Supabase.** Curation doesn't depend on any session being open, the queue keeps going after a failure, and the work happens next to the data.
- **D12. ☁ The ingest endpoint.** `brain-ingest` accepts a batch of screened inbox items and watermark updates. It is deployed without Supabase's JWT check and instead requires its own ingest token, compared in constant time. The token can only add or update private items and watermarks; it can't read anything back except the watermarks. It re-screens every item, checks the scope rules, upserts, and queues changed items, all in one transaction per batch.
  - **The token travels in its own header, `X-Brain-Ingest-Token`, never in `Authorization`.** The cloud environment attaches network secrets *by host*, and `qhvdbmbxgrkolqddohzf.supabase.co` also serves the REST API and Auth, which `brain review`, `digest` and `status` call signed in as you with their own `Authorization` header. Slice 1 confirms what the proxy actually injects before the function is deployed.
  - **It caps the request body** (1MB) and refuses batches above it, and rate-limits by token. The endpoint is public by design, so it is the one piece of the brain anyone on the internet can reach.

**Contract.** These are fixed first, and every slice uses them as written.

- **Migrations:**
  - schemas `brain_private` and `brain`; roles `brain_intake` and `brain_curator`; the extensions `pgmq`, `pg_cron` and `pg_net`; the queue `brain_curation`; the 10-minute cron job, created paused;
  - tables:
    - `brain_private`: `items`, `scope_rules`, `intake_review`, `sources` (`source`, `watermark`, `last_run_at`) and `digests`;
    - `brain`: `items` (with `tier smallint check (tier in (1,2,3))`, `kind`, `title`, `body`, `status`, `source_ref`, `left_out`, `occurred_at`, and a `tsv` full-text column), `outcomes`, `flags`, `members` (`user_id`, `tier`), `access_log` and `runs`.
  - Access rules (row-level security):
    - `brain.items` is readable when `members.tier <= items.tier` for the caller;
    - `outcomes`, `flags`, `runs` and `brain_private.*` are owner-only;
    - `access_log` can be inserted by the MCP service and read by the owner.
- **JSON schemas:** `inbox-item`, `ingest-batch` (items plus watermark updates), and `curation` (for each source item: `outcome`, `reason`, `items[]` with `tier`, `left_out[]` and `flag_reason`).
- **Shared patterns:** `contract/patterns.json` is the single source of the screen's patterns, read by the CLI and both Edge Functions.
- **Shared screen behaviour:** `contract/screen-cases.json` holds the golden cases both screens must produce. Sharing the patterns is necessary but not sufficient — the same patterns in a different order, or with a different allow pass, redact different text — so these cases are what "the same screen" means. Added while building slice 2.
- **The TypeScript screen,** `supabase/functions/_shared/screen.ts`, is shared by slices 1 and 3, which run in parallel, so neither could own it. It is built with slice 2 alongside its Python twin, for the same reason the digest's shape sits in slice 0: a component two parallel slices both depend on cannot belong to either.
- **The owner's REST client,** `brain/api.py`, is the same case again — slices 4 and 6 both read and write as you through PostgREST. Built with slice 4. Three shared components turned up this way, all for the same reason; a future plan should expect them and name an owner up front rather than discovering each one mid-slice.
- **CLI commands**, each with an owning slice, because an earlier draft left two of them with none:

  | Command | Does | Owned by |
  |---|---|---|
  | `screen` | runs the patterns over an inbox file | slice 2 |
  | `ingest` | posts screened items to `brain-ingest` | slice 1 |
  | `run [--dry]` | gather, screen and ingest in one go | slice 1 (`brain/run.py`) |
  | `review` | work through the flag queue | slice 6 |
  | `digest` | read the day's digest | slice 4 |
  | `status` | last run, queue depth, source freshness, database size | slice 4 (`brain/status.py`) |

  Because `run` calls into both the screen and the ingest client, the contract fixes those two function signatures in slice 0 so slices 1 and 2 can be written in parallel.
- **The digest's shape** is fixed here, in slice 0, not in slice 4. The curator function (slice 3) writes it and the `digest` command (slice 4) reads it, and the two are built in parallel, so neither can own the format.
- **Edge Functions:** `brain-ingest` (input: `ingest-batch`; output: rows and queue messages), `brain-curator` (input: the `brain_curation` queue; output: rows in `brain.items`, `outcomes`, `flags` and `runs`, in one transaction per item) and `brain-mcp`.
- **MCP tools:**

  | Tool | Takes | Returns |
  |---|---|---|
  | `search` | `query`, `kinds?`, `since?` | Items, each with its title, a snippet, `source_ref` and its tier label |
  | `get` | `id` | One item |
  | `decisions` | `topic?`, `status?` | Decisions, agreed by default |
  | `timeline` | `topic` | Items in date order |

**ADRs that apply:** none. This is tooling outside the product repositories.

**Conflicts with ADRs:** none.

## Acceptance criteria and test cases

| # | Criterion | Level | Steps → expected | Test name | Slice |
|---|---|---|---|---|---|
| AC1 | Ingest is idempotent | integration | ingest the same batch twice → one row per `(source, source_id)`; a changed body updates the row and re-queues it | `test_ingest_is_idempotent` | 1 |
| AC2 | Only MyTT gets in | unit | `project='ITT'` → not stored; `project` unset → `intake_review`; `MyTT` → stored | `test_scope_rules_admit_only_mytt` | 1 |
| AC3 | Secrets never reach storage | unit | key, token, PEM and connection-string patterns → redacted before ingest | `test_screen_redacts_secrets` | 2 |
| AC4 | Personal data is screened | unit | phone numbers, emails, ID and IBAN shapes → redacted; ticket ids like `DEV-39397` untouched | `test_screen_redacts_personal_data` | 2 |
| AC5 | Money is screened | unit | amounts, rates and "hours billed" → redacted | `test_screen_redacts_money` | 2 |
| AC6 | Never-published sources are withheld | unit | worklog shortfalls, punctuality, individual time entries → withheld, never sent to the curator | `test_never_published_sources_withheld` | 2 |
| AC7 | Tier rules hold | pgTAP | a tier-3 user reads tier-3 items, and cannot read tier-1 or tier-2 items; a tier-1 user reads all; **a signed-in user with no `brain.members` row reads nothing; `anon` reads nothing** | `brain_items_tier_visibility` | 0 |
| AC8 | The private store is private | pgTAP | any authenticated user other than the owner reads 0 rows from `brain_private.*`, `outcomes` and `flags` | `brain_private_owner_only` | 0 |
| AC9 | The curator's output is valid and complete | integration | a curation file covering N items → N outcomes; invalid JSON or a missing item → nothing written | `test_record_all_or_nothing` | 3 |
| AC10 | A flagged item doesn't publish | integration | `outcome='flagged'` → a `flags` row, no `brain.items` row until review publishes it | `test_flagged_never_published_without_decision` | 3 |
| AC11 | Decisions default to proposed | integration | a decision item without evidence of agreement → stored as `proposed` | `test_decisions_default_to_proposed` | 3 |
| AC12 | The curator call is well formed and validated | unit | the prompt starts with the policy, byte for byte; output failing the schema → one retry → otherwise flagged. **No JSON mode is assumed (D5)** | `test_curator_validates_and_retries` | 3 |
| AC13 | The digest tells the truth | integration | counts match `outcomes`; left-out categories listed; items over the cap shown as waiting | `test_digest_matches_outcomes` | 4 |
| AC14 | The MCP service returns only what the caller may see | integration | signed in as a tier-3 test user → **each of `search`, `get`, `decisions` and `timeline`** returns no tier-1 or tier-2 items and never mentions them; `get` with a known tier-1 id returns not-found, not forbidden | `mcp_tools_respect_tier.test.ts` | 5 |
| AC15 | The access log holds no content | integration | after a `search`, the `access_log` row has the user, tool, row count and time, and no query results, no item text and **no query string** — a query can carry a person's name, so only a SHA-256 of it is stored | `mcp_access_log_has_no_content.test.ts` | 5 |
| AC16 | The neuron budget holds | unit | the day's estimated neurons reach 9,000 → the function stops taking items; the rest stay queued; the digest says so | `budget_guard.test.ts` | 3 |
| AC17 | The free model is at least as cautious as Claude | eval | 30 sources across the kinds: no fact reaches more people than Claude allowed, no category Claude removed survives, and no source goes unanswered | `eval/compare.md` result | 8 |
| AC18 | The gather works end to end | manual | `brain run` in a cloud session → items queued; within the hour the curator has drained them, written the digest and recorded the run. A second `brain run` straight after → no new items, because the watermarks hold | — | 7 |
| AC19 | A batch never overruns | integration | 5 items queued, the deadline is near after 2 → 2 recorded, 3 back on the queue, nothing half-written, and the `brain.runs` row written at the start is closed | `curator_batch_requeues.test.ts` | 3 |
| AC20 | The second screen catches what the first missed | unit | an item in the queue that still contains a key pattern → redacted before the model call, `screen_hits` updated | `curator_rescreens.test.ts` | 3 |
| AC21 | ☁ The ingest endpoint is narrow | integration | no token or a wrong token → 401 and nothing written; a valid token → can write items and watermarks, and a read of `brain_private.items` through it is refused | `ingest_token_is_narrow.test.ts` | 1 |

| AC22 | Nothing publishes until the comparison check passes | integration | `CURATOR_PUBLISH_ENABLED` off → every curated item is flagged and `brain.items` stays empty, whatever the model returned (D10) | `curator_publish_switch.test.ts` | 3 |
| AC23 | The down migration is clean | pgTAP | apply up → down → up → both schemas, both roles, the queue and the cron job are gone after down and correct after the second up; `em_tracker` untouched throughout | `brain_down_migration` | 0 |

Every test fails before its slice exists.

## Unit tests

- **Screen:** no false positives on dates, ticket ids or version numbers; redaction keeps sentences readable (`[redacted: phone]`).
- **Curator function:** a model call that times out → the item goes back to the queue, and after 3 attempts it's flagged `curator timeout`; a refused request (for example, over the free limit) stops the batch cleanly, and the digest says so.
- **Rules:** inserting into `brain.items` as an ordinary user is refused.

## Slices

| # | Slice | Owns | Depends on | Independent? | Runs as | Verified by |
|---|---|---|---|---|---|---|
| 0 | Contract: migrations with rules and pgTAP tests, JSON schemas, the digest's shape, CLI skeleton, MCP tool types | `supabase/migrations/**`, `supabase/tests/**`, `contract/**`, `brain/cli.py` (entry points only), `supabase/functions/_shared/types.ts` | — | — | main, first | AC7, AC8, AC23 against Postgres with pgTAP |
| T | Tests for slices 1–6 | `tests/**`, `supabase/functions/**/*.test.ts`, `supabase/functions/_shared/testing.ts` | 0 | yes | tester | all fail before 1–6 |
| 1 | ☁ Ingest: CLI client, scope rules, the `run` command, `brain-ingest` Edge Function | `brain/ingest.py`, `brain/scope.py`, `brain/run.py`, `supabase/functions/brain-ingest/**` (not tests) | 0 | yes | slice-implementer | AC1, AC2, AC21 |
| 2 | Screen, in both languages | `brain/screen.py`, `brain/patterns.py`, `supabase/functions/_shared/screen.ts` | 0 | yes | slice-implementer | AC3–AC6 |
| 3 | Curator Edge Function: queue, re-screen, Workers AI call, record, budget, digest | `supabase/functions/brain-curator/**` (not tests) | 0 | yes | slice-implementer | AC9–AC12, AC16, AC19, AC20, AC22 |
| 4 | Digest and status | `brain/digest.py`, `brain/status.py`, `brain/api.py` | 0 | yes | slice-implementer | AC13 |
| 5 | MCP Edge Function | `supabase/functions/brain-mcp/**` (not tests) | 0 | yes | slice-implementer | AC14, AC15 |
| 6 | Review CLI | `brain/review.py` | 0 | yes | slice-implementer | AC10 (publishing a flag) |
| P | Publishing policy: one section per tier | `docs/PUBLISHING-POLICY.md` | — | yes | main | read by you |
| 7 | ☁ Cloud scheduled gather: prompt and task — **held by Q2, not built in this phase** | `run/**` | 1, 2, P | no | main | AC18 |
| 8 | Comparison check | `eval/**` | 3, 6, P | no | main | AC17 |
| — | Integrate: all tests, then `brain run --dry` | — | all | — | main | green |
| — | Review: privacy, access rules, correctness | — | integrate | — | reviewer | findings settled |

Slices 1–6 and P own different files, so they run in parallel after the contract.

### Slice details

Briefs follow [plan-template.md](plan-template.md), and are written into the run for each subagent. In short:

- **Slice 0:**
  - first confirms the toolchain. **Confirmed on 24 Nov, in a session:** Python 3.13, uv, Postgres 16 server and Node 22 are present; Deno 2.9.6 installs with `npm install -g deno`; the Supabase CLI 3.4.0 installs from its GitHub release; `postgresql-16-pgtap` installs from apt and brings `pg_prove` with it;
  - **runs pgTAP against a throwaway local Postgres, with stand-ins for `auth.uid()` and the Supabase roles.** `supabase start` was tried and does not work: Docker is installed but its daemon must be started by hand (`sudo dockerd &`), and even then the image pulls fail because `public.ecr.aws` is not resolvable through the environment's network allowlist. Adding the registry domains to the environment would make the real stack available and would be the better test — see [cloud-setup.md](cloud-setup.md) — but it is not a blocker, so the stand-in path is what slice 0 uses;
  - note that `initdb` and `pg_ctl` refuse to run as root, so the harness starts the cluster as the `postgres` user;
  - writes an `up` and a `down` migration, and tests the pair with AC23;
  - **puts the tier check in one SQL function** used by every policy, rather than repeating the comparison. Tier 1 is both the most privileged and the most restrictive default, and the rule reads `members.tier <= items.tier`, so the ordering is inverted twice and one flipped comparison would send governance material to delivery. pgTAP tests the function directly as well as through the tables;
  - fixes the digest's shape, and the screen and ingest-client signatures that `brain/run.py` depends on.
- **Slice 1:**
  - **`brain-ingest`:** checks the ingest token (D12), validates the batch against `ingest-batch`, re-screens, applies the scope rules, upserts on `(source, source_id)` with a SHA-256 hash of the body, re-queues an item whose body changed, and updates watermarks, in one transaction per batch;
  - **`brain ingest`:** posts screened inbox files to it, with the token from the environment (`BRAIN_INGEST_TOKEN`, or the cloud environment's network secret);
  - **`brain run [--dry]`:** gathers through the connectors available in the session, screens, and ingests. This is the only gather in Phase 0 while slice 7 is held, so it is a deliverable, not a wrapper;
  - confirms what the environment's proxy injects for the project host before deployment (D12);
  - seeds MyTT as the only scope rule.
- **Slice 2:**
  - **patterns:** secrets (common key prefixes, JWTs, PEM, URLs carrying credentials); personal data (phone numbers including +1-868 and +92, emails, long digit runs, IBAN shapes); money (amounts with currencies, rates);
  - **never published:** a list of sources;
  - **always allowed:** ticket ids.
- **Slice 3:** a Deno Edge Function, `brain-curator`, which:
  - opens a `brain.runs` row, then reads up to `CURATOR_BATCH_SIZE` items (default 3) from the `brain_curation` queue;
  - re-screens each one with `contract/patterns.json`;
  - calls the Workers AI REST endpoint (`/accounts/{id}/ai/run/{CF_MODEL}`), with the policy as a fixed prefix, a capped `max_tokens` and a per-call timeout. **It probes function calling for structured output first; there is no JSON mode on this model** (D5);
  - validates the output against the curation schema, retrying once;
  - writes each item's results in one transaction, as `brain_curator`;
  - bills the neuron budget from the token counts in each response, and refuses to start an item that will not fit in what is left of the day;
  - **publishes nothing while `CURATOR_PUBLISH_ENABLED` is off** — every item is flagged instead (D10, AC22);
  - returns unfinished items to the queue before its own deadline, and closes the `brain.runs` row;
  - writes the day's digest after the last batch.

  The policy text is deployed with the function, so changing the policy means redeploying it. The model id, the batch size and the publish switch are Edge Function secrets, so none of those needs a redeploy.
- **Slice 4:** the `brain digest` and `brain status` commands, which read `brain_private.digests` and `brain.runs` through Supabase's REST API signed in as you. The digest's shape itself is fixed in slice 0, because the curator writes it and this slice only reads it. The digest shows:
  - counts per outcome and per tier;
  - neurons spent, and neurons per item;
  - new items;
  - flags waiting;
  - categories left out;
  - items waiting because of the cap;
  - the freshness of each source.

  `brain status` shows the last run, the queue depth, each source's watermark and **the database size against the free plan's allowance** — `brain_private` copies gathered text into a database that was 42MB of about 500MB on 24 Nov, and transcripts are the bulk of what is being copied.
- **Slice 5:**
  - a Deno Edge Function that speaks MCP over HTTP;
  - OAuth through Supabase Auth;
  - queries run with the caller's own token;
  - full-text search over `brain.items`;
  - writes the `access_log`;
  - comes with a README on connecting Claude Code, Claude Desktop and claude.ai.
- **Slice 6:** `brain review` is an interactive terminal list of flags (publish, edit or withhold), with `--list` for a non-interactive view. It writes through Supabase's REST API signed in as you, the owner.
- **Slice P:** adds the tier 1, 2 and 3 sections to the publishing policy, with an example of one source written for each tier. The rules that already exist are kept.
- **Slice 7 ☁ — held by Q2.** Not built in this phase. Written up here so it can be picked up unchanged once a hand-started `brain run` has passed AC18:
  - **`run/gather.md`:** the prompt the scheduled task runs. It lists the read-only connector calls, scoped to MyTT: Supabase (`em_tracker` reads), ClickUp (tasks, comments, sprints, approved chat channels) and Google Sheets (the three tabs). It reads the watermarks, gathers what changed, then runs `brain run` to screen and ingest;
  - **`run/README.md`:** how to create the task at claude.ai/code/routines on this repository, with cron `0 */3 * * *`, the environment from [cloud-setup.md](cloud-setup.md), and the exact connector tools to allow so it runs unattended;
  - **the task is created after AC18 passes** in a hand-started session, and after you sign off this slice separately.
- **Slice 8:** samples 30 sources across the kinds, curates them with both the Workers AI model of the day (through a dry-run mode of the curator function, which writes nothing) and Claude, compares tiers and left-out categories, and writes the result. The curator publishes only after this passes — that is, until `CURATOR_PUBLISH_ENABLED` is turned on.
  - It also **measures what D5 and D7 currently estimate:** tokens in and out per source, items written per source, and therefore neurons per item and items a day. Those figures replace the estimates in D8 before any schedule is promised.
  - It runs again, in full, on any change of model.

## Inventory changes

| Kind | Name | Change | Where |
|---|---|---|---|
| Schemas, roles | `brain_private`, `brain`, `brain_intake`, `brain_curator` | added | Supabase, through your migration |
| Edge Functions | `brain-ingest`, `brain-curator`, `brain-mcp` | added | Supabase |
| Queue, cron job | `brain_curation`, `brain-curator-every-10-min` | added | Supabase, through your migration |
| API token | `mytt-brain-curator` (Workers AI only) | added | Cloudflare |
| Tool | `brain` CLI | added | this repository |
| Scheduled task | `mytt-brain-gather` (every 3 hours) | **deferred — slice 7 is held (Q2)** | claude.ai/code/routines |

## Breaking changes

None. `em_tracker` and every other source is only read.

## Environment configuration

| Name | Kind | Where it lives | Set by |
|---|---|---|---|
| Supabase project URL and anon key | config | `.env.example`, and the cloud environment's variables; the anon key is public by design | — |
| Your own sign-in token | secret | `SUPABASE_ACCESS_TOKEN` in your shell. `review`, `digest` and `status` read as you, so they need your token rather than a key | you |
| **Exposed schemas** | config | Supabase dashboard → API settings. **`brain` and `brain_private` must be added**, or PostgREST serves neither and every CLI command returns 404. Found while building slice 4. Exposing a schema weakens nothing: row level security still decides every row | you, before slice 4 is used |
| `brain_intake` connection | secret | Edge Function secret `BRAIN_INTAKE_DB_URL` | you, after the migration |
| `brain_curator` connection | secret | Edge Function secret `BRAIN_CURATOR_DB_URL` | you, after the migration |
| Ingest token | secret | Edge Function secret `BRAIN_INGEST_TOKEN`, and a **network secret** in the cloud environment for the project's host, sent as `X-Brain-Ingest-Token` and never as `Authorization` (D12) | you |
| Cloudflare account id | config | Edge Function secret `CF_ACCOUNT_ID` | you |
| Cloudflare API token (Workers AI scope only) | secret | Edge Function secret `CF_API_TOKEN` | you |
| Curator model id | config | Edge Function secret `CF_MODEL`, default `@cf/google/gemma-4-26b-a4b-it` | you, changed without a redeploy (D5) |
| Curator batch size | config | Edge Function secret `CURATOR_BATCH_SIZE`, default 3 | you (D8) |
| Publish switch | config | Edge Function secret `CURATOR_PUBLISH_ENABLED`, **off until AC17 passes** | you (D10, AC22) |

No secret is ever written to the repository or a file. Edge Function secrets are set with `supabase secrets set`, or in the dashboard. **Cloud environment variables are visible to everyone who can use the environment, so secrets go in network secrets, never in variables.**

## Rollout & rollback

- **Release:**
  1. Apply the migration, then add `brain` and `brain_private` to the project's exposed schemas.
  2. Create the Cloudflare API token and the ingest token, and set the Edge Function secrets.
  3. Deploy the `brain-ingest`, `brain-curator` and `brain-mcp` Edge Functions, once every automated test (AC1–AC16, AC19–AC23) passes. `CURATOR_PUBLISH_ENABLED` stays off.
  4. Unpause the cron job (the migration creates it paused) and do a hand-started `brain run` in a session; read the digest (AC18). Everything is flagged at this point, by design.
  5. Run the comparison check (AC17) on the real material the backfill has gathered, and read its measured neurons-per-item back into D8.
  6. Turn `CURATOR_PUBLISH_ENABLED` on, and re-curate the flagged backlog.
  7. Connect Claude to the MCP service.
  8. **Later, separately signed off:** build slice 7 and create the cloud scheduled task.
- **Watch:** the daily digest. For the first week, read every published item and tune the policy.
- **Roll back when:** anything sensitive appears in a team item, or the access rules fail a test.
- **Roll back how:**
  1. Turn `CURATOR_PUBLISH_ENABLED` off, pause the cron job (`cron.alter_job`), and pause the cloud scheduled task if it exists by then.
  2. Withhold the affected items (`brain review --withhold`).
  3. Fix the policy or screen, then re-curate.
  4. If needed, run the down migration, which drops both schemas and both roles (`brain_intake` and `brain_curator`), the queue and the cron job. `em_tracker` is untouched.
- **Who decides:** you.

## Accessibility

None. There's no user interface beyond the terminal.

## Assumptions & Dependencies

- **Your steps** (all in [cloud-setup.md](cloud-setup.md)):
  - connect the Supabase, ClickUp and Google Sheets connectors at claude.ai;
  - create the cloud environment: network access, network secrets and the setup script;
  - create a Cloudflare account, or use an existing one, and an API token scoped to Workers AI only;
  - apply the migration, and set the Edge Function secrets.
- **Assumes:**
  - `@cf/google/gemma-4-26b-a4b-it` stays on the free allowance and stays live. It is not currently deprecated, but Cloudflare retired 24 models on about two weeks' notice on 20 November, which is why the model id is a secret rather than a constant (D5). **Check the deprecation list before each phase.**
  - The free model can judge tier boundaries at all. AC17 is the test of that, and until it passes nothing publishes.
  - Your claude.ai connectors stay signed in.
  - The free Supabase plan stays active, which the cron job and the gathers ensure.
  - Edge Function time limits on the free plan (150s wall clock, 2s CPU, 256MB) leave room for a batch of 3 calls to Workers AI. The batch size is a secret, lowered further if not.
  - Supabase Auth's OAuth server is available on the free plan. The project's `auth` schema has its tables; slice 5 confirms it first.
  - ☁ Cloud scheduled tasks allow a 3-hour interval and can run connector tools without a person approving each call. Slice 7 confirms both.
  - ☁ The Deno suites import nothing from the network. `jsr.io` is outside the environment's allowlist, so `jsr:@std/assert` cannot be fetched; the suites use Deno's built-in `node:assert` through `supabase/functions/_shared/testing.ts` instead. Adding `jsr.io` to the allowlist would widen what the Edge Functions may import, which is worth deciding deliberately rather than by accident.
  - ☁ The cloud environment can install Deno and the Supabase CLI. Postgres 16, Node and Docker are already present (checked 24 Nov), so `supabase start` is the pgTAP path rather than a bare Postgres with stand-ins. Slice 0 confirms the rest.

## Risks & Impediments

- **The model is retired.** This already happened once, to the model an earlier draft of this plan named, four days before sign-off. Calls return 410 with error 5028 and curation stops dead. The model id is a secret so the swap is a one-line change, but it also means re-running AC17. Watch Cloudflare's deprecation changelog.
- **The free allowance changes or the model moves to paid.** The budget guard stops cleanly, the digest says so, and D5's fallback applies. Nothing is charged on the free plan.
- **Cloudflare's data terms change.** Re-check the Workers AI data-usage page before Phase 1 widens access.
- **The free model misjudges boundaries.** The screen runs first, the default is tier 1 and flag, the comparison check gates the model (D10), and you're the only member in Phase 0.
- **The neuron estimate is wrong.** The first run measures real usage, and the cap is adjusted to match.
- **Supabase's OAuth server is missing or limited on the free plan.** Then the MCP service falls back to a personal access token, which you create in the portal. This is a small change inside slice 5.
- **☁ A scheduled run stalls on a connector approval.** Then nothing is gathered and the digest's freshness line shows it. Fix by allowing the tool in the task's settings; the watermarks mean nothing is lost.
- **☁ The ingest token leaks.** It can only add private items, which the screen and curator still process, and it can't read anything. Rotate it in both places (Edge Function secret and network secret).
- **The cron job stops** (for example, the project is paused). The digest goes quiet; `brain status` shows the last run and the queue depth. Because the `pg_net` call is fire-and-forget (D8), a batch that fails leaves no HTTP error anywhere — the `brain.runs` row opened at the start of each batch is the only evidence, which is why it is opened at the start.
- **The free database fills up.** `brain_private` copies gathered text, transcripts included, into a database that was 42MB of about 500MB on 24 Nov. `brain status` reports the size; a retention rule for raw transcripts is a Phase 1 decision.

## Queries

| # | Question | For | Answer |
|---|---|---|---|
| Q1 | Should the Cloudflare account be company-owned or personal? MyTT text passes through it, though it isn't kept (D6) | Usman | Personal (24 Nov) |
| Q2 | ☁ Do you sign off the cloud changes (D2, D6, D8, D12, slices 1 and 7, AC21)? | Usman | **Signed off except slice 7 (24 Nov).** D2, D6, D8, D12, slice 1 and AC21 are approved and unblocked. The scheduled gather is held until a hand-started `brain run` has passed AC18 and is signed off on its own |
| Q3 | ☁ Meeting notes: copy `mytt/meetings/` into this repository's `meetings/`, or leave that source for Phase 1? | Usman | **Neither (24 Nov).** Meetings reach the brain through Supabase, where most of the material already is: `em_tracker.meetings`, `meeting_items` and `transcript_sentences`. The repository's `meetings/` folder is dropped from the allowlist and the local notes move to Phase 1 |
| Q4 | Should the backfill be paid for? About 83,000 neurons, roughly $0.92 of overage on a Workers Paid plan, against 5–9 days on the free allowance. Nothing depends on it finishing (D8) | Usman | Waiting — the free path is the default and needs no answer |

## Additional notes

Phase 1 then:
- adds team members and their tiers (no rebuild);
- adds code snapshots and Google Chat;
- may add vector search, using Supabase's built-in small embedding model on both sides.

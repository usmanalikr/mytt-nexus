# MyTT Brain: design proposal

| | |
|---|---|
| **Author** | Usman Ali, with Claude Code (Opus 5.5) |
| **Date** | 23 Nov 2026 |
| **Status** | Proposal. Q1 and Q9 decided 23 Nov, Q8 on 24 Nov; waiting for Q2 to Q7 and sign-off |

## Overview

One place that knows MyTT, built from:
- meetings;
- both backlogs: ClickUp, and the stakeholder sheet;
- sprints;
- ClickUp Chat and Google Chat;
- decisions;
- a summarised snapshot of the code and architecture.

People and agents reach it through an **MCP service**. Access is controlled by person and group from a **small portal**, because some of the content is sensitive. The brain can **propose** changes to ClickUp and the sheet, and a person approves each one before it's applied.

## What already exists (verified 23 Nov)

Much of the brain is already being built in Supabase, in the `em_tracker` schema of project `qhvdbmbxgrkolqddohzf`. Row-level security is on for every table.

| Area | Tables (rows) | Fresh as of |
|---|---|---|
| ClickUp tasks | `tasks` (1,075), `task_snapshot` (34,179), `task_status_time`, `task_comments` (437), `time_entries` (867), `clickup_lists` | 22 Nov; comments only up to 6 Nov |
| Sprints | `sprints` (7), `sprint_metrics`, `burnup_daily` | 22 Nov |
| Meetings (Fireflies) | `meetings` (31), `meeting_items` (571), `meeting_transcripts`, `transcript_sentences` (10,223) | 22 Nov |
| Code delivery | `pull_requests` (762), `pr_reviews`, `review_metrics`, `sonar_snapshots`, `quality_stability_daily` | 22 Nov |
| Risk and attention | `risks`, `incidents`, `attention_items`, `radar_items` | — |
| People | `team_members` (ClickUp ↔ GitHub, confirmed by a person) | — |
| Access | `allowed_viewers` (1 row) | — |

Outside Supabase:
- `mytt/meetings/` (11 notes);
- `DECISIONS.md` and `gap-analysis/decisions.md`;
- each repository's `docs/adr/`;
- generated inventories;
- the graphify graphs, with Obsidian vaults.

**So this is not a greenfield build, but the brain is not `em_tracker` either.** The tracker serves the EM dashboard, and it covers more than MyTT. Of its 31 meetings:
- 24 are tagged `MyTT`;
- 1 each are tagged `AskTT`, `ITT` and `InsightTT`;
- 1 is project-related but has no project set;
- 3 are not project meetings at all.

The brain reuses the tracker's database and its loaders, but **lives in its own `brain` schema and takes in only MyTT material** (see *Scope* below). The brain adds what's missing on top of what exists:
- the missing sources (chats, the stakeholder sheet, Wispr Flow, local notes, code snapshots);
- a decisions register;
- linking across sources;
- access control finer than a single viewer list;
- an MCP service;
- a proposals flow.

## Two tiers: gather everything privately, publish what the team needs

**Decided 23 Nov.** The brain has two layers:

| Layer | Schema | Holds | Who can read it |
|---|---|---|---|
| **Private store** | `brain_private` | Everything gathered, as it came: transcripts, chat messages, sheet rows, comments, notes | **You only** |
| **Team layer** | `brain` | Curated items: summaries, decisions, action items, status, architecture. Each is written for the team, with sensitive details left out | The team, through the MCP service |

A **scheduled run** does the work in four steps:

1. **Gather.** Loaders pull every source into `brain_private`. The MyTT scope rules apply here.
2. **Screen.** Deterministic checks run first, with no model involved:
   - secret patterns (keys, tokens, connection strings);
   - personal data (phone numbers, emails, ID and account numbers);
   - money and rate figures;
   - sources that are never published, such as punctuality and work-log shortfalls.
   Anything they catch is withheld or redacted before the agent sees it.
3. **Curate.** A curator agent reads what's new against the **publishing policy** ([PUBLISHING-POLICY.md](PUBLISHING-POLICY.md)). It writes team items that keep what the team needs (scope, decisions, deadlines, blockers, technical facts, who owns what) and leave out the rest. For every source it records one of three outcomes:
   - **published:** a team item was written, with the details it left out listed for you;
   - **withheld:** nothing the team needs, or entirely sensitive;
   - **flagged:** it can't tell, or the item is sensitive but important.
4. **Review.** Flagged items wait in `brain_private.flags` until you publish, edit or withhold each one. **Nothing flagged reaches the team without your decision.** The run ends with a short digest for you: what was published, what was withheld and why, and what's flagged.

What this changes from the label design:
- **No hand-labelling of sources.** The curator decides item by item, which suits mixed sources. One meeting can have a team-relevant decision and a commercial aside two minutes apart.
- **When unsure, it withholds.** A wrongly withheld item costs you a click in the review queue. A wrongly published one can't be taken back.
- **Team items cite their source without exposing it.** For example, "from the 12 Nov roadmap meeting (private)". You can open the original; the team sees only that it exists.
- **The access model shrinks.** For now there is one team audience. Groups and labels stay possible inside the team layer, for example a client-shared audience (Q8). They're not needed to start.
- **Policy changes can be re-applied.** Because the private store keeps the originals, changing the policy and re-running the curator brings the team layer up to date.

## Access tiers for the team layer (decided 24 Nov)

The team layer is a ladder. Each item gets the lowest tier allowed to see it, and a person sees an item if their tier is at or above the item's.

| Tier | Who | Sees |
|---|---|---|
| **1. Governance** | The governance team only: tech lead and PM | Everything in the team layer: commercial terms, estimates, contract and scope matters, staffing, programme risks |
| **2. Leads** | Tier 1 plus team leads | Tiers 2 and 3: delivery planning, cross-team risks and dependencies, internal estimates, allocation of work |
| **3. Delivery** | Developers, QA, people on the ground | Tier 3: scope, decisions, tickets, deadlines, blockers, technical facts |

- **Stakeholders are not part of the brain.** There is no client audience, and nothing is written for one.
- **One source becomes several items, one per tier.** The curator writes each fact at each tier with the right amount of detail. For example, tier 3 gets "Release moved to 5 Dec", while tier 1 also gets the commercial reason. The publishing policy has one section per tier, and every item records the source it came from.
- **When unsure, the most restricted tier.** The curator picks tier 1 and flags the item. Moving an item down later is easy; pulling it back up after people have read it isn't.
- **Release down on a condition.** An item can carry a "release to tier N when …" condition, such as an estimate once it's agreed. The release happens when you confirm it.
- **Hidden, not blocked.** The MCP service never says that an item exists at a tier the person can't see.
- **Optional topic compartments** (for example `security`) can narrow an item further within a tier. They're not needed to start.
- **Membership is by group:** `governance`, `leads` and `delivery`. Every change of membership is logged.
- **The access rules are tested with pgTAP** (available on the project), one test per tier, before any change to the rules goes live.
- **The owner's private store and members' personas sit outside the ladder.**

## Three tiers, with personas kept on each member's machine (decided 24 Nov)

| Tier | Holds | Where it lives | Who reads it |
|---|---|---|---|
| **Central** | The curated team layer: decisions, scope, status, architecture, action items | Supabase, `brain` schema | The whole team |
| **Guarded** | Material for named groups only, and the owner's private store | Supabase, under group grants | Members of that group |
| **Personal (persona)** | How one member works, their context, timeline and open loops | **That member's machine only** | That member's own assistant |

### The persona

**What it holds:**
- **How they work:** workflow, review habits, repeated steps, conventions, corrections.
- **Preferences:** when to ask and when to decide, the format and level of detail they want, how they write.
- **Context:** current focus, active tickets and branches.
- **Timeline and open loops:** what they did and when, and what they owe or are waiting on.

**What it's for:** making that member's own assistant faster and more accurate. It means no re-explaining, it suggests skills for repeated steps, it recalls ("when did we do X, and what came after?"), and it produces plans and drafts shaped the way that member works. Claude Code's memory notes are an early version of exactly this.

**How it's used:** for traversal only. The member's assistant reads the persona locally and uses it to shape questions to the brain and to combine the brain's answers with the member's own context. It's never uploaded, synced or copied into the brain.

**Rules:**
1. **It stays on the member's machine.** It is not stored, synced or backed up by the brain.
2. **Logs never hold persona text.** The brain's access log records who asked, which tool and how many rows came back.
3. **Disk encryption is required:** FileVault, BitLocker or the equivalent, turned on. The persona file itself is plain text.
4. **The member owns it.** It's opt-in per source, the member can see, edit and delete everything, and switching it off deletes it.
5. **It records how someone works, never how long.** No keystrokes, active time, hours or activity logs.
6. **It's never used to evaluate people.** Nobody can query another member's persona, and nothing from it appears in team reports.
7. **It travels only into model calls,** as part of that member's own session prompt, the same way Claude Code memory does.

**Built from** sources on the member's own machine that they switch on:
- their Claude Code session history and memory notes;
- their git commits across the MyTT repositories;
- their ClickUp items and meeting actions, read from the central tier;
- notes or Wispr Flow exports in a folder they choose.

Shell history, browsers, email and private chats are never read.

**Rollout:** start with the owner's own persona, then offer it to others on an opt-in basis.

## Scope: only MyTT gets in

**Decided (Q1, 23 Nov):** the brain lives **outside `em_tracker`**, in its own `brain` schema in the same database. `em_tracker` stays the EM dashboard's store, with its own access, and its loaders keep running unchanged.

- **Copy in, don't expose.** A brain intake job copies in-scope rows from `em_tracker` into `brain.items`. People and agents using the brain are given **no rights on `em_tracker` at all**. The brain's access rules stand on their own, and a meeting from another project can't be reached through a view.
- **An allow-list decides what is MyTT** (`brain.scope_rules`, one rule per source):

  | Source | In scope when |
  |---|---|
  | `em_tracker.meetings` and their items and transcripts | `project` is `MyTT`, or another name on the list (see Q7) |
  | `em_tracker.tasks`, sprints, comments, time | The task's list is in the MyTT ClickUp space or folder |
  | `em_tracker.pull_requests`, reviews, Sonar | The repository is one of the MyTT repositories |
  | Chats | The ClickUp Chat channel or Google Chat space is on the list |
  | Sheet, local notes, repositories | Always: these are MyTT-only sources |

- **Anything unclear goes to a holding queue**, `brain.intake_review`, rather than into the brain. A person decides in the portal, and the decision becomes a rule. That covers a project-related meeting with no project set (there is one today) and a new chat channel. Nothing reaches the brain on a guess.
- **The intake job runs with its own database role.** That role can read `em_tracker` and write `brain`; nothing else can do both.

## Design

```
 Sources                    Store (Postgres, one schema per concern)            Access
 ────────                   ─────────────────────────────────────────            ──────
 ClickUp tasks, sprints ─┐  em_tracker.*   (existing loaders, unchanged; no brain access)
 Fireflies meetings ─────┤        │ intake: scope rules, copy MyTT rows only
 ClickUp Chat ───────────┤        ▼            (unclear → brain.intake_review)
 Google Chat ────────────┼─▶ brain.items  ── one row per thing, with a label ──▶ RLS ──▶ MCP service ──▶ Claude / agents
 Stakeholder sheet ──────┤   brain.links  ── mentions, decides, traces-to          │        │
 Wispr Flow, meetings/ ──┤   brain.decisions ── curated register                   │        └─▶ portal: access, decisions,
 Repos: ADRs, inventories┘   brain.snapshots ── code and architecture, per repo    │            proposals, audit
                             brain.proposals ── changes waiting for approval       │
                             brain.groups, members, label_grants, access_log ──────┘
```

### 1. One table of things

`brain.items` has one row per meeting, meeting item, ticket, backlog row, sprint, chat thread, decision, ADR, code snapshot or note. Each row carries:
- `kind`;
- `source` and `source_id`, so a re-sync updates the row rather than duplicating it;
- `url`, linking back to the original;
- `title`, `summary` and `body`;
- `occurred_at` and `people`;
- **`label`**, which sets who may see the row;
- a full-text index, and later an embedding.

Existing `em_tracker` data reaches it through the intake job, which copies only in-scope rows (see *Scope*). The tracker's loaders keep working unchanged.

`brain.links` connects items across sources:
- "meeting item → ClickUp task";
- "backlog row → ClickUp task", which keeps every backlog row traceable;
- "decision → the meeting or chat it came from";
- "decision → the ADR that records it";
- "decision supersedes decision".

### 2. A decisions register people can trust

`brain.decisions` holds each decision's:
- statement and scope;
- status: `proposed`, `agreed` or `superseded`;
- `decided_at` and who decided;
- sources, always cited;
- what it supersedes, and the ADR that records it.

The extractor reads meetings, chats and ADRs and only ever creates **proposed** decisions. A person confirms each one in the portal before it becomes **agreed**. Without that step, every passing remark in a meeting would read as policy.

### 3. Code and architecture snapshots

`brain.snapshots` stores one short summary per repository, regenerated after merges. It covers:
- the apps and services;
- the stack;
- the ADR list and the decisions in force;
- the main modules, from graphify's communities;
- the page and component inventories;
- known gaps.

It deliberately does not store the 20,798-node code graph. That stays in graphify for agents that need to dig into the code. The brain holds the overview a person or an agent reads first.

### 4. Access, enforced in the database

> **Superseded for Phase 0 by the tier ladder.** The label-and-group model below was the 23 Nov design. Q8, decided 24 Nov, replaced it with the three-tier ladder in *Access tiers* above, and [plan-phase-0.md](plan-phase-0.md) implements that: `brain.items.tier` as a smallint, `brain.members(user_id, tier)`, and a row visible when `members.tier <= items.tier`. There are no labels, groups or `label_grants` in Phase 0. This section is kept because the compartment idea in it is still the likely shape for Phase 3, where one team audience is no longer enough.

- **Labels on every item:**
  - `team`;
  - `phaedra-internal`;
  - `leadership`;
  - `client-shared`, for what Vantiqa and stakeholders may see;
  - `restricted`.
- **Label rules** set a label automatically by source. For example: this chat space is `leadership`, the stakeholder sheet is `client-shared`, and HR and punctuality data is `restricted`.
- **Groups and grants** give each group the labels it may read.
- **RLS policies** on every `brain` table check the caller's groups. The MCP service queries **as the caller**, using their own sign-in token, never with the service key. So a bug in the MCP service or the portal can't leak a row the database wouldn't return to that person.
- **`brain.access_log`** records who asked what, through which tool, and how many rows came back.

### 5. The MCP service

A remote MCP server. Users sign in with Google through Supabase Auth, and Claude Code, Claude Desktop and claude.ai connect to it as a connector. Its tools:

| Tool | Returns |
|---|---|
| `search(query, kinds?, since?, people?)` | Matching items, each with a link and its label |
| `get(id)` | One item with its links |
| `decisions(topic?, status?)` | The register, agreed decisions by default |
| `timeline(entity)` | Everything about a ticket, backlog row, feature or person, in date order |
| `sprint(name?)` | Scope, progress, risks and carry-over |
| `backlog_row(id)` | The stakeholder row, its ClickUp task, and the meetings and decisions behind it |
| `architecture(repo?)` | The latest snapshot |
| `propose_change(target, change, reason, sources)` | Creates a proposal. **Nothing is applied** |

### 6. Proposals (write-back)

`brain.proposals` holds:
- the target: a ClickUp task, the sheet, or a list;
- the exact change;
- the reason and the source items behind it;
- a status: `pending`, `approved`, `rejected` or `applied`.

Someone with rights approves each proposal in the portal, and only then does a worker apply it through the connector and record the result. Edits Shyam makes directly in the sheet always win; the brain never overwrites a cell it hasn't proposed and had approved.

### 7. The portal

A small web app on Supabase Auth with five pages:
- **People & groups**;
- **Labels**: the rules per source, channel or folder;
- **Decisions**: confirm, edit, reject or supersede;
- **Proposals**: approve or reject;
- **Access log**.

It could grow out of the existing EM dashboard, which already sits on `em_tracker` and has an `allowed_viewers` list.

## Sources: how each one gets in

| Source | Route | Status |
|---|---|---|
| ClickUp tasks, comments, sprints, time | existing `em_tracker` loaders | Running; comments stale since 6 Nov |
| Fireflies meetings | existing loader | Running |
| ClickUp Chat | ClickUp connector (`get_chat_channels`, `get_chat_channel_messages`, replies) | New loader |
| Google Chat | Google Chat API with a service account or a user OAuth token; needs Workspace admin consent | New; no connector here |
| Stakeholder sheet | Sheets API reading ranges; the Drive reader returns only sample rows | New loader |
| Wispr Flow | No public API that I know of. Export notes to a folder, which a file loader picks up | Needs Q4 |
| `mytt/meetings/` | File loader | **Phase 1** (Q3, 24 Nov): meetings reach the brain through `em_tracker` instead, where most of the material already is |
| Repos (ADRs, inventories, graphify summaries, `DECISIONS.md`) | Git loader after merge, which also builds the snapshots | New |

Each loader is idempotent on `(source, source_id)`, records its freshness in `sync_log`, and runs on a schedule: hourly for chats, daily for ClickUp and the sheet, after each merge for code.

## Phases

| Phase | Delivers | Who sees it |
|---|---|---|
| **0. Private gather and curate** | `brain_private` and `brain` schemas; the scheduled run (gather, screen, curate, review); the publishing policy; your daily digest and review queue. Nothing is shared yet, so you can judge the curator's output first | You |
| **1. Read-only core** | `brain` schema, **tiers** and RLS; scope rules, the intake job from `em_tracker` and the holding queue; the sheet and local-meetings loaders; code snapshots; the MCP service with `search`, `get`, `sprint`, `backlog_row` and `architecture` | You |
| **2. Decisions and chats** | Decision extraction, confirmed in a minimal portal page; the `decisions` and `timeline` tools; ClickUp Chat; Google Chat once access is granted | You |
| **3. Team rollout** | Portal pages for groups, labels and the access log; label rules for every source; invite the team | Team, by group |
| **4. Proposals and search** | `propose_change` with approval and apply; embeddings (pgvector) for hybrid search; per-person Obsidian export within their labels | Team |

Each phase gets its own plan from the template, signed off before it's built.

## Decisions needed before Phase 1

| # | Question | Options |
|---|---|---|
| Q1 | Where does the brain live? | **Decided 23 Nov:** in its own `brain` schema in the same database, outside `em_tracker`. It reuses the tracker's data through a MyTT-only intake (see *Scope*) |
| Q8 | Audiences for the team layer | **Decided 24 Nov:** a three-tier ladder (governance, leads, delivery; see *Access tiers*). Stakeholders are not part of the brain |
| Q9 | Where the scheduled run executes | **Decided 23 Nov:** a Claude Code scheduled task on Usman's Mac for Phase 0. **Changed 24 Nov:** the gather runs as a Claude Code cloud scheduled task (claude.ai/code/routines) using Usman's claude.ai connectors, so it doesn't depend on the Mac. See D6 and D8 in [plan-phase-0.md](plan-phase-0.md). It still moves to a server job, with its own credentials per source, before the team relies on it. **Held 24 Nov:** the scheduled task itself (slice 7) is not built in Phase 0; the gather is started by hand until it has proved itself (Q2 in the plan) |
| Q7 | Which tracker projects count as MyTT? | `MyTT` for certain. **AskTT** is MyTT's assistant (`ai-service`, `asktt-kb-scraper`). Is it in? `ITT` and `InsightTT` look like separate projects, so out unless you say otherwise |
| Q2 | Labels and groups to start with | **Superseded by Q8 (24 Nov).** The three-tier ladder replaces labels and groups for Phases 0 and 1. The question returns in Phase 3, when one team audience stops being enough. Phase 0 needs only your own tier-1 membership row |
| Q3 | Google Chat access | Can a Workspace admin approve a service account or app for the Chat API, and which spaces should it read? |
| Q4 | Wispr Flow | What does it hold: dictated notes or meeting notes? How can they be exported? |
| Q5 | Where the MCP service runs | Supabase Edge Functions, next to the data; or a small Node service (on Vercel or similar) |
| Q6 | Who confirms decisions | Just you, or named people per area? |

## Risks

- **Sensitive content in chats and transcripts.** The existing rule that `exec_summary` contains no individual names should carry into the brain's summaries. `restricted` is the default label for any new source until a rule says otherwise.
- **Material from other projects leaking in.** This is the reason for the allow-list, the holding queue, and the intake role being the only bridge between the two schemas.
- **The curator misjudges.** There are three guards: the deterministic screen runs before the model; the curator withholds or flags when unsure; and the digest lists what was left out of each published item, so you can spot a pattern and tighten the policy. During Phase 0 nothing is shared, so the policy can be tuned on real output first.
- **The private store is the most sensitive thing in the system.** It's readable by you alone. It holds no credentials, because the screen redacts them before storage. It lives in its own schema, and only the curator's role may read it.
- **Extraction errors.** This is why decisions start as `proposed`, and every answer cites its source.
- **Getting into Google Chat** depends on Workspace admin consent (Q3).
- **Stale sources:** ClickUp comments have not synced since 6 Nov. The MCP shows each source's freshness in its answers.
- **Cost:** summarising and extracting from chats and meetings spends model tokens on every sync. Loaders summarise only what's new.


# MyTT Brain

A central, tiered knowledge base for MyTT, built in Supabase and reached through an MCP service. Phase 0 builds it for one member (Usman, tier 1) to prove the gathering, screening, curation and access rules on real data before the team joins.

- **Plan:** [docs/plan-phase-0.md](docs/plan-phase-0.md)
- **Design:** [docs/DESIGN.md](docs/DESIGN.md)
- **Publishing policy:** [docs/PUBLISHING-POLICY.md](docs/PUBLISHING-POLICY.md)
- **Setting up Claude Code on the web:** [docs/cloud-setup.md](docs/cloud-setup.md)

## Status

Planning done; nothing built yet. The plan was signed off on 24 Nov 2026 for a Mac-based gather, then revised the same day for Claude Code on the web. The cloud changes were signed off on 24 Nov **except the scheduled gather** (slice 7), which is held until a hand-started run has proved itself (Q2 in the plan).

The plan was reviewed on 24 Nov and corrected: the curator's model had been retired by Cloudflare four days earlier, the batch size didn't fit a free Edge Function, and two CLI commands had no owning slice. See the plan's Queries table for what was settled.

## How it fits together

1. A Claude Code **cloud scheduled task** gathers what changed in MyTT's sources every 3 hours, through claude.ai connectors.
2. It **screens** the items by rule (secrets, personal data, money) and posts them to the **`brain-ingest`** Edge Function, which stores them privately and queues them.
3. The **`brain-curator`** Edge Function runs every 10 minutes. It has Gemma 4 26B on Cloudflare Workers AI (free) write team items for each access tier, and flags anything it's unsure of. It publishes nothing at all until the comparison check against Claude has passed.
4. People and agents query the team layer through the **`brain-mcp`** Edge Function, which only returns what the caller's tier may see.

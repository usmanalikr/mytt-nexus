# Cloud setup: one-time steps before the first web session

Do these in order. Every step uses your own claude.ai account, the one that will run the sessions.

## 1. Put this folder on GitHub

1. Create a **private** repository at https://github.com/new, for example `mytt-brain`. Don't add a README, `.gitignore` or licence, because this folder has them.
2. Upload this folder's contents to it, or push it from a terminal:
   ```bash
   cd mytt-brain
   git init -b main && git add -A && git commit -m "MyTT brain: Phase 0 plan and session setup"
   git remote add origin git@github.com:<you>/mytt-brain.git && git push -u origin main
   ```
   If you upload through the browser, check that `.gitignore`, `.env.example` and the `.claude/` folder arrived. Finder hides files whose names start with a dot.
3. Install the Claude GitHub App on that repository: https://github.com/apps/claude

## 2. Connect your connectors

At https://claude.ai/customize/connectors, connect:

| Connector | Used for | Access needed |
|---|---|---|
| Supabase | reading `em_tracker` (meetings, tasks, sprints, `sync_log`) | read-only queries on project `qhvdbmbxgrkolqddohzf` |
| ClickUp | tasks, comments, sprints, approved chat channels | read |
| Google Sheets | the stakeholder sheet (`Backlog`, `User Stories`, `Open Questions`) | read |

A session pauses to ask before it uses a connector tool. For the scheduled task, slice 7 lists the read-only tools to allow in advance.

## 3. Create the cloud environment

At https://claude.ai/code, create an environment for this repository.

**Network access:** keep **Limited**, keep "Allow package managers" on, and add these domains:

```
*.supabase.co
api.supabase.com
api.cloudflare.com
```

`github.com` is already allowed, and the setup script downloads the Supabase CLI from it.

**Network secrets** (the proxy adds them to requests for the host you name; the key never enters the session's machine):

| Secret | Host | When |
|---|---|---|
| Ingest token (`BRAIN_INGEST_TOKEN`) | `qhvdbmbxgrkolqddohzf.supabase.co` | after slice 1 is deployed |
| Cloudflare Workers AI token | `api.cloudflare.com` | only for slice 8, the comparison check |

**Environment variables** (visible to anyone who uses the environment, so nothing secret):

```
SUPABASE_URL=https://qhvdbmbxgrkolqddohzf.supabase.co
SUPABASE_ANON_KEY=<the project's anon key; public by design>
```

**Setup script:** paste the contents of [`scripts/cloud-setup.sh`](../scripts/cloud-setup.sh). It installs Python tooling, Deno, the Supabase CLI and Postgres with pgTAP. It hasn't been run in the cloud yet, so the first session's job includes fixing whatever in it fails.

## 4. Start the first session

At https://claude.ai/code, pick the repository and the environment, and send:

> Read CLAUDE.md and docs/plan-phase-0.md. Confirm the toolchain, then start slice 0.

The session stops for your sign-off on the cloud changes (Q2 in the plan) before it builds anything.

## 5. Your Supabase and Cloudflare steps (when the plan asks)

- **Cloudflare:** create an account (personal, per Q1) and an API token with the **Workers AI** permission only.
- **Supabase:** apply `supabase/migrations/*` in the SQL editor or with `supabase db push`, set the Edge Function secrets with `supabase secrets set`, and deploy the functions. Sessions write these files; you run them, because sessions never hold a key that can change production (D3).

## Later: the scheduled gather

After AC18 passes, create a scheduled task at https://claude.ai/code/routines on this repository and environment, using the prompt in `run/gather.md` and cron `0 */3 * * *`. `run/README.md` (written in slice 7) has the details.

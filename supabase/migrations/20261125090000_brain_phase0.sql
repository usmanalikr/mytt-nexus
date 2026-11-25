-- MyTT Brain, Phase 0 — slice 0, the contract.
--
-- Usman applies this; sessions never hold a key that can change production (D3).
-- The matching down migration is supabase/down/20261125090000_brain_phase0_down.sql.
--
-- This file runs unchanged against both the Supabase project and a throwaway
-- local Postgres. The platform pieces (pgmq, pg_cron, pg_net, the queue, the
-- cron job) are guarded, so locally they are skipped and everything else — the
-- tables, the roles and the access rules the pgTAP tests care about — still
-- applies. auth.uid() is NOT created here: Supabase owns it, and the local test
-- harness stubs it (supabase/tests/harness.sql).

begin;

-- ---------------------------------------------------------------------------
-- Schemas
-- ---------------------------------------------------------------------------

create schema if not exists brain_private;
create schema if not exists brain;

comment on schema brain_private is
  'Everything gathered, as the screen left it. Readable by the owner and by the brain_intake and brain_curator roles only (D1).';
comment on schema brain is
  'The tiered team layer. Readable through the tier ladder (D1).';

-- ---------------------------------------------------------------------------
-- Roles (D2). Neither has any right on em_tracker.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'brain_intake') then
    create role brain_intake nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'brain_curator') then
    create role brain_curator nologin;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- brain_private
-- ---------------------------------------------------------------------------

create table if not exists brain_private.sources (
  source        text primary key,
  watermark     timestamptz,
  last_run_at   timestamptz,
  updated_at    timestamptz not null default now()
);

comment on table brain_private.sources is
  'One watermark per source. Every gather is incremental and reads this first (D8).';

create table if not exists brain_private.items (
  id            uuid primary key default gen_random_uuid(),
  source        text not null,
  source_id     text not null,
  kind          text not null,
  title         text,
  body          text not null,
  url           text,
  occurred_at   timestamptz,
  project       text,
  body_sha256   text not null,
  screen_hits   jsonb not null default '[]'::jsonb,
  patterns_version text,
  batch_id      uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint brain_private_items_unique_source unique (source, source_id)
);

comment on table brain_private.items is
  'Screened source items. Not originals: the screen redacts before storage (AC3-AC5), so a redaction here is permanent.';
comment on column brain_private.items.body_sha256 is
  'Of the screened body. A changed hash re-queues the item for curation (AC1).';

create index if not exists brain_private_items_source_idx
  on brain_private.items (source, occurred_at desc);

create table if not exists brain_private.scope_rules (
  id            bigint generated always as identity primary key,
  source        text not null,
  project       text,
  in_scope      boolean not null,
  note          text,
  created_at    timestamptz not null default now(),
  constraint brain_private_scope_rules_unique unique (source, project)
);

comment on table brain_private.scope_rules is
  'The allow-list. Only MyTT gets in; anything unclear goes to intake_review rather than into the brain (AC2).';

create table if not exists brain_private.intake_review (
  id            bigint generated always as identity primary key,
  source        text not null,
  source_id     text not null,
  payload       jsonb not null,
  reason        text not null,
  decided_at    timestamptz,
  decision      text check (decision in ('admit', 'reject')),
  created_at    timestamptz not null default now(),
  constraint brain_private_intake_review_unique unique (source, source_id)
);

create table if not exists brain_private.digests (
  day           date primary key,
  digest        jsonb not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table brain_private.digests is
  'One row a day, shaped by contract/digest.schema.json. The curator writes it; brain digest reads it.';

-- ---------------------------------------------------------------------------
-- brain
-- ---------------------------------------------------------------------------

create table if not exists brain.members (
  user_id       uuid primary key,
  tier          smallint not null check (tier in (1, 2, 3)),
  is_owner      boolean not null default false,
  note          text,
  added_at      timestamptz not null default now()
);

comment on table brain.members is
  'Tier 1 governance, 2 leads, 3 delivery. Lower is MORE privileged. In Phase 0 there is one row: Usman, tier 1, is_owner.';

create unique index if not exists brain_members_single_owner
  on brain.members (is_owner) where is_owner;

create table if not exists brain.runs (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('gather', 'curate')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running'
                  check (status in ('running', 'ok', 'failed', 'budget_reached')),
  items_taken   integer not null default 0,
  items_done    integer not null default 0,
  neurons       integer not null default 0,
  model         text,
  error         text
);

comment on table brain.runs is
  'Opened when a batch starts, closed when it ends. The pg_cron -> pg_net call is fire-and-forget, so this row is the only evidence a batch ran at all (D8).';

create index if not exists brain_runs_started_idx on brain.runs (started_at desc);

create table if not exists brain.items (
  id              uuid primary key default gen_random_uuid(),
  tier            smallint not null check (tier in (1, 2, 3)),
  kind            text not null,
  title           text not null,
  body            text not null,
  status          text not null default 'n/a'
                    check (status in ('proposed', 'agreed', 'superseded', 'n/a')),
  source_ref      text,
  left_out        text[] not null default '{}',
  occurred_at     timestamptz,
  private_item_id uuid references brain_private.items (id) on delete cascade,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  tsv             tsvector generated always as (
                    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                    setweight(to_tsvector('english', coalesce(body, '')), 'B')
                  ) stored
);

comment on column brain.items.tier is
  'The lowest tier allowed to see this item. A caller reads it when their own tier <= this one.';

create index if not exists brain_items_tsv_idx on brain.items using gin (tsv);
create index if not exists brain_items_tier_idx on brain.items (tier, occurred_at desc);

create table if not exists brain.outcomes (
  id              bigint generated always as identity primary key,
  private_item_id uuid not null references brain_private.items (id) on delete cascade,
  run_id          uuid references brain.runs (id) on delete set null,
  outcome         text not null check (outcome in ('published', 'withheld', 'flagged')),
  reason          text not null,
  model           text,
  tokens_in       integer,
  tokens_out      integer,
  neurons         integer,
  attempt         smallint not null default 1,
  created_at      timestamptz not null default now()
);

create index if not exists brain_outcomes_item_idx on brain.outcomes (private_item_id);

create table if not exists brain.flags (
  id              bigint generated always as identity primary key,
  private_item_id uuid not null references brain_private.items (id) on delete cascade,
  flag_reason     text not null,
  resolution      text check (resolution in ('published', 'edited', 'withheld')),
  resolved_at     timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists brain_flags_open_idx on brain.flags (created_at) where resolved_at is null;

create table if not exists brain.access_log (
  id              bigint generated always as identity primary key,
  user_id         uuid not null,
  tool            text not null,
  row_count       integer not null,
  query_sha256    text,
  created_at      timestamptz not null default now()
);

comment on column brain.access_log.query_sha256 is
  'A hash of the query, never the query itself: a search can carry a person name or a sensitive term (AC15).';

-- ---------------------------------------------------------------------------
-- The tier check, in ONE place
--
-- Tier 1 is both the most privileged and the most restrictive default, and the
-- comparison reads "caller <= item", so the ordering is inverted twice. Every
-- policy calls these functions rather than repeating the comparison, and pgTAP
-- tests them directly as well as through the tables.
-- ---------------------------------------------------------------------------

create or replace function brain.caller_tier()
returns smallint
language sql
stable
security definer
set search_path = ''
as $$
  select m.tier from brain.members m where m.user_id = auth.uid();
$$;

comment on function brain.caller_tier() is
  'The signed-in caller''s tier, or NULL when they have no membership row. NULL must never read anything.';

create or replace function brain.can_read_tier(item_tier smallint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(brain.caller_tier() <= item_tier, false);
$$;

comment on function brain.can_read_tier(smallint) is
  'The single tier rule. coalesce(..., false) is what makes a caller with no membership row, and anon, read nothing.';

create or replace function brain.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from brain.members m
    where m.user_id = auth.uid() and m.is_owner
  );
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table brain_private.items          enable row level security;
alter table brain_private.sources        enable row level security;
alter table brain_private.scope_rules    enable row level security;
alter table brain_private.intake_review  enable row level security;
alter table brain_private.digests        enable row level security;
alter table brain.items                  enable row level security;
alter table brain.outcomes               enable row level security;
alter table brain.flags                  enable row level security;
alter table brain.members                enable row level security;
alter table brain.runs                   enable row level security;
alter table brain.access_log             enable row level security;

alter table brain_private.items          force row level security;
alter table brain_private.sources        force row level security;
alter table brain_private.scope_rules    force row level security;
alter table brain_private.intake_review  force row level security;
alter table brain_private.digests        force row level security;
alter table brain.items                  force row level security;
alter table brain.outcomes               force row level security;
alter table brain.flags                  force row level security;
alter table brain.members                force row level security;
alter table brain.runs                   force row level security;
alter table brain.access_log             force row level security;

-- The private store, the outcomes, the flags and the runs are the owner's alone (AC8).
do $$
declare
  t text;
begin
  foreach t in array array[
    'brain_private.items', 'brain_private.sources', 'brain_private.scope_rules',
    'brain_private.intake_review', 'brain_private.digests',
    'brain.outcomes', 'brain.flags', 'brain.runs'
  ]
  loop
    execute format('drop policy if exists owner_all on %s', t);
    execute format(
      'create policy owner_all on %s for all to public using (brain.is_owner()) with check (brain.is_owner())', t);
  end loop;
end
$$;

-- The team layer: the tier ladder, and nothing else (AC7).
drop policy if exists tier_read on brain.items;
create policy tier_read on brain.items
  for select to public
  using (brain.can_read_tier(tier));

-- Only the owner writes team items by hand; the curator writes as brain_curator,
-- which bypasses RLS through its grants below, not through a policy.
drop policy if exists owner_write on brain.items;
create policy owner_write on brain.items
  for all to public
  using (brain.is_owner()) with check (brain.is_owner());

-- A member sees their own membership row; the owner sees every row.
drop policy if exists member_self on brain.members;
create policy member_self on brain.members
  for select to public
  using (user_id = auth.uid() or brain.is_owner());

drop policy if exists owner_manages_members on brain.members;
create policy owner_manages_members on brain.members
  for all to public
  using (brain.is_owner()) with check (brain.is_owner());

-- The MCP service appends to the access log as the caller; only the owner reads it.
drop policy if exists caller_appends on brain.access_log;
create policy caller_appends on brain.access_log
  for insert to public
  with check (user_id = auth.uid());

drop policy if exists owner_reads_log on brain.access_log;
create policy owner_reads_log on brain.access_log
  for select to public
  using (brain.is_owner());

-- ---------------------------------------------------------------------------
-- Grants (D2). brain_intake writes the private store; brain_curator reads it
-- and writes the team layer. Neither can touch the other's side, and neither
-- is granted anything in em_tracker.
-- ---------------------------------------------------------------------------

grant usage on schema brain_private to brain_intake, brain_curator;
grant usage on schema brain            to brain_curator;

grant select, insert, update on brain_private.items         to brain_intake;
grant select, insert, update on brain_private.sources       to brain_intake;
grant select                 on brain_private.scope_rules   to brain_intake;
grant select, insert, update on brain_private.intake_review to brain_intake;

grant select on brain_private.items    to brain_curator;
grant select on brain_private.sources  to brain_curator;
grant select, insert, update on brain_private.digests to brain_curator;

grant select, insert, update on brain.items    to brain_curator;
grant select, insert         on brain.outcomes to brain_curator;
grant select, insert, update on brain.flags    to brain_curator;
grant select, insert, update on brain.runs     to brain_curator;
grant select                 on brain.members  to brain_curator;

grant usage, select on all sequences in schema brain to brain_curator;

-- Both roles act inside their own Edge Function and must not be filtered by the
-- owner-only policies, so they are allowed to bypass RLS on these tables only.
alter role brain_intake  bypassrls;
alter role brain_curator bypassrls;

-- People and agents arrive as `authenticated`, carrying their own JWT: that is
-- how the MCP service and the review and digest commands connect. Without these
-- grants a policy is never reached at all — the query fails on permission first,
-- which would hide a broken policy rather than expose it. RLS above does the
-- real work; these grants only open the door. `anon` is granted nothing.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    grant usage on schema brain, brain_private to authenticated;

    -- The tier ladder decides what comes back (AC7).
    grant select on brain.items   to authenticated;
    grant select on brain.members to authenticated;
    grant insert on brain.access_log to authenticated;

    -- Owner-only by policy (AC8), but the owner is an `authenticated` caller
    -- too, so the grant has to exist for the policy to be the thing that bites.
    grant select on brain.outcomes, brain.flags, brain.runs, brain.access_log to authenticated;
    grant update on brain.flags to authenticated;          -- brain review resolves flags
    grant insert, update, delete on brain.items to authenticated;  -- brain review publishes
    grant select on brain_private.items, brain_private.sources,
                    brain_private.scope_rules, brain_private.intake_review,
                    brain_private.digests to authenticated;
    grant insert, update on brain.members to authenticated;
  else
    raise warning 'role authenticated not present: Supabase grants skipped';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Seed: MyTT is the only thing in scope (AC2).
-- ---------------------------------------------------------------------------

insert into brain_private.scope_rules (source, project, in_scope, note)
values ('*', 'MyTT', true, 'The only project in scope for Phase 0. Anything else is rejected; an unset project goes to intake_review.')
on conflict (source, project) do nothing;

-- ---------------------------------------------------------------------------
-- Platform pieces: the queue and the schedule (D8).
-- Skipped on a plain Postgres, so the same file runs locally and on Supabase.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pgmq') then
    create extension if not exists pgmq;
    perform pgmq.create('brain_curation');
    execute 'grant usage on schema pgmq to brain_intake, brain_curator';
    execute 'grant select, insert, update, delete on all tables in schema pgmq to brain_intake, brain_curator';
  else
    raise warning 'pgmq not available: queue skipped (expected on a local test cluster)';
  end if;

  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  else
    raise warning 'pg_net not available: skipped';
  end if;

  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    -- Every 10 minutes, created PAUSED. Unpause it at rollout step 4.
    -- timeout_milliseconds is set explicitly: pg_net's default is 5s, and the
    -- curator runs far longer, so the call is fire-and-forget by design (D8).
    perform cron.schedule(
      'brain-curator-every-10-min',
      '*/10 * * * *',
      $cron$
        select net.http_post(
          url     := current_setting('app.settings.curator_url', true),
          -- brain-curator is deployed without the JWT check so this call can
          -- reach it, and it refuses any request without this token. The
          -- token lives in Supabase Vault, never in this file.
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'X-Brain-Curator-Token', (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'brain_curator_token')),
          body    := '{}'::jsonb,
          timeout_milliseconds := 1000
        );
      $cron$
    );
    update cron.job set active = false where jobname = 'brain-curator-every-10-min';
  else
    raise warning 'pg_cron not available: schedule skipped';
  end if;
end
$$;

commit;

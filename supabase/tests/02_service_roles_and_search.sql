-- The two service roles reach the brain's tables and nothing else, and search
-- follows the tier ladder.
--
-- brain_intake and brain_curator once had BYPASSRLS, which is a role attribute:
-- it applied to every table in the database, not just the brain's. They now
-- pass RLS through policies on the brain's own tables only. This file holds
-- that line, and checks that search_items (the RPC the MCP service uses so a
-- search term never travels in a URL) applies the tier ladder to its caller.

begin;
select plan(13);

-- ---------------------------------------------------------------------------
-- Fixtures, as the superuser.
-- ---------------------------------------------------------------------------

-- Another app's table in the same project, guarded only by RLS.
create table public.other_app (secret text);
alter table public.other_app enable row level security;
grant select on public.other_app to public;
insert into public.other_app values ('someone else''s row');

insert into brain.members (user_id, tier, is_owner, note) values
  ('00000000-0000-0000-0000-00000000000f'::uuid, 1, true,  'owner'),
  ('00000000-0000-0000-0000-000000000003'::uuid, 3, false, 'developer');

insert into brain.items (tier, kind, title, body, status) values
  (1, 'decision', 'Governance budget', 'The budget discussion.', 'agreed'),
  (3, 'date',     'Delivery budget',   'Budget review moved to 5 Dec.', 'n/a');

insert into brain_private.items (source, source_id, kind, body, body_sha256)
values ('clickup.tasks', 't-1', 'task', 'A task body.', 'h');

select is(
  (select bool_or(rolbypassrls) from pg_roles where rolname in ('brain_intake', 'brain_curator')),
  false,
  'neither service role has BYPASSRLS');

-- ---------------------------------------------------------------------------
-- brain_intake
-- ---------------------------------------------------------------------------

set local role brain_intake;
select is((select count(*) from public.other_app)::int, 0,
  'brain_intake reads nothing from another app''s RLS table');
select is((select count(*) from brain_private.items)::int, 1,
  'brain_intake still reads the private store');
select lives_ok(
  $$insert into brain_private.items (source, source_id, kind, body, body_sha256)
    values ('clickup.tasks', 't-2', 'task', 'Another.', 'h2')$$,
  'brain_intake still writes the private store');
select throws_ok('select * from brain.items', '42501', null,
  'brain_intake cannot read the team layer');
reset role;

-- ---------------------------------------------------------------------------
-- brain_curator
-- ---------------------------------------------------------------------------

set local role brain_curator;
select is((select count(*) from public.other_app)::int, 0,
  'brain_curator reads nothing from another app''s RLS table');
select is((select count(*) from brain_private.items)::int, 2,
  'brain_curator still reads the private store');
select lives_ok(
  $$update brain_private.items set screen_hits = '[{"pattern_id":"x","category":"secret","count":1}]'
    where source_id = 't-1'$$,
  'brain_curator may record the re-screen''s hits (AC20)');
select throws_ok(
  $$update brain_private.items set body = 'rewritten' where source_id = 't-1'$$,
  '42501', null,
  'brain_curator may not rewrite a private body');
select lives_ok(
  $$insert into brain.items (tier, kind, title, body, status) values (3, 'note', 't', 'b', 'n/a')$$,
  'brain_curator still writes the team layer');
reset role;

-- ---------------------------------------------------------------------------
-- search_items follows the tier ladder
-- ---------------------------------------------------------------------------

set local role authenticated;

set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003';
select bag_eq(
  $$select title from brain.search_items('budget')$$,
  $$values ('Delivery budget')$$,
  'a tier-3 search finds only the tier-3 match');

set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000004';
select is((select count(*) from brain.search_items('budget'))::int, 0,
  'a caller with no membership row finds nothing');

set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000f';
select is((select count(*) from brain.search_items('budget'))::int, 2,
  'the owner finds both');

select * from finish();
rollback;

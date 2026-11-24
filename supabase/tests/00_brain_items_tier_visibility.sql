-- AC7 — brain_items_tier_visibility
--
-- Tier 1 is governance, 2 leads, 3 delivery. Lower is MORE privileged, and the
-- rule reads "caller's tier <= item's tier", so the ordering is inverted twice.
-- This file tests the rule through the table AND against the function that
-- holds it, because one flipped comparison would send governance material to
-- the delivery team.

begin;
select plan(18);

-- ---------------------------------------------------------------------------
-- Fixtures. Set up as the superuser, who bypasses RLS.
-- ---------------------------------------------------------------------------

insert into brain.members (user_id, tier, is_owner, note) values
  ('00000000-0000-0000-0000-00000000000f'::uuid, 1, true,  'owner, governance'),
  ('00000000-0000-0000-0000-000000000002'::uuid, 2, false, 'lead'),
  ('00000000-0000-0000-0000-000000000003'::uuid, 3, false, 'developer');
-- '...0004' is signed in but has no membership row: the likeliest real case,
-- someone who signs in before being added.

insert into brain.items (id, tier, kind, title, body, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 1, 'decision', 'Governance item', 'Commercial reason for the slip.', 'agreed'),
  ('aaaaaaaa-0000-0000-0000-000000000002'::uuid, 2, 'status',   'Leads item',      'Allocation across the two squads.', 'n/a'),
  ('aaaaaaaa-0000-0000-0000-000000000003'::uuid, 3, 'date',     'Delivery item',   'Release moved to 5 Dec.', 'n/a');

-- ---------------------------------------------------------------------------
-- The function, directly.
-- ---------------------------------------------------------------------------

set local role authenticated;

set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003';
select is(brain.caller_tier(), 3::smallint, 'a developer resolves to tier 3');
select ok(    brain.can_read_tier(3::smallint), 'tier 3 may read a tier-3 item');
select ok(not brain.can_read_tier(2::smallint), 'tier 3 may NOT read a tier-2 item');
select ok(not brain.can_read_tier(1::smallint), 'tier 3 may NOT read a tier-1 item');

set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000002';
select ok(    brain.can_read_tier(3::smallint), 'a lead may read a tier-3 item');
select ok(    brain.can_read_tier(2::smallint), 'a lead may read a tier-2 item');
select ok(not brain.can_read_tier(1::smallint), 'a lead may NOT read a tier-1 item');

set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000f';
select ok(brain.can_read_tier(1::smallint), 'governance may read a tier-1 item');
select ok(brain.can_read_tier(3::smallint), 'governance may read a tier-3 item');

set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000004';
select is(brain.caller_tier(), null, 'a caller with no membership row has no tier');
select ok(not brain.can_read_tier(3::smallint),
  'a caller with no membership row may read nothing, not even the lowest tier');

-- ---------------------------------------------------------------------------
-- The same rule through the table, which is what actually protects the data.
-- ---------------------------------------------------------------------------

set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003';
select bag_eq(
  'select title from brain.items',
  $$ values ('Delivery item') $$,
  'a developer sees only the tier-3 item'
);

set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000002';
select bag_eq(
  'select title from brain.items',
  $$ values ('Leads item'), ('Delivery item') $$,
  'a lead sees tiers 2 and 3, and not tier 1'
);

set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000f';
select bag_eq(
  'select title from brain.items',
  $$ values ('Governance item'), ('Leads item'), ('Delivery item') $$,
  'governance sees every tier'
);

set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000004';
select is_empty(
  'select title from brain.items',
  'a signed-in caller with no membership row reads nothing'
);

-- Asking for a tier-1 row by its id must come back empty, not forbidden: the
-- service never admits that an item exists at a tier the caller cannot see.
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000003';
select is_empty(
  $$ select title from brain.items where id = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid $$,
  'fetching a tier-1 item by id as a developer returns nothing, rather than an error'
);

-- ---------------------------------------------------------------------------
-- anon, the unauthenticated caller, has no grant at all.
-- ---------------------------------------------------------------------------

set local role anon;
set local request.jwt.claim.sub = '';
select throws_ok(
  'select title from brain.items',
  '42501',
  null,
  'anon is refused before any policy is consulted'
);

set local role postgres;
select is(
  (select count(*)::int from brain.items),
  3,
  'all three items are really there — the tests above were filtered, not empty'
);

select * from finish();
rollback;

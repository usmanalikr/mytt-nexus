-- AC8 — brain_private_owner_only
--
-- The private store is the most sensitive thing in the system. Any
-- authenticated caller other than the owner must read 0 rows from
-- brain_private.*, and from brain.outcomes, brain.flags and brain.runs.

begin;
select plan(16);

insert into brain.members (user_id, tier, is_owner, note) values
  ('00000000-0000-0000-0000-00000000000f'::uuid, 1, true,  'owner'),
  ('00000000-0000-0000-0000-000000000002'::uuid, 2, false, 'lead, NOT the owner'),
  ('00000000-0000-0000-0000-000000000003'::uuid, 3, false, 'developer');

insert into brain_private.items (id, source, source_id, kind, body, body_sha256) values
  ('bbbbbbbb-0000-0000-0000-000000000001'::uuid, 'em_tracker.meetings', 'm-1', 'meeting',
   'Raw screened transcript text.', repeat('a', 64));

insert into brain_private.sources (source, watermark) values
  ('em_tracker.meetings', now());

insert into brain_private.digests (day, digest) values
  (current_date, '{"day":"2026-11-25"}'::jsonb);

insert into brain_private.intake_review (source, source_id, payload, reason) values
  ('em_tracker.meetings', 'm-2', '{}'::jsonb, 'project not set');

insert into brain.runs (id, kind, status) values
  ('cccccccc-0000-0000-0000-000000000001'::uuid, 'curate', 'ok');

insert into brain.outcomes (private_item_id, outcome, reason) values
  ('bbbbbbbb-0000-0000-0000-000000000001'::uuid, 'flagged', 'tangled with a commercial reason');

insert into brain.flags (private_item_id, flag_reason) values
  ('bbbbbbbb-0000-0000-0000-000000000001'::uuid, 'tangled with a commercial reason');

-- ---------------------------------------------------------------------------
-- A tier-1 member who is not the owner. Tier 1 is the top of the ladder, so if
-- anything other than ownership were being checked, this is where it shows.
-- ---------------------------------------------------------------------------

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000002';

select ok(not brain.is_owner(), 'a lead is not the owner');
select is_empty('select 1 from brain_private.items',         'a lead reads no private items');
select is_empty('select 1 from brain_private.sources',       'a lead reads no watermarks');
select is_empty('select 1 from brain_private.digests',       'a lead reads no digests');
select is_empty('select 1 from brain_private.scope_rules',   'a lead reads no scope rules');
select is_empty('select 1 from brain_private.intake_review', 'a lead reads no holding queue');
select is_empty('select 1 from brain.outcomes',              'a lead reads no outcomes');
select is_empty('select 1 from brain.flags',                 'a lead reads no flags');
select is_empty('select 1 from brain.runs',                  'a lead reads no runs');
select is_empty('select 1 from brain.access_log',            'a lead reads no access log');

-- Writing is refused too, not merely filtered on read.
select throws_ok(
  $$ insert into brain_private.items (source, source_id, kind, body, body_sha256)
     values ('x', 'y', 'note', 'z', repeat('b', 64)) $$,
  '42501',
  null,
  'a lead cannot write to the private store'
);

-- ---------------------------------------------------------------------------
-- The owner.
-- ---------------------------------------------------------------------------

set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000f';

select ok(brain.is_owner(), 'the owner is the owner');
select isnt_empty('select 1 from brain_private.items', 'the owner reads the private store');
select isnt_empty('select 1 from brain.flags',         'the owner reads the flags');
select isnt_empty('select 1 from brain.runs',          'the owner reads the runs');

-- ---------------------------------------------------------------------------
-- The rows are genuinely present; the emptiness above was the policy working.
-- ---------------------------------------------------------------------------

set local role postgres;
select is(
  (select count(*)::int from brain_private.items),
  1,
  'the private item is really there'
);

select * from finish();
rollback;

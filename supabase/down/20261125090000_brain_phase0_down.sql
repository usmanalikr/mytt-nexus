-- MyTT Brain, Phase 0 — the down migration for 20261125090000_brain_phase0.sql.
--
-- Kept outside supabase/migrations/ on purpose: the Supabase CLI applies every
-- .sql file it finds in that directory, so a down migration living there would
-- be run as if it were a migration.
--
-- Usman applies this; it is the last step of the rollback in the plan. It drops
-- both schemas, both roles, the queue and the cron job. em_tracker is untouched
-- throughout — nothing here names it, and neither role was ever granted on it.
--
-- AC23 tests up -> down -> up.

begin;

-- The schedule and the queue first, so nothing fires at a half-dropped schema.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'brain-curator-every-10-min') then
      perform cron.unschedule('brain-curator-every-10-min');
    end if;
  end if;

  if exists (select 1 from pg_extension where extname = 'pgmq') then
    if exists (select 1 from pgmq.list_queues() q where q.queue_name = 'brain_curation') then
      perform pgmq.drop_queue('brain_curation');
    end if;
  end if;
end
$$;

-- The schemas, and everything in them: tables, policies, functions, indexes.
drop schema if exists brain cascade;
drop schema if exists brain_private cascade;

-- The roles. Ownership and grants went with the schemas, but privileges on
-- other objects have to be dropped before the role can be.
--
-- `reassign owned by` and `drop owned by` only reach the CURRENT database,
-- while `drop role` is cluster-wide. So if either role still holds a privilege
-- in some other database, the drop fails and says so. On the Supabase project
-- there is one database and this does not arise; it bit the test harness,
-- which had applied the up migration to two.
do $$
declare
  r text;
begin
  foreach r in array array['brain_intake', 'brain_curator']
  loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('reassign owned by %I to current_user', r);
      execute format('drop owned by %I', r);
      begin
        execute format('drop role %I', r);
      exception when dependent_objects_still_exist then
        raise exception
          'Cannot drop role %: it still holds privileges in another database. '
          'Connect to each database that has had this migration applied, run '
          '"drop owned by %", then drop the role.', r, r;
      end;
    end if;
  end loop;
end
$$;

-- The extensions are deliberately left in place: pgmq, pg_cron and pg_net may
-- be in use by em_tracker or by the project's own jobs. Dropping them is not
-- this migration's business.

commit;

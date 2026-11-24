-- Stand-ins for the parts of Supabase a plain Postgres doesn't have.
--
-- Applied before the migration when the tests run against a throwaway local
-- cluster. On the Supabase project these objects already exist and this file is
-- not used. `supabase start` would remove the need for it entirely, but the
-- local stack's images cannot be pulled through the cloud environment's network
-- allowlist (see docs/cloud-setup.md), so this is the path slice 0 takes.

-- The three roles PostgREST and the Edge Functions arrive as.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

-- So the test session can SET ROLE into them.
do $$
begin
  execute format('grant anon, authenticated, service_role to %I', current_user);
end
$$;

create schema if not exists extensions;
create schema if not exists auth;

-- Supabase derives this from the request's JWT. Here it comes from a GUC the
-- tests set, which is exactly how PostgREST passes it through in production.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create extension if not exists pgtap;

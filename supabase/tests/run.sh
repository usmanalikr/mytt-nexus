#!/usr/bin/env bash
# Runs slice 0's pgTAP suite against a throwaway local Postgres.
#
#   supabase/tests/run.sh
#
# Starts a cluster if one isn't already listening, applies the harness and the
# up migration to a fresh database, runs the tests, then runs AC23 — up, down,
# up again — against a second fresh database.
#
# `supabase start` would be the better harness, because it gives the real roles
# and auth.uid() instead of stand-ins. It is not usable from the cloud
# environment: the image registry is outside the network allowlist. See
# docs/cloud-setup.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGPORT="${PGPORT:-5433}"
PGHOST="${PGHOST:-/tmp}"
PGDATA="${PGDATA:-/tmp/brain-pgdata}"
PGBIN="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"
export PGPORT PGHOST
export PGOPTIONS="-c client_min_messages=warning"
PSQL="$PGBIN/psql -h $PGHOST -p $PGPORT -U postgres -v ON_ERROR_STOP=1 -q"

UP="$ROOT/supabase/migrations/20261125090000_brain_phase0.sql"
DOWN="$ROOT/supabase/down/20261125090000_brain_phase0_down.sql"
HARNESS="$ROOT/supabase/tests/harness.sql"

start_cluster() {
  if "$PGBIN/pg_isready" -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
    echo "# using the cluster already listening on $PGHOST:$PGPORT"
    return
  fi
  echo "# starting a throwaway cluster in $PGDATA"
  rm -rf "$PGDATA"
  mkdir -p "$PGDATA"
  # initdb and pg_ctl refuse to run as root.
  if [ "$(id -u)" -eq 0 ]; then
    chown postgres:postgres "$PGDATA"
    su postgres -c "$PGBIN/initdb -D $PGDATA -U postgres --auth=trust" >/dev/null
    su postgres -c "$PGBIN/pg_ctl -D $PGDATA -l /tmp/brain-pg.log -o '-p $PGPORT -k $PGHOST' start" >/dev/null
  else
    "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
    "$PGBIN/pg_ctl" -D "$PGDATA" -l /tmp/brain-pg.log -o "-p $PGPORT -k $PGHOST" start >/dev/null
  fi
  sleep 2
}

fresh_db() {
  local db="$1"
  $PSQL -d postgres -c "drop database if exists $db" >/dev/null
  $PSQL -d postgres -c "create database $db" >/dev/null
  $PSQL -d "$db" -f "$HARNESS" >/dev/null
}

start_cluster

# --- the suite ---------------------------------------------------------------
echo "# applying the up migration"
fresh_db brain_test
$PSQL -d brain_test -f "$UP" >/dev/null

echo "# running pgTAP"
pg_prove -h "$PGHOST" -p "$PGPORT" -U postgres -d brain_test \
  "$ROOT"/supabase/tests/[0-9]*.sql

# --- AC23: up -> down -> up --------------------------------------------------
echo
echo "# AC23: the down migration"
# drop the suite's database first: drop owned by reaches only the current
# database, while drop role is cluster-wide, so a leftover grant elsewhere
# would block the role drop. Production has one database.
$PSQL -d postgres -c "drop database if exists brain_test" >/dev/null
fresh_db brain_down_test
DB="$PGBIN/psql -h $PGHOST -p $PGPORT -U postgres -d brain_down_test -v ON_ERROR_STOP=1 -tA"

count_objects() {
  $DB -c "select
      (select count(*) from pg_namespace where nspname in ('brain','brain_private'))
    + (select count(*) from pg_roles where rolname in ('brain_intake','brain_curator'))"
}

$PSQL -d brain_down_test -f "$UP" >/dev/null
after_up="$(count_objects)"
[ "$after_up" = "4" ] || { echo "not ok - up did not create 2 schemas and 2 roles (got $after_up)"; exit 1; }
echo "ok 1 - up creates both schemas and both roles"

$PSQL -d brain_down_test -f "$DOWN" >/dev/null
after_down="$(count_objects)"
[ "$after_down" = "0" ] || { echo "not ok - down left $after_down objects behind"; exit 1; }
echo "ok 2 - down leaves nothing behind"

$PSQL -d brain_down_test -f "$UP" >/dev/null
after_reup="$(count_objects)"
[ "$after_reup" = "4" ] || { echo "not ok - up is not repeatable after down (got $after_reup)"; exit 1; }
echo "ok 3 - up applies cleanly again after down"

echo "1..3"
echo
echo "# done"

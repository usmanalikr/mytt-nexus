#!/usr/bin/env bash
# Setup script for the Claude Code cloud environment (paste into the environment's
# "setup script" field). Installs the toolchain the Phase 0 plan needs.
#
# Confirmed working in a session on 24 Nov 2026. What was wrong in the first draft:
#   - it never started a Postgres cluster, and initdb/pg_ctl refuse to run as root;
#   - it assumed `supabase start` was the pgTAP path. It is not: the image registry
#     (public.ecr.aws) is outside the environment's network allowlist, so the pulls
#     fail even once dockerd is running. See docs/cloud-setup.md.
set -euo pipefail

SUDO=""; [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO="sudo"

# Python tooling for the brain CLI and its tests.
python3 -m pip install --quiet --upgrade uv pytest jsonschema httpx

# Deno, for the Edge Functions and their tests (published on npm). Confirmed 2.9.6.
command -v deno >/dev/null || npm install -g deno

# Supabase CLI, from its GitHub release (a global npm install is not supported).
# Used for `db diff`, `functions deploy` and formatting; NOT for `supabase start`.
if ! command -v supabase >/dev/null; then
  curl -fsSL https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64.tar.gz \
    | $SUDO tar -xz -C /usr/local/bin supabase
fi

# Postgres with pgTAP, for the access-rule tests (AC7, AC8, AC23) without Docker.
# postgresql-16-pgtap brings pg_prove with it.
if ! ls /usr/lib/postgresql/*/bin/pg_ctl >/dev/null 2>&1; then
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq postgresql
fi
PGV=$(ls /usr/lib/postgresql | sort -n | tail -1)
dpkg -s "postgresql-$PGV-pgtap" >/dev/null 2>&1 || {
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq "postgresql-$PGV-pgtap"
}

echo "python:   $(python3 --version)"
echo "deno:     $(deno --version | head -1)"
echo "supabase: $(supabase --version)"
echo "postgres: $PGV with pgTAP; pg_prove at $(command -v pg_prove)"
echo
echo "Start a test cluster with: supabase/tests/run.sh"

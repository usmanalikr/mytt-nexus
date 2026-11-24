#!/usr/bin/env bash
# Copy the two files the Edge Functions need from outside supabase/.
#
# `supabase functions deploy` uploads the supabase/ directory and nothing else,
# so an import or a read that reaches above it — ../../../contract/... or
# ../../../docs/... — escapes the uploaded tree and the deploy fails. The
# contract and the policy stay the single source of truth in their own
# directories; these are copies, kept honest by contract/check.py, which fails
# if either has drifted.
#
#   scripts/prepare-functions.sh && supabase functions deploy brain-curator
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cp "$ROOT/contract/patterns.json"      "$ROOT/supabase/functions/_shared/patterns.json"
cp "$ROOT/docs/PUBLISHING-POLICY.md"   "$ROOT/supabase/functions/brain-curator/policy.md"

echo "copied into supabase/functions/:"
echo "  _shared/patterns.json       <- contract/patterns.json"
echo "  brain-curator/policy.md     <- docs/PUBLISHING-POLICY.md"

#!/usr/bin/env bash
# Runs syncy against testdata/, never your real config or state.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$here/testdata"
if [ ! -d "$root" ]; then
  echo "no testdata yet — run: bun run testdata" >&2
  exit 1
fi
export XDG_CONFIG_HOME="$root/config"
export XDG_STATE_HOME="$root/state"
exec "$here/syncy" "$@"

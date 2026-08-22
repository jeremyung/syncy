#!/bin/sh
# Scan the whole repository — every reachable blob, every commit message, and
# the working tree — for identifiers belonging to the machine running this.
#
# The working tree is not enough. Git history is immutable, so a hostname
# committed once survives every later cleanup of the tip; that is how a real
# username and NAS hostname reached a public repo here despite a pre-flight
# check on each push.
#
# Patterns are derived from this machine rather than hardcoded, so the check
# keeps working on someone else's and cannot be satisfied by scrubbing one
# known string.

set -eu
cd "$(git rev-parse --show-toplevel)"

USERNAME=$(id -un)
HOSTNAME_SHORT=$(hostname -s 2>/dev/null || echo "__no_such_host__")
HOME_PATH=$(printf '%s' "$HOME" | sed 's/[.[\*^$]/\\&/g')

# Mounted volume names, and the servers behind any network mounts.
VOLUMES=$(mount 2>/dev/null | sed -n 's|.* on /Volumes/\([^ ]*\) .*|\1|p' \
  | grep -v '^\.' | sed 's/[.[\*^$]/\\&/g' | sort -u)
SERVERS=$(mount 2>/dev/null | sed -n 's|^//[^@]*@\([^/]*\)/.*|\1|p' | sort -u)

# The configured commit address. A generic address pattern matched
# documentation instead: `//you@nas.local/share` is rsync's mount-source
# syntax, not a person.
GIT_EMAIL=$(git config user.email 2>/dev/null | sed 's/[.[\*^$]/\\&/g' || true)

PATTERNS=$(
  printf '%s\n' \
    "$HOME_PATH" \
    "(^|[^A-Za-z0-9])$USERNAME([^A-Za-z0-9]|\$)" \
    "$HOSTNAME_SHORT" \
    "([0-9]{1,3}\.){3}[0-9]{1,3}" \
    "([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}"
  [ -n "$GIT_EMAIL" ] && printf '%s\n' "$GIT_EMAIL"
  for v in $VOLUMES; do printf '/Volumes/%s\n' "$v"; done
  for s in $SERVERS; do printf '%s\n' "$s"; done
)

PATFILE=$(mktemp)
trap 'rm -f "$PATFILE"' EXIT
printf '%s\n' "$PATTERNS" | grep -v '^$' > "$PATFILE"

fail=0

section() {
  # $1 label, $2 findings. Prints them, or "clean", and records any failure.
  if [ -n "$2" ]; then
    printf '== %s ==\n' "$1"
    printf '%s\n' "$2" | sed 's/^/  LEAK  /'
    fail=1
  else
    printf '== %s ==\n  clean\n' "$1"
  fi
}

# 1. The working tree, via git so ignored files are skipped.
tree_hits=$(git grep -I -n -E -i -f "$PATFILE" -- . 2>/dev/null | head -20 || true)
section "working tree" "$tree_hits"

# 2. Commit messages. Author identity is deliberate attribution and is not
#    scanned; only subjects and bodies are.
msg_hits=$(git log --all --format='%H%n%s%n%b' 2>/dev/null \
  | grep -E -i -f "$PATFILE" | head -10 || true)
section "commit messages" "$msg_hits"

# 3. Every blob reachable from any ref — the check a tree scan cannot make.
blob_hits=$(
  git rev-list --all --objects 2>/dev/null | awk 'NF>=1{print $1}' | sort -u | while read -r oid; do
    [ "$(git cat-file -t "$oid" 2>/dev/null)" = "blob" ] || continue
    if git cat-file blob "$oid" 2>/dev/null | LC_ALL=C grep -q -E -i -f "$PATFILE"; then
      printf '%s\n' "$oid"
    fi
  done
)
if [ -n "$blob_hits" ]; then
  named=$(printf '%s\n' "$blob_hits" | while read -r oid; do
    path=$(git rev-list --all --objects | awk -v o="$oid" '$1==o{print $2; exit}')
    printf 'blob %s  %s\n' "$oid" "${path:-<unnamed>}"
  done)
  section "all reachable blobs" "$named"
else
  section "all reachable blobs" ""
fi

printf '\n'
if [ "$fail" = "1" ]; then
  printf 'FAIL — machine-specific identifiers found. Do not push.\n'
  printf 'If any are already published, rewriting history is not enough on its\n'
  printf 'own: the objects stay fetchable by SHA until the host garbage-collects.\n'
  exit 1
fi
printf 'OK — nothing machine-specific in the tree, the messages or the history.\n'

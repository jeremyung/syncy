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
#
# The mount table comes from `mount`, or from $SYNCY_AUDIT_MOUNT_TABLE when
# set (a test seam: a canned table, parsed the same way). The parsing is by
# output format, not by OS, so the same canned tables exercise both the
# macOS and the Linux shapes on any runner.

set -eu
cd "$(git rev-parse --show-toplevel)"

USERNAME=$(id -un)
HOSTNAME_SHORT=$(hostname -s 2>/dev/null || echo "__no_such_host__")
HOME_PATH=$(printf '%s' "$HOME" | sed 's/[.[\*^$]/\\&/g')

if [ -n "${SYNCY_AUDIT_MOUNT_TABLE:-}" ]; then
  MOUNT_TABLE=$(cat "$SYNCY_AUDIT_MOUNT_TABLE" 2>/dev/null || true)
else
  MOUNT_TABLE=$(mount 2>/dev/null || true)
fi

# Volume names, as full mount-point paths: macOS /Volumes/<name> (BSD output
# "… on /Volumes/<name> (fstype, …)") and Linux mount points under /media or
# /mnt. The path is the identifier; a bare leaf name could be a common word.
# Each sed extracts from the original table; the second must not filter the
# first's output, or the first finds nothing in the second's stream.
VOLUMES=$(
  {
    printf '%s\n' "$MOUNT_TABLE" | sed -n 's|.* on /Volumes/\([^(]*\) (.*|/Volumes/\1|p'
    printf '%s\n' "$MOUNT_TABLE" | sed -n 's|.* on \(/\(media\|mnt\)/[^ (]*\) .*|\1|p'
  } \
  | sed 's/ *$//' \
  | grep -v '/\.$' \
  | sed 's/[.[\*^$]/\\&/g' \
  | sort -u
)

# Network mount servers, recognized rather than local sources excluded.
# CIFS: //host/share or //user@host/share. NFS: host:/share, host a name or
# an address. (Excluding the known-local sources — the old way — let every
# Linux pseudo-filesystem, proc, tmpfs, cgroup2, …, through as a "server".)
SERVERS=$(printf '%s\n' "$MOUNT_TABLE" | awk '
  {
    device = $1
    host = ""
    if (device ~ /^\/\//) {
      host = substr(device, 3)
      sub(/^[^@]*@/, "", host)
      sub(/[\/:].*/, "", host)
    } else if (device !~ /^\// && index(device, ":") > 0) {
      sub(/:.*/, "", device)
      host = device
    }
    if (host ~ /^[A-Za-z0-9._-]+$/) print host
  }' | sort -u)

# The configured commit address. A generic address pattern matched
# documentation instead: `//you@nas.local/share` is rsync's mount-source
# syntax, not a person.
GIT_EMAIL=$(git config user.email 2>/dev/null | sed 's/[.[\*^$]/\\&/g' || true)

# One pattern per line, straight into the file. The lists above are already
# newline-separated and may contain spaces, so they must never pass through
# unquoted shell word-splitting: under dash, IFS=$'\n' is the literal
# characters $, \, n, and splitting on n shatters every pattern that contains
# one into one- and two-letter fragments that match nearly every line.
PATFILE=$(mktemp)
trap 'rm -f "$PATFILE"' EXIT
{
  printf '%s\n' "$HOME_PATH"
  printf '(^|[^A-Za-z0-9])%s([^A-Za-z0-9]|$)\n' "$USERNAME"
  printf '%s\n' "$HOSTNAME_SHORT"
  printf '([0-9]{1,3}\.){3}[0-9]{1,3}\n'
  printf '([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}\n'
  [ -n "$GIT_EMAIL" ] && printf '%s\n' "$GIT_EMAIL"
  printf '%s\n' "$VOLUMES"
  printf '%s\n' "$SERVERS"
} | grep -v '^$' > "$PATFILE"

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

#!/usr/bin/env bash
# Runs on the Linux release builder, sent over SSH by release-linux-remote.ts
# (`bash -s -- <mode> <checkout> <commit> <version> [release-desktop build flags]`).
# Kept as one script so every mode shares the same environment.
set -euo pipefail
mode="$1"; checkout="$2"; commit="$3"; version="$4"; shift 4
# The checkout arrives unexpanded, so a leading ~ means this account's home.
# shellcheck disable=SC2088
case "$checkout" in "~") checkout="$HOME" ;; "~/"*) checkout="$HOME/${checkout#"~/"}" ;; esac
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
# GitHub over HTTPS with gh's credential, for this process tree only.
export GIT_CONFIG_COUNT=3
export GIT_CONFIG_KEY_0='url.https://github.com/.insteadOf' GIT_CONFIG_VALUE_0='git@github.com:'
export GIT_CONFIG_KEY_1='credential.https://github.com.helper' GIT_CONFIG_VALUE_1=''
export GIT_CONFIG_KEY_2='credential.https://github.com.helper' GIT_CONFIG_VALUE_2='!gh auth git-credential'
export GIT_TERMINAL_PROMPT=0
host="$(hostname)"
# How often follow checks for the result; tests shorten it.
poll="${ORKESTRATOR_RELEASE_POLL_SECONDS:-5}"
say() { printf '[%s] %s\n' "$host" "$*"; }
die() { say "$*" >&2; exit 1; }

# The checkout's top-level directory with symlinks resolved, or nothing when
# it is not the root of a Git working tree. A linked worktree (whose .git is a
# file) counts.
checkout_root() {
  local real top
  real="$(cd "$checkout" 2>/dev/null && pwd -P)" || return 0
  top="$(git -C "$real" rev-parse --show-toplevel 2>/dev/null)" || return 0
  [ "$top" = "$real" ] && printf '%s\n' "$real"
  return 0
}

# Each checkout has its own state directory, so two checkouts on one builder
# never share a log, a result or a lock.
state_for() {
  printf '%s/.cache/orkestrator-release/%s\n' "$HOME" "$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')"
}

lock_holder() { readlink "$lock" 2>/dev/null || true; }
# Release the checkout lock only while this process still holds it: once the
# build has started it belongs to the build.
release_lock() {
  [ -z "${lock_handed_over:-}" ] || return 0
  if [ -n "${lock:-}" ] && [ "$(lock_holder)" = "pid:$$" ]; then rm -f "$lock"; fi
}

cleanup() {
  if [ -n "${tailer:-}" ]; then kill "$tailer" 2>/dev/null || true; fi
  release_lock
}
trap cleanup EXIT
# A dropped connection hangs up on this shell; exit through the trap so the
# log follower and the lock are cleaned up. The build itself ignores hangups.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Take the checkout's lock: a symlink created atomically whose target names
# the holder. Nothing may check, change or build the checkout without it. A
# lock whose holder has died is moved aside, and only if it is still the same
# dead holder's.
acquire_lock() {
  local holder aside
  for _ in 1 2 3; do
    if ln -s "pid:$$" "$lock" 2>/dev/null; then return 0; fi
    holder="$(lock_holder)"
    [ -n "$holder" ] || continue
    if kill -0 "${holder#pid:}" 2>/dev/null; then
      die "another release build holds $checkout (pid ${holder#pid:}); follow it with attach, or wait for it to finish"
    fi
    aside="$lock.stale.$$"
    mv "$lock" "$aside" 2>/dev/null || continue
    if [ "$(readlink "$aside" 2>/dev/null || true)" != "$holder" ]; then
      # Another start took the lock in between; give it back.
      mv "$aside" "$lock" 2>/dev/null || true
      die "another release start is taking the lock on $checkout; try again"
    fi
    rm -f "$aside"
    say "removed a stale lock left by pid ${holder#pid:}"
  done
  die "could not take the lock on $checkout ($lock)"
}

check() {
  local ok=0 creds=""
  for tool in git mise gh bsdtar; do
    if command -v "$tool" >/dev/null 2>&1; then say "ok: $tool"; else say "missing: $tool"; ok=1; fi
  done
  if gh auth status >/dev/null 2>&1; then say "ok: gh is signed in"; else say "gh is not signed in (run gh auth login on $host)"; ok=1; fi
  # The rewrite and the credential are checked without the network:
  # --get-url only expands the URL, and the helper is asked directly.
  if [ "$(git ls-remote --get-url git@github.com:orkestrator-ai/orkestrator-v2.git 2>/dev/null || true)" = "https://github.com/orkestrator-ai/orkestrator-v2.git" ]; then
    say "ok: git@github.com: URLs go over HTTPS"
  else
    say "git@github.com: URLs are not rewritten to HTTPS"; ok=1
  fi
  creds="$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null || true)"
  case "$creds" in
    *password=?*) say "ok: git gets GitHub credentials from gh" ;;
    *) say "git gets no GitHub credentials from gh auth git-credential (run gh auth login on $host)"; ok=1 ;;
  esac
  creds=""
  if [ -n "$(checkout_root)" ]; then
    say "ok: checkout $checkout"
    if git -C "$checkout" ls-remote --exit-code origin HEAD >/dev/null 2>&1; then
      say "ok: GitHub over HTTPS"
    else
      say "cannot reach origin over HTTPS from $checkout"; ok=1
    fi
  else
    say "no checkout at $checkout (clone it with gh repo clone orkestrator-ai/orkestrator-v2)"; ok=1
  fi
  return "$ok"
}

running() { [ -s "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; }

follow() {
  [ -f "$log" ] || die "no build log for $version from $checkout at $log; start one with build"
  say "following $log"
  tail -n +1 -F "$log" &
  tailer=$!
  while [ ! -s "$status" ]; do
    if ! running; then
      sleep "$poll"
      [ -s "$status" ] || die "the build process ended without recording a result; see $log"
    fi
    sleep "$poll"
  done
  # Let tail print the last lines before it is stopped.
  sleep 1
  local code
  code="$(cat "$status")"
  say "release-desktop build exited with $code"
  exit "$code"
}

# Paths for the checkout this run is about; check reports a bad one itself.
if [ "$mode" != check ]; then
  root="$(checkout_root)"
  [ -n "$root" ] || die "no checkout at $checkout (clone it with gh repo clone orkestrator-ai/orkestrator-v2)"
  state="$(state_for "$root")"
  log="$state/release-desktop-$version.log"
  status="$state/release-desktop-$version.exit"
  pidfile="$state/release-desktop-$version.pid"
  lock="$state/lock"
fi

case "$mode" in
  check) check ;;
  attach) follow ;;
  build)
    mkdir -p "$state"
    acquire_lock
    check >/dev/null || { check || true; die "the builder is not ready"; }
    # This attempt replaces the version's previous record, so a start refused
    # below leaves nothing for attach to replay as if it were this build.
    rm -f "$status" "$pidfile" "$log"
    cd "$root"
    [ -z "$(git status --porcelain)" ] || die "$checkout has uncommitted changes"
    git fetch --quiet origin
    git cat-file -e "$commit^{commit}" 2>/dev/null || die "commit $commit is not on origin; push and merge it first"
    git checkout --quiet --detach "$commit"
    say "checked out $(git rev-parse --short HEAD) in $checkout"
    : >"$log"
    # The build takes the lock over (re-pointing it at itself) and releases it
    # once its result is written, so the checkout stays locked until then even
    # when this connection drops. The inner script expands its own arguments:
    # $0 is the status file.
    lock_handed_over=1
    # shellcheck disable=SC2016
    ORKESTRATOR_RELEASE_LOCK="$lock" nohup bash -c '
      ln -s "pid:$$" "$ORKESTRATOR_RELEASE_LOCK.$$" && mv -f "$ORKESTRATOR_RELEASE_LOCK.$$" "$ORKESTRATOR_RELEASE_LOCK"
      mise exec -- bun scripts/release-desktop.ts build "$@"
      echo $? >"$0"
      [ "$(readlink "$ORKESTRATOR_RELEASE_LOCK")" = "pid:$$" ] && rm -f "$ORKESTRATOR_RELEASE_LOCK"
      exit 0' "$status" "$@" >>"$log" 2>&1 </dev/null &
    echo $! >"$pidfile"
    say "started the Linux release build (pid $!)"
    follow
    ;;
  *) die "unknown mode $mode" ;;
esac

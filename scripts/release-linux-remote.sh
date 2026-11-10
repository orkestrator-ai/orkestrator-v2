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
state="$HOME/.cache/orkestrator-release"
log="$state/release-desktop-$version.log"
status="$state/release-desktop-$version.exit"
pidfile="$state/release-desktop-$version.pid"
host="$(hostname)"
# How often follow checks for the result; tests shorten it.
poll="${ORKESTRATOR_RELEASE_POLL_SECONDS:-5}"
say() { printf '[%s] %s\n' "$host" "$*"; }
die() { say "$*" >&2; exit 1; }
running() { [ -s "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; }

check() {
  local ok=0
  for tool in git mise gh bsdtar; do
    if command -v "$tool" >/dev/null 2>&1; then say "ok: $tool"; else say "missing: $tool"; ok=1; fi
  done
  if gh auth status >/dev/null 2>&1; then say "ok: gh is signed in"; else say "gh is not signed in (run gh auth login on $host)"; ok=1; fi
  if [ -d "$checkout/.git" ]; then
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

follow() {
  [ -f "$log" ] || die "no build log for $version at $log; start one with build"
  say "following $log"
  tail -n +1 -F "$log" &
  tailer=$!
  trap 'kill "$tailer" 2>/dev/null || true' EXIT
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

case "$mode" in
  check) check ;;
  attach) follow ;;
  build)
    check >/dev/null || { check || true; die "the builder is not ready"; }
    running && die "a $version build is already running; follow it with attach"
    cd "$checkout"
    [ -z "$(git status --porcelain)" ] || die "$checkout has uncommitted changes"
    git fetch --quiet origin
    git cat-file -e "$commit^{commit}" 2>/dev/null || die "commit $commit is not on origin; push and merge it first"
    git checkout --quiet --detach "$commit"
    say "checked out $(git rev-parse --short HEAD) in $checkout"
    mkdir -p "$state"
    rm -f "$status"
    : >"$log"
    # The inner script expands its own arguments: $0 is the status file.
    # shellcheck disable=SC2016
    nohup bash -c 'mise exec -- bun scripts/release-desktop.ts build "$@"; echo $? >"$0"' \
      "$status" "$@" >>"$log" 2>&1 </dev/null &
    echo $! >"$pidfile"
    say "started the Linux release build (pid $!)"
    follow
    ;;
  *) die "unknown mode $mode" ;;
esac

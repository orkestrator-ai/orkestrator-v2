#!/bin/bash
set -euo pipefail

node_history=/commandhistory/.bash_history
root_history=/root/.zsh_history
node_sentinel=orkestrator-node-history-smoke
root_sentinel=orkestrator-root-history-smoke

cleanup() {
  : > "$root_history"
  sudo -u node /bin/sh -c ": > '$node_history'"
}
trap cleanup EXIT

run_login_shell() {
  local user="$1"
  local command="$2"
  shift 2

  # `script` supplies the pseudo-terminal that a real terminal tab has. This
  # avoids accepting a setup that works under `zsh -i` but fails when ZLE is
  # active, and lets the fzf key bindings initialize through their real path.
  sudo -H -u "$user" env "$@" SHELL_CHECK="$command" \
    /usr/bin/script -qec '/bin/zsh -lic "$SHELL_CHECK"' /dev/null
}

assert_shell_contract() {
  local user="$1"
  local expected_history="$2"

  run_login_shell "$user" '
    [[ "$HISTFILE" == "$EXPECTED_HISTORY" ]]
    [[ "$LANG" == en_US.UTF-8 ]]
    [[ "$LC_ALL" == en_US.UTF-8 ]]
    [[ "$(locale charmap)" == UTF-8 ]]
    (( ${+functions[compdef]} == 1 ))
    (( ${+functions[_git]} == 1 ))
    [[ "${aliases[gst]}" == "git status" ]]
    [[ "${aliases[gco]}" == "git checkout" ]]
  ' EXPECTED_HISTORY="$expected_history" >/dev/null
}

assert_history_round_trip() {
  local user="$1"
  local expected_history="$2"
  local sentinel="$3"

  run_login_shell "$user" 'print -s -- "$SENTINEL"; fc -W "$EXPECTED_HISTORY"' \
    EXPECTED_HISTORY="$expected_history" SENTINEL="$sentinel" >/dev/null
  run_login_shell "$user" \
    'fc -R "$EXPECTED_HISTORY"; fc -l -1 | grep -Fq -- "$SENTINEL"' \
    EXPECTED_HISTORY="$expected_history" SENTINEL="$sentinel" >/dev/null
}

assert_shell_contract node "$node_history"
assert_shell_contract orkroot "$root_history"
assert_history_round_trip node "$node_history" "$node_sentinel"
assert_history_round_trip orkroot "$root_history" "$root_sentinel"

grep -Fq -- "$node_sentinel" "$node_history"
! grep -Fq -- "$root_sentinel" "$node_history"
grep -Fq -- "$root_sentinel" "$root_history"
! grep -Fq -- "$node_sentinel" "$root_history"
sudo -H -u node test ! -r "$root_history"
[[ "$(stat -c %a "$root_history")" == 600 ]]
[[ "$(stat -c %u:%g "$root_history")" == 0:0 ]]

# A missing optional prompt binary must not make an otherwise usable shell
# print a startup error. Source only the shared hook with a PATH lacking
# /usr/local/bin, where Starship is installed.
missing_starship_stderr="$({ PATH=/usr/bin:/bin /bin/zsh -dfc 'source /etc/orkestrator/zshrc'; } 2>&1 >/dev/null)"
[[ -z "$missing_starship_stderr" ]]

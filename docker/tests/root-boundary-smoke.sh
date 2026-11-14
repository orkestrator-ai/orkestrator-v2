#!/bin/bash
# Root-boundary smoke (security report finding H2): run the built image, let
# the node user plant code everywhere it can reach, then start every kind of
# root process the backend starts and prove none of them ran it.
#
#   bash docker/tests/root-boundary-smoke.sh <image>
#
# node plants (each probe records a hit only when it runs as uid 0, then
# runs the real tool so nothing else changes):
# - same-named copies of the commands root scripts call, in the node-writable
#   directories at the front of the image PATH;
# - a current-format /tmp/orkestrator-ai/runtime-env.sh and bash-env.sh;
# - a zsh `compinit` in root's completion directory, if node can write it;
# - a trusted mise.toml and a git fsmonitor in /workspace.
#
# Root processes, started as the backend starts them (CONTAINER_ROOT_PATH in
# apps/backend/src/core/container-scripts.ts): a uid-0 `orkroot` terminal
# (interactive zsh behind a pseudo-terminal), the host repair, project-files
# and provider-stop shells, update-firewall.sh, the declared-package installer
# and the stop drain. The drain, firewall script and installer also run once
# with the image PATH, as an older backend would, to prove the scripts' own
# PATH reset.
#
# Also proves npm globals still install and run for node.
#
# The container has no network, no mounts or credentials. It is labelled for
# this run and removed on exit. Exits non-zero, listing each hit, when root ran
# anything node planted.
set -euo pipefail

IMAGE="${1:?usage: root-boundary-smoke.sh <image>}"
RUN="ork-root-boundary-$$-${RANDOM}"
ROOT_PATH=/usr/sbin:/usr/bin:/sbin:/bin

cleanup() { docker rm -f "$RUN" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

docker run -d --name "$RUN" --label "orkestrator-image-smoke=$RUN" --network none \
    -e NETWORK_MODE=full "$IMAGE" >/dev/null

# Ready means this boot's status record says so (it names PID 1's start time).
ready=0
for _ in $(seq 1 120); do
    if docker exec -i "$RUN" bash 2>/dev/null <<'READY'
start=$(awk '{print $22}' /proc/1/stat)
jq -e --arg start "$start" '.phase == "ready" and .pid1Start == $start' \
    /run/orkestrator/boot-status.json >/dev/null 2>&1
READY
    then
        ready=1
        break
    fi
    [ "$(docker inspect -f '{{.State.Running}}' "$RUN")" = true ] || break
    sleep 1
done
[ "$ready" = 1 ] || fail "entrypoint did not complete"

# The harness's own root reads use the fixed PATH, so they never trip a probe.
harness() { docker exec --env PATH="$ROOT_PATH" --user root "$RUN" "$@"; }
# Root-owned marker directory: a probe running as root appends here.
harness sh -c 'install -d -m 0700 /root/root-boundary && : > /root/root-boundary/hits'

echo "== planting as node"
docker exec -i --user node "$RUN" bash -s <<'PLANT'
set -u
probe_body() {
    printf '#!/bin/sh\n[ "$(/usr/bin/id -u)" = 0 ] && echo "%s" >> /root/root-boundary/hits\n' "$1"
}
plant_command() {
    local file="$1" name
    name=$(basename "$file")
    if { mkdir -p "$(dirname "$file")" && {
            probe_body "$file"
            printf 'PATH=/usr/sbin:/usr/bin:/sbin:/bin exec %s "$@"\n' "$name"
        } > "$file" && chmod 755 "$file"; } 2>/dev/null; then
        echo "planted  $file"
    else
        echo "refused  $file"
    fi
}
for dir in /usr/local/share/npm-global/bin /home/node/.opencode/bin /usr/local/bin /usr/local/sbin; do
    for name in awk ps cat date sleep wc readlink chgrp chmod pkill iptables ipset ip getent mktemp install id stat find sed grep env rm apt-get apt-cache dpkg dpkg-query flock; do
        plant_command "$dir/$name"
    done
done

# Root zsh autoloads compinit from fpath; the first entry is this directory.
if { probe_body zsh-site-functions-compinit; echo 'unfunction compinit; autoload -Uz compinit; compinit "$@"'; } \
    2>/dev/null >/usr/local/share/zsh/site-functions/compinit; then
    echo "planted  /usr/local/share/zsh/site-functions/compinit"
else
    echo "refused  /usr/local/share/zsh/site-functions/compinit"
fi

# A current (v3) runtime snapshot and the BASH_ENV file, both node's.
mkdir -p /tmp/orkestrator-ai
{
    printf '# orkestrator-runtime-env: v3\n'
    printf '[ "$(/usr/bin/id -u)" = 0 ] && echo runtime-env.sh >> /root/root-boundary/hits\n'
    printf 'PATH="/usr/local/share/npm-global/bin:$PATH"; export PATH\n'
} > /tmp/orkestrator-ai/runtime-env.sh && echo "planted  /tmp/orkestrator-ai/runtime-env.sh"
printf '[ "$(/usr/bin/id -u)" = 0 ] && echo bash-env.sh >> /root/root-boundary/hits\n' \
    > /tmp/orkestrator-ai/bash-env.sh && echo "planted  /tmp/orkestrator-ai/bash-env.sh"

# Configuration root tools would load from node-writable paths: mise.toml
# under the image's trusted /workspace, and a git fsmonitor for the prompt's
# git status (git's safe.directory check already refuses node's repository).
{ probe_body mise-config; } > /tmp/mise-probe.sh && chmod 755 /tmp/mise-probe.sh
printf '[env]\n_.source = "/tmp/mise-probe.sh"\n' > /workspace/mise.toml && echo "planted  /workspace/mise.toml"
{ probe_body git-fsmonitor; echo 'exit 1'; } > /tmp/fsmonitor-probe && chmod 755 /tmp/fsmonitor-probe
git -C /workspace rev-parse --git-dir >/dev/null 2>&1 || git init -q /workspace
git -C /workspace config core.fsmonitor /tmp/fsmonitor-probe && echo "planted  /workspace/.git fsmonitor"
PLANT

echo "== npm globals for node"
docker exec -i --user node "$RUN" bash -s <<'NPM' || fail "npm global install for node failed"
set -euo pipefail
package=$(mktemp -d)
printf '{"name":"root-boundary-probe","version":"1.0.0","bin":{"root-boundary-probe":"cli.js"}}\n' > "$package/package.json"
printf '#!/usr/bin/env node\nconsole.log("npm-global-ok")\n' > "$package/cli.js"
chmod 755 "$package/cli.js"
npm install -g --offline --no-audit --no-fund "$package" >/dev/null 2>&1
test "$(root-boundary-probe)" = npm-global-ok
test "$(command -v root-boundary-probe)" = /usr/local/share/npm-global/bin/root-boundary-probe
npm uninstall -g root-boundary-probe >/dev/null 2>&1
NPM
echo "ok   npm install -g works for node"

echo "== root processes"
root_exec() { docker exec --env PATH="$ROOT_PATH" --user root "$RUN" "$@"; }

# Root terminal: the backend's exact launch (commands-registry-terminal.ts,
# CONTAINER_INTERACTIVE_SHELL_COMMAND) behind a pseudo-terminal, so zsh runs
# its rc files and renders its prompt in /workspace before reading commands.
TERMINAL_COMMAND='source /usr/local/bin/orkestrator-runtime-env.sh 2>/dev/null || true
orkestrator_source_runtime_env 2>/dev/null || true
if [ -n "${ORKESTRATOR_TERMINAL_SESSION:-}" ]; then
  orkestrator_terminal_close() (
token="$1"
case "$token" in ""|*[!0-9a-f-]*) exit 0 ;; esac
marker="ORKESTRATOR_TERMINAL_SESSION=$token"
dir="/tmp/orkestrator-terminals-$(id -u)"
file="$dir/$token.pid"
pid=""
sid=""
if [ -d "$dir" ] && [ ! -L "$dir" ] && [ -O "$dir" ] && [ -f "$file" ] && [ ! -L "$file" ]; then
  read -r pid sid < "$file" 2>/dev/null
  rm -f "$file"
fi
case "$sid" in ""|*[!0-9]*) sid="" ;; esac
case "$pid" in
  ""|*[!0-9]*) ;;
  *) if grep -qzxF "$marker" "/proc/$pid/environ" 2>/dev/null; then
       [ -n "$sid" ] || sid=$(ps -o sid= -p "$pid" 2>/dev/null | tr -d " ")
       kill -s HUP -- "-$pid" 2>/dev/null || kill -s HUP "$pid" 2>/dev/null
     fi ;;
esac
[ -n "$sid" ] || exit 0
for environ in /proc/[0-9]*/environ; do
  candidate="${environ#/proc/}"
  candidate="${candidate%/environ}"
  [ "$candidate" = "$$" ] && continue
  grep -qzxF "$marker" "$environ" 2>/dev/null || continue
  candidate_sid=$(ps -o sid= -p "$candidate" 2>/dev/null | tr -d " ")
  [ "$candidate_sid" = "$sid" ] && kill -s HUP "$candidate" 2>/dev/null
done
exit 0
  )
  orkestrator_terminal_instance="${ORKESTRATOR_TERMINAL_SESSION%%--*}--"
  orkestrator_terminal_dir="/tmp/orkestrator-terminals-$(id -u)"
  mkdir -p -m 700 "$orkestrator_terminal_dir" 2>/dev/null
  if [ -d "$orkestrator_terminal_dir" ] && [ ! -L "$orkestrator_terminal_dir" ] && [ -O "$orkestrator_terminal_dir" ]; then
    for orkestrator_terminal_file in "$orkestrator_terminal_dir"/*.pid; do
      [ -f "$orkestrator_terminal_file" ] || continue
      orkestrator_terminal_token="${orkestrator_terminal_file##*/}"
      case "${orkestrator_terminal_token%.pid}" in
        "$orkestrator_terminal_instance"*) ;;
        *) orkestrator_terminal_close "${orkestrator_terminal_token%.pid}"; continue ;;
      esac
      orkestrator_terminal_pid=""
      read -r orkestrator_terminal_pid orkestrator_terminal_sid < "$orkestrator_terminal_file" 2>/dev/null
      grep -qzxF "ORKESTRATOR_TERMINAL_SESSION=${orkestrator_terminal_token%.pid}" "/proc/${orkestrator_terminal_pid:-0}/environ" 2>/dev/null || rm -f "$orkestrator_terminal_file"
    done
    echo "$$ $(ps -o sid= -p $$)" > "$orkestrator_terminal_dir/${ORKESTRATOR_TERMINAL_SESSION}.pid"
  fi
  unset orkestrator_terminal_dir orkestrator_terminal_file orkestrator_terminal_token orkestrator_terminal_pid orkestrator_terminal_sid orkestrator_terminal_instance
  unset -f orkestrator_terminal_close
fi
exec zsh -l'
# A token, as the backend passes one, so the shell records its PID too.
TERMINAL_TOKEN=00000000-0000-4000-8000-000000000000
TERMINAL_INPUT='cd /workspace
awk 1 </dev/null; cat </dev/null; date >/dev/null; id >/dev/null
mise env >/dev/null 2>&1 </dev/null
git status >/dev/null 2>&1
print -r -- "$PATH" > /root/root-boundary/terminal-path
print -r -- "${BASH_ENV:-}|${NPM_CONFIG_PREFIX:-}|${MISE_TRUSTED_CONFIG_PATHS:-}" > /root/root-boundary/terminal-env
bash -c true
exit'
{ sleep 3; printf '%s\n' "$TERMINAL_INPUT"; sleep 3; } |
    docker exec -i --env PATH="$ROOT_PATH" --env TERMINAL_COMMAND="$TERMINAL_COMMAND" \
        --env ORKESTRATOR_TERMINAL_SESSION="$TERMINAL_TOKEN" --user orkroot "$RUN" /usr/bin/script -qec 'bash -lc "$TERMINAL_COMMAND"' /dev/null \
        >/dev/null 2>&1 || true
harness test -s /root/root-boundary/terminal-path \
    || fail "the root terminal did not run its commands"
echo "ran  root terminal (orkroot)"

# Closing that terminal: the backend's exact close script
# (container-scripts.ts, CONTAINER_TERMINAL_CLOSE_SCRIPT), as the terminal's
# own user, removes the record the shell left.
CLOSE_SCRIPT='token="$1"
case "$token" in ""|*[!0-9a-f-]*) exit 0 ;; esac
marker="ORKESTRATOR_TERMINAL_SESSION=$token"
dir="/tmp/orkestrator-terminals-$(id -u)"
file="$dir/$token.pid"
pid=""
sid=""
if [ -d "$dir" ] && [ ! -L "$dir" ] && [ -O "$dir" ] && [ -f "$file" ] && [ ! -L "$file" ]; then
  read -r pid sid < "$file" 2>/dev/null
  rm -f "$file"
fi
case "$sid" in ""|*[!0-9]*) sid="" ;; esac
case "$pid" in
  ""|*[!0-9]*) ;;
  *) if grep -qzxF "$marker" "/proc/$pid/environ" 2>/dev/null; then
       [ -n "$sid" ] || sid=$(ps -o sid= -p "$pid" 2>/dev/null | tr -d " ")
       kill -s HUP -- "-$pid" 2>/dev/null || kill -s HUP "$pid" 2>/dev/null
     fi ;;
esac
[ -n "$sid" ] || exit 0
for environ in /proc/[0-9]*/environ; do
  candidate="${environ#/proc/}"
  candidate="${candidate%/environ}"
  [ "$candidate" = "$$" ] && continue
  grep -qzxF "$marker" "$environ" 2>/dev/null || continue
  candidate_sid=$(ps -o sid= -p "$candidate" 2>/dev/null | tr -d " ")
  [ "$candidate_sid" = "$sid" ] && kill -s HUP "$candidate" 2>/dev/null
done
exit 0'
docker exec --env PATH="$ROOT_PATH" --user orkroot "$RUN" sh -c "$CLOSE_SCRIPT" orkestrator-terminal-close "$TERMINAL_TOKEN" \
    || fail "the root terminal close script failed"
harness test ! -e "/tmp/orkestrator-terminals-0/$TERMINAL_TOKEN.pid" \
    || fail "the root terminal close left its record"
echo "ran  root terminal close (orkroot)"

# The other root shells the backend runs (commands-environment.ts host
# repair, commands-files.ts project-files access, portable-input-status.ts
# provider stop), with the commands they resolve.
root_exec bash -lc "awk '\$2 != \"x\"' /etc/hosts >/dev/null; cat /etc/hosts >/dev/null; getent hosts localhost >/dev/null || true" \
    && echo "ran  host repair shell"
root_exec sh -c 'chgrp --version >/dev/null; chmod --version >/dev/null; find /dev/null >/dev/null' \
    && echo "ran  project-files access shell"
# The bracket keeps the pattern from matching this shell's own command line.
root_exec sh -c "pkill -TERM -f 'no-such-root-boundary-[p]rocess' || true" && echo "ran  provider stop shell"

# update-firewall.sh, as the backend runs it and with the image PATH.
root_exec /usr/local/bin/update-firewall.sh --list >/dev/null 2>&1 || true
docker exec --user root "$RUN" /usr/local/bin/update-firewall.sh --list >/dev/null 2>&1 || true
echo "ran  update-firewall.sh (fixed PATH, image PATH)"

# The declared-package installer (to-do 7770), through node's own sudo grant
# as workspace-setup.sh calls it, and as root with the image PATH. With no
# network it refuses a bad name, then gets as far as apt-get update.
docker exec --user node "$RUN" sudo -n /usr/local/bin/orkestrator-apt-install 'bad;name' >/dev/null 2>&1 \
    && fail "orkestrator-apt-install accepted a bad name"
status=0
docker exec --user node "$RUN" sudo -n /usr/local/bin/orkestrator-apt-install hello >/dev/null 2>&1 || status=$?
[ "$status" = 5 ] || fail "orkestrator-apt-install (sudo) ended with $status, not 5 (archive unreachable)"
status=0
docker exec --user root "$RUN" /usr/local/bin/orkestrator-apt-install hello >/dev/null 2>&1 || status=$?
[ "$status" = 5 ] || fail "orkestrator-apt-install (image PATH) ended with $status, not 5"
echo "ran  orkestrator-apt-install (node sudo, image PATH)"

# The stop drain last: it signals every workload process.
docker exec --user root "$RUN" /usr/local/bin/orkestrator-drain.sh 1 \
    | grep -q '^ORKESTRATOR_DRAIN ' || fail "drain (image PATH) did not report"
root_exec /usr/local/bin/orkestrator-drain.sh 1 \
    | grep -q '^ORKESTRATOR_DRAIN ' || fail "drain (fixed PATH) did not report"
echo "ran  orkestrator-drain.sh (image PATH, fixed PATH)"

echo "== result"
terminal_path=$(harness cat /root/root-boundary/terminal-path)
terminal_env=$(harness cat /root/root-boundary/terminal-env)
echo "root terminal PATH: $terminal_path"
echo "root terminal BASH_ENV|NPM_CONFIG_PREFIX|MISE_TRUSTED_CONFIG_PATHS: $terminal_env"
hits=$(harness sort -u /root/root-boundary/hits)
status=0
if [ -n "$hits" ]; then
    echo "root ran code node planted:"
    printf '  %s\n' $hits
    status=1
fi
case ":$terminal_path:" in
    *:/usr/local/share/*|*:/home/node/*|*:/tmp/*|*:/workspace*)
        echo "root terminal PATH includes a node-writable directory"
        status=1
        ;;
esac
[ "$terminal_env" = "||" ] || { echo "root terminal kept a node-controlled setting"; status=1; }
if [ "$status" = 0 ]; then
    echo "root boundary smoke: passed"
else
    echo "root boundary smoke: FAILED" >&2
fi
exit "$status"

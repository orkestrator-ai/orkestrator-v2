#!/usr/bin/env bash
# An agent building while a browser check and two other agent turns run: the
# build, a one-browser browser workload and two agents at once in one
# container.
set -u
cd /tmp/w
now() { date +%s%3N; }
last_json() { local line; line=$(tail -1 "$1" 2>/dev/null); echo "${line:-null}"; }
started=$(now)
bash build.sh > /tmp/w/combined-build.json &
build=$!
BROWSERS=${BROWSERS:-1} node browser.cjs > /tmp/w/combined-browser.json &
browser=$!
AGENTS=${AGENTS:-2} bash provider.sh > /tmp/w/combined-provider.json &
provider=$!
wait "$build" "$browser" "$provider"
printf '{"workload":"combined","wallMs":%d,"build":%s,"browser":%s,"provider":%s}\n' \
  "$(( $(now) - started ))" \
  "$(last_json /tmp/w/combined-build.json)" \
  "$(last_json /tmp/w/combined-browser.json)" \
  "$(last_json /tmp/w/combined-provider.json)"

#!/usr/bin/env bash
# The kernel's own peaks and counters for this container's cgroup, as JSON.
set -u
cg=/sys/fs/cgroup
value() { [[ -r "$cg/$1" ]] && cat "$cg/$1" || echo null; }
field() { awk -v k="$2" '$1 == k { print $2; found = 1 } END { if (!found) print "null" }' "$cg/$1" 2>/dev/null || echo null; }
printf '{"memoryPeakBytes":%s,"memoryMax":"%s","pidsPeak":%s,"pidsMax":"%s","oom":%s,"oomKill":%s,"memoryHighEvents":%s,"memoryMaxEvents":%s,"pidsMaxEvents":%s,"cpuUsageUsec":%s,"cpuThrottledPeriods":%s,"cpuThrottledUsec":%s,"cpuMax":"%s"}\n' \
  "$(value memory.peak)" "$(value memory.max)" "$(value pids.peak)" "$(value pids.max)" \
  "$(field memory.events oom)" "$(field memory.events oom_kill)" "$(field memory.events high)" \
  "$(field memory.events max)" "$(field pids.events max)" "$(field cpu.stat usage_usec)" \
  "$(field cpu.stat nr_throttled)" "$(field cpu.stat throttled_usec)" "$(value cpu.max)"

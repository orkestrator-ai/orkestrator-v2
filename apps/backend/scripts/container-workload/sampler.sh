#!/usr/bin/env bash
# Peak cgroup usage of this container, sampled every 250 ms with shell
# builtins only (no fork per sample) until /tmp/w/stop exists. memory.peak
# counts reclaimable page cache too; `anon` and `shmem` (which holds /dev/shm)
# are the parts a memory limit cannot reclaim without swap.
set -u
cg=/sys/fs/cgroup
# A pipe held open read-write never reaches EOF: `read -t` on it is a
# fork-free sleep.
exec {tick}<> <(:)
max_anon=0 max_shmem=0 max_file=0 max_current=0 max_pids=0 samples=0
while [[ ! -e /tmp/w/stop ]]; do
  while read -r key value; do
    case "$key" in
      anon) ((value > max_anon)) && max_anon=$value ;;
      shmem) ((value > max_shmem)) && max_shmem=$value ;;
      file) ((value > max_file)) && max_file=$value ;;
    esac
  done < "$cg/memory.stat"
  read -r current < "$cg/memory.current"
  ((current > max_current)) && max_current=$current
  read -r pids < "$cg/pids.current"
  ((pids > max_pids)) && max_pids=$pids
  samples=$((samples + 1))
  read -r -t 0.25 -u "$tick" || true
done
printf '{"samples":%d,"anonPeakBytes":%d,"shmemPeakBytes":%d,"filePeakBytes":%d,"currentPeakBytes":%d,"pidsPeakSampled":%d}\n' \
  "$samples" "$max_anon" "$max_shmem" "$max_file" "$max_current" "$max_pids" > /tmp/w/peaks.json

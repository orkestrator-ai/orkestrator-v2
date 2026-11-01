# Debugging crashes, killed processes and blank windows (Linux)

How to find out why part of the desktop app stopped: the window went white,
the "backend stopped" dialog appeared, the app vanished, or Omarchy reported a
crash. Written after the 2026-10-26 incidents (see the end), on an Omarchy /
Arch host running the AppImage build. Most steps apply to any Linux host.

## 1. First look: what died, and how

| Symptom | Process that died | Where it is recorded |
| --- | --- | --- |
| "Orkestrator AI backend stopped … signal SIGKILL" | Local backend (`resources/bin/bun … backend/main.js`) | App log: `[desktop] backend.exited error.message="Backend service exited (code …, signal …)"` |
| Window white, backend still reachable from another machine | Main window renderer (`orkestrator-v2 --type=renderer`) | App log: `[DesktopStartup] renderer-gone reason=…`, then `Render frame was disposed before WebFrameMain could be accessed` repeated |
| App gone, core dump `SIGTRAP` at startup | A relaunched main process | `coredumpctl`; core memory contains `Invalid file descriptor to ICU data` |
| Core dump `SIGBUS`, `--type=utility` network service, on quit | Chromium child outliving the main process | `coredumpctl`; journal shows `tmp-.mount_orkest….mount: Deactivated` the same second |
| Core dump of `~/.cache/ms-playwright/…/chrome` | A test's Playwright browser, not the app | `coredumpctl`; its command line has `--user-data-dir=/tmp/playwright_chromiumdev_profile-*` |
| Everything times out (mail, MCP, controls) but nothing died | Nothing: the backend's or the desktop's event loop was held | App log: `[Backend] Event loop stalled for N ms`, or a gap in the log followed by `[Backend] Dropped N log line(s) … the log reader was not draining output` (the desktop stopped reading); `eventLoop` and `consoleOutput` in `/__orkestrator/metrics`. See todo 0741 |

Commands:

```bash
# App log (desktop + its backend's output). One file per UTC day.
less ~/.config/orkestrator-v2/logs/orkestrator-ai-$(date -u +%F).log
grep -nE 'renderer-gone|exited unexpectedly|Received SIG|Quitting; stopping|Shutdown finished|Event stream disconnected' \
  ~/.config/orkestrator-v2/logs/orkestrator-ai-$(date -u +%F).log

# Core dumps today, then details for one PID
coredumpctl list --since today --no-pager
coredumpctl info <PID> --no-pager

# Everything the system saw around a time (UTC on this host)
journalctl --since '2026-10-26 09:24:20' --until '2026-10-26 09:24:45' --no-pager -o short-precise \
  | grep -vE 'UFW BLOCK|avahi|NetworkManager|overlayfs'
```

How to read the result:

- **`signal SIGKILL` / `reason=killed` with no core dump** means something sent
  the process a signal. It did not crash. Electron's `killed` means "sent
  SIGTERM or otherwise killed externally". Go to section 3; only an audit
  trail can name the sender.
- **`crashed`, `oom`, or a core dump with SIGSEGV/SIGABRT** is a real crash.
  Use the `diagnose-crash` skill (`coredumpctl`, gdb).
- **No OOM:** check `journalctl -k | grep -i oom` and the app scope's
  `memory.events` (`oom_kill 0`) before blaming memory:

  ```bash
  P=$(pgrep -of 'orkestrator-v2$' || pgrep -of orkestrator-v2)
  cat /sys/fs/cgroup$(cut -d: -f3 /proc/$P/cgroup)/memory.events
  ```

  A process-group or cgroup kill takes Electron down too. If Electron
  survived, the signal was aimed at one PID.

Builds with the 2026-10-26 fixes also log `[desktop] quit.stopping-backend`,
`[Backend] Received SIGTERM; shutting down` and
`[Backend] Shutdown finished; exiting with 0` on a normal quit. If those lines
are missing before an exit, the app did not quit by itself.

## 2. Who else was running

Agents run inside the app, as descendants of its backend, and their tests and
scripts share the host. Check what they ran just before the failure.

```bash
# Claude Code sessions: tool calls in a time window (paths start with '-', so prefix ./)
cd ~/.claude/projects
for f in $(ls -t ./*/*.jsonl | head -40); do
  out=$(jq -r 'select(.timestamp >= "2026-10-26T09:23:30" and .timestamp <= "2026-10-26T09:24:42")
    | select(.type=="assistant") | .timestamp as $t | .message.content[]?
    | select(.type=="tool_use") | "\($t) \(.name): \((.input.command // (.input|tostring)) | .[0:300])"' -- "$f" 2>/dev/null)
  [ -n "$out" ] && { echo "=== $f"; echo "$out"; }
done

# Codex sessions live under ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl

# Long-running test suites and services right now
ps -eo pid,ppid,etime,args --sort=start_time | grep -E 'test-all|mise run test|bun test' | grep -v grep
systemctl --user list-units --all 'orkestrator-backend*' --no-pager
```

A `bun` whose parent is `systemd --user` (check with `ps -o pid,args -p
<ppid>`) is a real systemd user service. `orkestrator service install` creates those. A
qualification run that is killed before its cleanup leaves the unit running.

## 3. Catching the sender of a signal (needs root)

A process cannot see who SIGKILLed it. The kernel audit system can. It records
the sender (`comm`, `exe`, `pid`, `ppid`) and the target (`opid`, `ocomm`) of
every matching `kill`.

Save this as a file and run it with `sudo bash`. Pasting the loop into some
terminals leaves `$sig` empty, and auditctl then gets `-F a1=` and refuses
the rule.

```bash
#!/usr/bin/env bash
# ork-audit-on.sh: record every SIGKILL and SIGTERM sent by UID 1000
set -euo pipefail
systemctl start auditd
auditctl -b 8192
for sig in 9 15; do
  # kill / tkill / pidfd_send_signal carry the signal in argument 1; tgkill in argument 2
  auditctl -a always,exit -F arch=b64 -S kill -S tkill -S pidfd_send_signal -F a1=$sig -F uid=1000 -k ork-kill
  auditctl -a always,exit -F arch=b64 -S tgkill -F a2=$sig -F uid=1000 -k ork-kill
done
auditctl -l
```

```bash
sudo bash ork-audit-on.sh
```

Leave it running. Test suites send many legitimate signals, so expect noise.
When something dies, export the records:

```bash
sudo ausearch -k ork-kill -i --start today > ~/ork-kill-audit.txt
sudo chown "$USER" ~/ork-kill-audit.txt
```

Summarise them, one line per signal:

```bash
python3 -I - ~/ork-kill-audit.txt <<'EOF'
import re, sys
for ev in open(sys.argv[1]).read().split('----'):
    if 'OBJ_PID' not in ev: continue
    time = re.search(r'audit\(\S+ (\S+):', ev).group(1)
    title = re.search(r'proctitle=(.*)', ev).group(1)[:110]
    call = re.search(r'type=SYSCALL.*', ev).group(0)
    field = lambda k: (re.search(rf' {k}=(\S+)', call) or [None, None])[1]
    signal = field('a2') if field('syscall') == 'tgkill' else field('a1')
    for pid, comm in re.findall(r'OBJ_PID.*?opid=(\d+).*?ocomm=(\S+)', ev):
        print(time, signal, f"sender={field('pid')} (ppid {field('ppid')}) {field('comm')}",
              "->", pid, comm, "|", title)
EOF
```

Then find the line whose target is the process that died: `ocomm=orkestrator-v2`
for a renderer, `ocomm=bun` for the backend (match the PID from the app log or
`ps`). Follow the sender's `ppid` chain with `ps -o pid,ppid,args -p …`. If
the sender has already exited, use the `proctitle` and the transcripts from
section 2. A negative `a0` (for example `0xffe673bb`) means the call targeted a
whole process group, `-a0`.

Turn it off (the rules also disappear on reboot):

```bash
sudo auditctl -D        # deletes every audit rule; use -d with the same arguments to remove only these
sudo systemctl stop auditd
```

`killsnoop` from `bpfcc-tools` shows the same information live, and also needs
root.

## 4. AppImage-specific failures

The AppImage runs from a temporary FUSE mount, `/tmp/.mount_orkest<random>`,
which its runtime removes the moment the main process exits.

- **SIGTRAP right after a restart**, with `Invalid file descriptor to ICU
  data` in the core: the new process was started from the old mount path and
  the mount disappeared under it. Restarts must start the `.appimage` file
  (`$APPIMAGE`), never `process.execPath`. `apps/desktop/electron/relaunch.ts`
  does this for every in-app restart. The waiter starts from the home
  directory, so removing the original launch worktree cannot break restart.
  In a systemd scope or service (including Omarchy/UWSM launches), it is registered
  synchronously as a separate transient user service before quitting; a
  detached child alone still belongs to the old cgroup and can be killed
  when that scope stops. If service registration fails, the log reports the
  fallback to a detached waiter.
- **SIGBUS in a `--type=utility` network-service process on quit**: Chromium's
  child outlived the main process and the mount went away. It is noisy but
  harmless, and the app cannot hold the mount open after it exits.
- **Stale paths in the environment**: `LD_LIBRARY_PATH` holding several
  `/tmp/.mount_*` entries means the process inherited them from an earlier
  instance (the updater launches the new image from the old process).

## 5. The 2026-10-26 incidents

| Time (UTC) | What happened | Cause | Status |
| --- | --- | --- | --- |
| 00:58:57 | Local backend SIGKILLed | Unknown sender. Two full `mise run test` suites and a qualification service install were running inside the app. | Audit trail (section 3) set up to catch the next one |
| 00:58:57 → 09:05:37 | App frozen for 8 hours | `dialog.showErrorBox` blocks Electron's main process on Linux until answered | Replaced with a non-blocking dialog that offers Restart |
| 09:05:47 | SIGTRAP after Restart | `app.relaunch()` restarted the vanished mount path | `relaunch.ts` restarts from `$APPIMAGE` |
| 09:07 | Control MCP failed: port 34122 in use | A qualification service (`orkestrator-backend-<hash>.service`) left running for 8 hours held it | `agent-test` backends, and every backend whose data directory is not the default, now use an ephemeral control MCP port; a taken fixed port is retried ([0244](../todo/cross-cutting/0244-second-backend-on-one-host.md)) |
| 09:11:12 | SIGBUS on quit | Network-service child outlived the main process | Documented; harmless |
| 09:24:40 | Main window white | Renderer `reason=killed`, sender unknown, again during a test suite | Window now reloads itself (`renderer-recovery.ts`, at most 3 times a minute) |
| 09:25:52 | Playwright Chromium SIGSEGV | A test's headless browser (null-pointer read in Chromium) | Unrelated to the white window |

Leaked `docker events` OOM followers from killed backends were also found in
old `app-orkestrator-v2-*.scope` cgroups. Followers now exit when their backend
dies (`spawnParentBoundCommand` in `apps/backend/src/core/shell.ts`). To clear
ones left by older builds:

```bash
for s in /sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/app.slice/app-orkestrator*.scope; do
  echo "== $s"; xargs -r ps -o pid,etime,args -p < "$s/cgroup.procs"
done
```

Kill a leftover `docker events --filter event=oom` only if its scope's
`orkestrator-v2` main process is gone.

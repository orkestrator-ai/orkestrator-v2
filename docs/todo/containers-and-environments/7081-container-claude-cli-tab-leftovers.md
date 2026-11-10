# Container terminals outlive their tab, and the auto-mode offer returns on every start

## Task analysis

Analysed 2026-11-06 against `main` at `e6c3da899`, on beelink (rootful
Docker Engine 29.9.2), image `orkestrator-v2:dev-0de0f31b9b02`, Claude Code
2.1.314, while running [0020](0020-container-state-observation.md) tasks 2–4.
Neither finding is specific to Linux.

### Tasks

1. **Closing a container terminal leaves its processes running**: stop the in-container shell and everything under it when a container terminal is closed. Status: done (2026-11-06).
2. **Record the auto-mode answer in the image**: stop terminal Claude asking "Make auto mode your default permission mode?" on every container start. Status: done (2026-11-06).

### 1. Closing a container terminal leaves its processes running

**Problem.** `detach_terminal` (and every other explicit close) kills only the host's `docker exec -it` client. Docker does not end an exec when its client goes away, so the container keeps the shell and whatever it was running. A closed **Claude CLI** tab leaves `claude --dangerously-skip-permissions` running in the container, and every open and close adds another.

**Context.** Container terminals run `docker exec -it <id> bash -lc CONTAINER_INTERACTIVE_SHELL_COMMAND` (`create_terminal_session` and `start_terminal_session` in `apps/backend/src/core/commands-registry-terminal.ts`). `TerminalRuntime.explicitlyCloseSession` (`apps/backend/src/core/terminal-runtime.ts`) calls the PTY's `kill()` and forgets the session. `terminateSessionsForEnvironment` waits for the host process tree, which ends with the client, not with the container side.

**Investigation.** Reproduced through the backend's own commands on an isolated profile: `create_terminal_session`, `start_terminal_session`, `terminal_write "sleep 4321\r"`, then `detach_terminal`. Afterwards `get_terminal_session` answered `running: false`, `list_terminal_sessions` no longer listed it and no host `docker exec` client remained, but `sleep 4321` and its `zsh -l` were still running in the container five seconds later. Each `container-claude-terminal-signal.spec.ts` run left one `zsh -l` → `claude` pair the same way. Its cleanup assertion checks only the backend's view, so it passes. `kill -HUP` on the orphaned shell ended both it and its child.

**Decisions.**

- **How to end the container side?**
  - **Have the interactive shell record its PID in a per-session file, and on close `docker exec` a `kill -HUP` of that process group, after checking `/proc/<pid>/cmdline` (recommended).**
    - Pros: matches the worktree watcher's pid-file pattern; HUP is what a closed terminal sends, so shells and TUIs exit normally; works the same on Desktop and Linux Engine.
    - Cons: one more exec per close; a close while the container is stopped or unreachable has nothing to signal, so the next start should sweep stale session files.
  - **Run each terminal inside a per-session tmux session in the container and kill the tmux session on close.**
    - Pros: tmux owns the process group cleanly.
    - Cons: changes the terminal transport for every container tab.
- **Should the spec prove it?**
  - **Yes: after `detach_terminal`, assert that no process from the test's session is left in the container (recommended).**
    - Pros: the spec claims "Explicitly stop both Claude and its shell", and today it cannot see that it does not.
    - Cons: needs a content-free way to find the session's processes, which the fix above provides.

### 2. Record the auto-mode answer in the image

**Problem.** Terminal Claude offers "Make auto mode your default permission mode?" on every container start unless the staged host `~/.claude.json` already carries `hasSeenAutoDefaultNudge`. A credential-free container, and any container whose host never saw the offer, shows it in every new **Claude CLI** tab after each start.

**Context.** `docker/entrypoint.sh` rebuilds `~/.claude.json` on every boot: from the staged host config through `CLAUDE_JSON_ALLOWED_KEYS`, or from a minimal fallback. It always sets `bypassPermissionsModeAccepted` and `hasCompletedOnboarding`, but sets `hasSeenAutoDefaultNudge` only when the host file has it. The key is already allowlisted (`CLAUDE_CONTAINER_ONBOARDING_FLAGS` in `apps/backend/src/core/claude-container-config.ts`, whose comment says the CLI asks on every start without it).

**Investigation.** On an isolated credential-free profile the offer appeared at the first start. Answering "No, keep bypass permissions" made Claude Code write `hasSeenAutoDefaultNudge: true` and `hasResetAutoModeOptInForDefaultOffer: true` to `~/.claude.json`. After `stop_environment` and `start_environment` both keys were gone and the offer was back. This answers 0020 task 4.

**Decisions.**

- **Fix it, and where?**
  - **Set `.hasSeenAutoDefaultNudge = true` in the entrypoint's filtered, fallback and minimal configs, like `bypassPermissionsModeAccepted`, and pin it in `tests/unit/container-claude-settings.test.ts` (recommended).**
    - Pros: one place, every container path; the key is the one Claude Code 2.1.314 writes itself, and the repository already depends on it through the allowlist.
    - Cons: the name is Claude Code's internal state, so a future release can rename it; the existing allowlist has the same exposure.
  - **Keep answering the offer in the spec and accept it for users.**
    - Pros: no image change.
    - Cons: a dialog in every Claude CLI tab after each start, and a spec that depends on a dialog.

## Current state

Both tasks were done on 2026-11-06 on beelink (rootful Docker Engine 29.9.2,
Claude Code 2.1.314), on branch `container-shell-cleanup-9caa78b55d24-r1`
from `main` at `ee2cc8423`, against an isolated credential-free profile
(`tlc-7081`, `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, headless, Docker
through `apps/desktop/scripts/dev/docker-qualification-bin`) whose image was
built from that checkout. No container-to-host traffic, login or provider turn
was needed.

Evidence for task 1:

- Before the fix, reproduced again with the backend's own launch (a
  `docker exec -it` PTY running `CONTAINER_INTERACTIVE_SHELL_COMMAND` in a
  throwaway container of an existing dev image, `--network none`): after the
  PTY was killed, `zsh -l` and `sleep 4321` (in its own process group) were
  both still running. The new close script then ended both and removed the
  record. The same held for a background job (`sleep 4321 &`) and for an
  `orkroot` shell.
- `e2e/agent-testing/container-terminal-close.spec.ts` (new, in
  `test:agent:docker`): `create_terminal_session`, `start_terminal_session`,
  `sleep 4321`, then `detach_terminal`; it finds the shell by its session ID
  and asserts that nothing in that session is left in the container and that
  its PID record is gone. It passed 4 of its first 6 single-file runs; both
  failures were in rendering the app before any terminal command ran, and the
  second one's trace holds `net::ERR_NETWORK_CHANGED` (flake case 2340,
  environmental). The spec now signs in without rendering the app and passed
  6 of 6 after that.
- A real **Claude CLI** tab, opened from the renderer's context menu after a
  container start, with the image's `claude` on a fixture Messages API (no
  login): before close the tab's session held `zsh` and `claude`; after
  `detach_terminal`, `claude` was gone in about 0.4 s and nothing of the
  session remained. `container-claude-terminal-signal.spec.ts` now asserts the
  same in its cleanup. That spec itself was not run here: on this host it
  stops at its signal-confirmed precondition ([7080](7080-linux-host-firewall-blocks-profile-signals.md)).

Evidence for task 2:

- The profile's container, started from the image built from this checkout,
  had `hasSeenAutoDefaultNudge: true` in `~/.claude.json` (the minimal path,
  no host file).
- After a container restart, the **Claude CLI** tab above rendered its input
  box with "bypass permissions on" and no "Make auto mode your default
  permission mode?" offer (screenshot taken; not committed).
- Pinned by `tests/unit/container-claude-settings.test.ts` (the filter and
  both written configs) and by
  `apps/backend/src/core/claude-container-config.test.ts`, which runs the
  entrypoint block with `jq` on a host file that lacks the key and on no host
  file.

## Assumptions and decisions

### Task 1: where the record lives and who signals

Chose `/tmp/orkestrator-terminals-<uid>/<token>.pid`, a mode-700 directory per
uid that a shell uses only when it is a real directory it owns, and a close
exec run as the terminal's own user. Root in the container has no
`CAP_SYS_PTRACE`, so it cannot read another uid's `/proc/<pid>/environ` and
could not verify the PID anyway; running as the terminal's user also means the
close can signal only what that user could. A per-uid directory keeps a root
shell from writing through a directory `node` planted (checked live: a
`node`-owned `/tmp/orkestrator-terminals-0` is skipped). `/run/orkestrator`
was not used because it is `node`'s, which a root terminal must not write
through.

### Task 1: what is signalled

Chose SIGHUP to the recorded shell's process group plus every process whose
environment carries the PTY's token, with no SIGKILL escalation. zsh puts each
job in its own process group (observed: the shell's group held only `zsh`), so
the group alone misses the jobs, and a shell configured not to forward HUP
would leave them. HUP is what a closed terminal sends, so `nohup` programs
survive as they would on a real terminal. A process that clears its
environment or calls `setsid` with a new environment is not found.

### Task 1: when it runs

Chose every time a recorded container PTY goes away, not only on an explicit
close: a superseded stable tab, a reaped orphan and a client that died on its
own all leave the shell running otherwise. The token is per PTY lifetime, so a
late close can never signal the replacement shell of a stable tab. The closer
is injected by the backend outside `NODE_ENV=test`, like the other
Docker-backed runtime hooks, so unit tests never run `docker`; shutdown aborts
closes in flight.

### Task 1: sweeping stale records

Each shell start removes its uid's records whose PID no longer carries the
record's token (a shell that exited, or one from before a restart), and the
entrypoint removes `node`'s directory at every container start. Root's
directory is swept only by the next root shell, because the entrypoint runs as
`node`.

### Task 2: the key

Set `.hasSeenAutoDefaultNudge = true` in the entrypoint's filter, its fallback
and its minimal config, as the to-do recommended. `hasResetAutoModeOptInForDefaultOffer`,
which Claude Code also writes on answering, was not added: with the first key
alone the offer did not appear after a restart.

## Related

- to-do 7521 (retired on 2026-11-10; see [container-lifecycle.md](../../architecture/container-lifecycle.md#terminal-close)) (a backend that exits never closes its container terminals, so their shells outlive it).
- [0020-container-state-observation.md](0020-container-state-observation.md) (task 4, where the offer was first noted).
- [7080-linux-host-firewall-blocks-profile-signals.md](7080-linux-host-firewall-blocks-profile-signals.md) (the run that found both).

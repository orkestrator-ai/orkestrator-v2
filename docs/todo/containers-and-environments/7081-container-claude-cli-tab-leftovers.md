# Container terminals outlive their tab, and the auto-mode offer returns on every start

## Task analysis

Analysed 2026-11-06 against `main` at `e6c3da899`, on beelink (rootful
Docker Engine 29.9.2), image `orkestrator-v2:dev-0de0f31b9b02`, Claude Code
2.1.314, while running [0020](0020-container-state-observation.md) tasks 2–4.
Neither finding is specific to Linux.

### Tasks

1. **Closing a container terminal leaves its processes running**: stop the in-container shell and everything under it when a container terminal is closed. Status: open.
2. **Record the auto-mode answer in the image**: stop terminal Claude asking "Make auto mode your default permission mode?" on every container start. Status: open.

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

## Related

- [0020-container-state-observation.md](0020-container-state-observation.md) (task 4, where the offer was first noted).
- [7080-linux-host-firewall-blocks-profile-signals.md](7080-linux-host-firewall-blocks-profile-signals.md) (the run that found both).

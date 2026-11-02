# A failed Claude turn in a container terminal stays "working"

Found on 2026-11-01 while finishing
[1060](1060-non-native-activity-bell-reads-as-finished.md) task 2.

## Task analysis

Analysed 2026-11-01 against `main` at `0658de64`, from reading the code plus a probe of Claude Code 2.1.310 in print mode against a fake API; nothing here ran in a container. Re-checked 2026-11-02 against `main` at `38d55ee1`: the description still held (only `UserPromptSubmit` and `Stop` were installed, and the script accepted only `working` and `waiting`). Task 1 was acted on that day, and its image proof was made a committed test after the branch was rebased onto `main` at `ae7131f9`. The branch was rebased again onto `main` at `381b26f9` (which had changed `tmux-poll.ts` and `docker/entrypoint.sh`, with no conflict) and the image proof repeated there.

### Tasks

1. **Report a failed turn from the container hooks**: a Claude CLI tab whose turn ends on an API error reads `working` until the next prompt. Status: done (2026-11-02). `claude-terminal-failed-turn-docker.test.ts` proves it in a locally built image, with the real Claude CLI against a fake API; a real provider error in the UI is still owed (see Needs verification).

### 1. Report a failed turn from the container hooks

**Problem.** When a turn in a container's Claude CLI tab ends on an API error (a refused login, a rate limit), the sidebar keeps showing it as working and no bell rings.

**Context.** `docker/entrypoint.sh` installs only `UserPromptSubmit` and `Stop` hooks, and `docker/orkestrator-state-signal.sh` accepts only `working` and `waiting`. `StopFailure` runs instead of `Stop` on an API error, so nothing moves the state on from `working`. A `claude-tmux` tab in a container now handles `StopFailure` itself (1060), but it loads the same user settings, so the `claude-terminal` source stays `working` there too and keeps the aggregate `working`.

**Investigation.** The 1060 probe confirmed `StopFailure` fires with no `Stop`. Not checked: a real container, or how an older installed signal script treats a new state. It should exit 0 on an unknown argument, which would leave today's behaviour.

**Decisions.**

- **How does the hook report it?**
  - **A `StopFailure` hook calling `orkestrator-state-signal failed`, read by `tmux-poll.ts` as idle plus `agent_failed` (recommended).**
    - Pros: honest; the snapshot's revision counter already makes a missed failure visible.
    - Cons: a new state word, a capability bump to 3 and an image rebuild; an older backend reads `failed` as an unreadable state.
  - **A `StopFailure` hook calling `orkestrator-state-signal waiting`.**
    - Pros: no format change; it clears the stuck state at once.
    - Cons: the bell says "needs your input" for a failure, and the completion counter would count a failed turn as finished.

## Assumptions and decisions

Made 2026-11-02 against `main` at `38d55ee1`.

### Task 1: how the hook reports it

- **Chose:** the recommended option. `docker/entrypoint.sh` installs a `StopFailure` hook calling `orkestrator-state-signal failed`, guarded by `ORKESTRATOR_NATIVE_AGENT_BRIDGE` like the other two. The script declares `claude-state-signal=3`.
- **Why:** it says what happened. A `waiting` hook would make the bell say "needs your input" and count the failure as a completion.

### Task 1: what `failed` writes

- **Chose:** the snapshot gets `failed <revision> <completions>`. The revision goes up and the completion count does not. The legacy `/tmp/.claude-state` gets `idle`.
- **Why:** the revision change is how a missed failure shows up. Leaving the completion count alone stops a failure being read as a finished turn. An older backend reads the legacy file only when there is no snapshot, and `idle` is the closest word it knows. A later `working` accepts `failed` as the previous state.

### Task 1: how the poll reads it

- **Chose:** `parseClaudeStateSnapshot` returns `failed` as `{ state: "idle", failed: true }`, and the poll persists that observation with `completionOutcome: "failed"`. Storage then rings `agent_failed` on the `claude-terminal` source's own working edge (`failedEnd`), the path 1060 added for workflows. The renderer frame says `idle`.
- **Why:** this reuses the existing bell instead of adding a parallel one. The persisted working source also covers a failure that happened while the backend was down, which the first read after a restart picks up.
- **Also chose:** when the poll never saw the working edge (both rings lost while the previous read was `waiting` or `idle`), a changed revision with `failed` records `recordEnvironmentSessionCompletion(..., "agent_failed")`, as a recovered completion does for `Stop`. A cold start (no previous read) is left to storage's persisted source.

### Task 1: compatibility

- **Older images (version 2):** no change. They have no `StopFailure` hook, so a failed turn still reads `working` until the next prompt there. The backend still arms the doorbell from version 2, because a version 2 snapshot is still fully readable. Rebuilding the image picks up the fix.
- **Older backends with a version 3 image:** they read `failed …` as an unreadable state. After three reads they mark the source stale, keep the previous state and stay on the one-second poll until the next prompt. The file accepted this cost.
- **An older script given `failed`:** it exits 0 and writes nothing (checked against the `38d55ee1` script). No container mixes the two, because the script and the entrypoint come from the same image.

### Task 1: proof in a built image

- Built `orkestrator-v2:dev-94747542e191` from this branch with `mise run docker:build:dev --profile failed-turn-1200`. Its manifest declares `claude-state-signal=3`.
- In a container of that image, with `~/.claude/settings.json` taken from the image's own entrypoint, Claude Code 2.1.314 ran `claude -p` against a fake API inside the container (`ANTHROPIC_BASE_URL` on loopback, a fake key, `CLAUDE_CODE_MAX_RETRIES=0`). No provider was called.
  - A 401 answer left the snapshot at `failed 2 0` and the legacy file at `idle`. The real `ClaudeStatePollManager`, reading through `docker exec`, emitted `working` then `idle`, and real storage recorded the `claude-terminal` source as `idle` with `unreadReason: "agent_failed"`.
  - A streamed successful reply left `waiting 2 1`, and the same poll emitted `working` then `waiting` with `unreadReason: "agent_waiting"`, as before.
- The same proof is now a committed test, `apps/backend/tests/claude-terminal-failed-turn-docker.test.ts`, skipped without `ORKESTRATOR_TEST_STATE_SIGNAL_IMAGE` like the other live signal tests and run by the Linux Engine workflow (`container-live-qualification.yml`). It takes the hooks from the image's own `/usr/local/bin/entrypoint.sh`, checks the manifest declares `claude-state-signal=3`, holds each fake API answer until the plain one-second poll (real `docker exec` reads, real storage) has seen `working`, then checks a refused turn ends `failed 2 0` / `idle` with `agent_failed` and a normal turn ends `waiting 4 1` / `waiting` with `agent_waiting`. It needs no route from the container to the host.
  - Passed on beelink against `orkestrator-v2:dev-94747542e191`, rebuilt from the rebased branch (`mise run docker:build:dev --profile failed-turn-1200`), in about 4 s.
  - Negative control: the same image with `main`'s `entrypoint.sh` and `orkestrator-state-signal.sh` copied over (a throwaway tag, removed afterwards). There the refused turn left `working 1 0` / `working`, and the test failed.
  - Repeated after the rebase onto `381b26f9`: the image was rebuilt the same way (same tag, now carrying `main`'s user-skill staging too), and the test passed (1 pass, 15 assertions, about 2.3 s). The negative control was repeated on a throwaway `orkestrator-v2:dev-negctl1200-4eee6264` with `381b26f9`'s two scripts, removed afterwards: the committed test fails at its check that the image installs `StopFailure`, and an uncommitted copy without that check timed out waiting for the source to leave `working` after the refused turn.
- The doorbell test (`claude-state-signal-docker.test.ts`) now drives `StopFailure` too. On beelink it times out before any of the new steps, because a container there cannot reach a host port at all (a plain `curl` to a host listener times out). It needs a host where containers reach the backend, as the Linux Engine CI workflow has.

### Task 1: an image test that does not need the host

- **Chose:** a separate live test file that reads through `docker exec`, rather than relying only on the `StopFailure` step added to the doorbell test.
- **Why:** the doorbell test needs the container to reach the backend, which beelink's containers cannot, so on this host the image proof existed only as prose. The new test runs anywhere Docker runs, and drives the real Claude CLI rather than calling the hook command by hand. The doorbell test keeps its `StopFailure` step for the ring path on hosts that have it.

## Needs verification

- A real provider error (a refused login or a rate limit) in a container **Claude CLI** tab of a disposable `dev:test` profile: the sidebar leaves `working` and the `agent_failed` toast appears.
- `apps/backend/tests/claude-state-signal-docker.test.ts` against this branch's image on a host where containers reach the backend (the Linux Engine qualification workflow).

## Related

- [1060-non-native-activity-bell-reads-as-finished.md](1060-non-native-activity-bell-reads-as-finished.md)

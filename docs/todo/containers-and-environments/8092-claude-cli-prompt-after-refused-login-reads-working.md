# A Claude CLI prompt after a refused login leaves the tab reading working

## Task analysis

Analysed 2026-11-14 against `main` at `dc90609bf`.

### Tasks

1. **Settle a terminal Claude prompt the CLI refuses locally**: after a refused login, the next prompt in the same Claude CLI tab rings `working` and nothing ever rings it back. Status: open.

### 1. Settle a terminal Claude prompt the CLI refuses locally

**Problem.** In a container **Claude CLI** tab, a turn refused for its key
ends correctly: the CLI retries the 401 ten times (about three minutes), then
the image's `StopFailure` hook rings `failed`, the sidebar leaves working and
the environment rings "Agent stopped with an error". But the CLI then
considers itself signed out. The next prompt typed in the same session runs
the `UserPromptSubmit` hook, which rings `working`, and the CLI answers
"Not logged in · Please run /login" locally, without a model request and
without firing `Stop` or `StopFailure`. Nothing rings the state back, so the
backend and the sidebar read `working` until some later hook fires (the next
prompt after a fixed login). Closing the tab does not clear it: the
container's state file stays `working`, and the next run of the spec on the
same container found the environment still working before its first turn.

**Context.** Container terminal Claude reports its state only through the
hooks the image installs (`docker/entrypoint.sh`: `UserPromptSubmit`, `Stop`,
`StopFailure`) and `orkestrator-state-signal`; the backend reads the state
file with the poll in `apps/backend/src/core/tmux-poll.ts`
(`ClaudeStatePollManager`) and has no ceiling on how long `working` may last.
The host `claude-tmux` path reads the same hooks (`tmux-hooks.ts`) and is
probably affected the same way; not observed.

**Investigation.** Seen on beelink on 2026-11-14 (to-do 5160 task 4) with
`container-claude-terminal-signal.spec.ts` and
`ORKESTRATOR_AGENT_TEST_CLAUDE_TERMINAL_FAILED_TURN=1`, on a
`--no-agent-credentials` profile on a `docker:disposable --host-loopback`
daemon, image `orkestrator-v2:dev-5f4767c83385` built from this checkout.
The image's real `claude` talked to `container-fake-claude-api.ts` on the
container's loopback, which refuses a prompt carrying `REFUSE_QA_401` with
Anthropic's 401. Recorded in two runs: the refused turn left `working`
179.4 s and 186.5 s after Enter and rang `agent_failed`; 15 s after the CLI
printed "Not logged in" for the next prompt, the backend state and the
sidebar both read `working` (the spec records this as a known gap, not a
failure). After the tab was closed, `/tmp/.claude-state` still read
`working`.
A probe with `claude -p` in the same container showed the state file at
`working` throughout the retries and `failed` only when the CLI gave up
(179 s). Whether a real Anthropic key refusal behaves the same was not
checked (it needs a real request to Anthropic).

**Decisions.**

- **How to settle a prompt the CLI refuses without a hook?**
  - **Bound `working` for terminal Claude: when the state file has read `working` with no transcript growth for a while after a `failed` ring in the same session, read the tab's screen for the CLI's sign-in notice and settle it `idle` with `agent_failed`; and settle the source when the tab's Claude process exits (recommended).**
    - Pros: fixes the observed case without a CLI change; the notice is the CLI's own fixed text, so the check is narrow.
    - Cons: reads terminal output, which must stay out of logs and metrics; a CLI wording change silently disables it, so it needs a canary test against the pinned CLI.
  - **Ask for, or wait for, a CLI hook on a locally refused prompt.**
    - Pros: no screen reading; the same shape as `StopFailure`.
    - Cons: not in Orkestrator's control; nothing changes until a CLI release adds it.
  - **Leave it.**
    - Pros: no work; the user has to sign in again anyway.
    - Cons: the sidebar keeps saying the agent is working when it is not, which is the silent failure the bell work set out to remove.

## Related

- [5160](../cross-cutting/5160-silent-failures-live-evidence.md) task 4, where this was found.
- [0020](0020-container-state-observation.md), the container Claude state signal.

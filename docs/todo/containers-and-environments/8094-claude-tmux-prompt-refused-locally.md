# A claude-tmux prompt the CLI refuses locally may leave the tab reading working

## Task analysis

Analysed 2026-11-16 against `main` at `c1fcc573b`.

### Tasks

1. **Find out whether a claude-tmux tab reads working after a locally refused prompt, and settle it if so**: the container Claude CLI tab was fixed by 8092 (retired); the host and container claude-tmux tabs read their own hooks and were never observed in this state. Status: open.

### 1. Find out whether a claude-tmux tab reads working after a locally refused prompt, and settle it if so

**Problem.** After a refused login the Claude CLI answers the next prompt
"Not logged in · Please run /login" locally, with no model request and no
`Stop` or `StopFailure` hook (seen in a container **Claude CLI** tab on
2026-11-14, to-do 5160 task 4). For a container Claude CLI tab the backend
now settles that prompt from the CLI's notice (8092, retired; the
"Turns no hook ends" part of
[container-lifecycle.md](../../architecture/container-lifecycle.md#turns-no-hook-ends)).
A **claude-tmux** tab reports its turns through a different path, and may
read working in the same situation until the next hook.

**Context.** claude-tmux tabs install their own `UserPromptSubmit`, `Stop` and
`StopFailure` hooks (`apps/backend/src/core/tmux-hooks.ts`), which drop
pending files the tab's poll loop drains
(`apps/backend/src/core/tmux-session-manager.ts`); activity is persisted as
the `claude-tmux` source by `TmuxRuntime.persistEnvironmentActivity`
(`tmux-runtime.ts`). The loop already captures the pane for prompt and usage
observations (`parseTmuxAgentObservation`), so the screen is available
without new execs. The container settle's notice matcher and quiet rule
(`normalizeTerminalText`, `containsSignInNotice`,
`CLAUDE_SIGN_IN_NOTICE_QUIET_MS` in `claude-terminal-settle.ts`) can be
reused.

**Investigation.** Not observed. On the host, with the pinned CLI 2.1.319
against a loopback fake Messages API that refuses with 401 (2026-11-16, while
working 8092), the follow-up prompt did not refuse locally: the CLI sent it,
retried the 401 for about three minutes and `StopFailure` fired. The local
refusal seen in the container may depend on how that CLI was signed in, so a
reproduction needs the same credential shape as the container run (a fixture
`ANTHROPIC_AUTH_TOKEN` in `~/.claude/settings.json`, no host login), in a
claude-tmux tab of an isolated `dev:test` profile with no billed request.

**Decisions.**

- **How to settle a locally refused claude-tmux prompt, if it reads working?**
  - **Reuse the container settle's matcher on the pane the loop already captures: notice present after the working edge, pane unchanged for the quiet window, then persist `idle` with `completionOutcome: "failed"` for the `claude-tmux` source (recommended).**
    - Pros: no new exec and no image change; the same fixed-text rule and canary test as the container path.
    - Cons: claude-tmux keeps its state in the backend rather than in a file, so a settle there does not survive a backend restart the way the container rewrite does.
  - **Leave it until a CLI release fires a hook for a locally refused prompt.**
    - Pros: no screen reading.
    - Cons: not in Orkestrator's control.

## Related

- 5160 (retired) task 4 ([failed-turn bell](../../development/agent-testing.md#failed-turn-bell-refused-login-model)), where the container case was found.
- [0020](0020-container-state-observation.md), the container Claude state signal.

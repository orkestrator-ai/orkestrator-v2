# A failed Claude turn in a container terminal stays "working"

Found on 2026-11-01 while finishing
[1060](1060-non-native-activity-bell-reads-as-finished.md) task 2.

## Task analysis

Analysed 2026-11-01 against `main` at `0658de64`, from reading the code plus a probe of Claude Code 2.1.310 in print mode against a fake API; nothing here ran in a container.

### Tasks

1. **Report a failed turn from the container hooks**: a Claude CLI tab whose turn ends on an API error reads `working` until the next prompt. Status: open.

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

## Related

- [1060-non-native-activity-bell-reads-as-finished.md](1060-non-native-activity-bell-reads-as-finished.md)

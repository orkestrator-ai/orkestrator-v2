# A failed agent turn is announced as "The agent completed its work."

Found on 2026-10-29 while qualifying
[0235](../agent-engines/0235-codex-refused-login-turn-invisible.md) in profile
`qa-0235b`. A Codex turn refused with a 401 raised the toast "Agent finished:
refused-login-…: The agent completed its work." while the tab showed the error.

## Task analysis

Analysed 2026-10-29 against `main` at `79f3bc97`.

### Tasks

1. **Give a failed turn its own unread reason**: record and show a failure, not "completed its work". Status: open.
2. **Check every platform reports a failed turn the same way**: Status: open (depends on 1).

### 1. Give a failed turn its own unread reason

**Problem.** When a turn fails (a refused login, a provider error, a restart mid-turn), the environment is marked unread with `agent_finished`. The toast then says "The agent completed its work." That is wrong, and it sends the user to a tab expecting an answer.

**Context.** `EnvironmentUnreadReason` (`apps/backend/src/core/models.ts:243`, `apps/web/src/types/index.ts:89`) has `agent_finished`, `agent_ready`, `agent_waiting`, `agent_question`, `terminal_finished` and `marked_unread`; nothing for a failure. The copy is in `apps/web/src/components/environments/environmentUnreadToast.tsx:10-35`.

**Investigation.** The reason is chosen from the session's activity state, not from how the turn ended. `native-agent-launch-activity-reconciler.ts:1121-1132` treats any `working → idle` edge as a completion and records `agent_waiting` or `agent_finished`. `storage-projects.ts:1405` makes the same choice for the aggregate. A failed turn goes `working → idle` (or `error`, read as idle) like a successful one. Not checked yet: whether every provider's activity snapshot says the turn failed (`turn.phase: "error"`, a session `error`). The Codex bridge does (`phase: "failed"`).

**Decisions.**

- **How is a failure reported?**
  - **Add an `agent_failed` unread reason, set when the turn's terminal state is an error, with copy such as "Agent stopped with an error" (recommended).**
    - Pros: honest; it works with the existing unread, toast and sidebar paths; old clients fall back to `UNKNOWN_REASON_COPY` ("New activity"), which is still not wrong.
    - Cons: a new value in a persisted enum, so the storage, CLI and mobile readers that switch on it must accept it.
  - **Keep `agent_finished` but make the copy neutral ("The agent stopped").**
    - Pros: no protocol change.
    - Cons: the user still cannot tell a failure from an answer before opening the tab.
- **What counts as failed?**
  - **The provider's terminal error for the turn (session `error` or `turn.phase: "error"`), not a stop the user asked for (recommended).**
    - Pros: matches the tab's error row (`native-terminal:error:`).
    - Cons: needs the reconciler to read the turn outcome as well as the activity state.
  - **Any turn with an error notice.**
    - Pros: simpler.
    - Cons: notices outlive turns, so a later good turn could be reported as failed.

### 2. Check every platform reports a failed turn the same way

**Problem.** Task 1 only helps where the activity snapshot carries the failure.

**Context.** Bridge platforms report session state differently: Claude, Codex, Cursor, Grok and Pi over HTTP; OpenCode through its SDK.

**Investigation.** Not started.

**Decisions.**

- **How is it checked?**
  - **A backend test per platform that drives a failed turn through the reconciler and asserts the reason (recommended).**
    - Pros: cheap; the provider stubs in `native-agent-service-projection-test-support.ts` already model a failed turn per platform.
    - Cons: proves the stub, not each real provider.
  - **A live failed turn per provider.**
    - Pros: real evidence.
    - Cons: six live runs for a label.

## Related

- [0235-codex-refused-login-turn-invisible.md](../agent-engines/0235-codex-refused-login-turn-invisible.md)

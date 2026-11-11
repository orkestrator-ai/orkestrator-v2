# A `session start` turn records no usage until something refreshes the session

## Task analysis

Analysed 2026-11-11 against `main` at `14df96544`.

### Tasks

1. **Record a CLI-started turn's usage without waiting for a later dispatch or an open tab**: usage history undercounts sessions that only the CLI drives. Status: open.

### 1. Record a CLI-started turn's usage without waiting for a later dispatch or an open tab

**Problem.** The usage panes and the CLI scenario manifest (0014 task 4) undercount a session driven only through the CLI. On 2026-11-11 a fake-model Pi turn started with `orkestrator session start --wait` reached the model and ended, and the backend's `get_usage_history` report still counted 0 turns after a transcript read, `session config get`, `session get` and `session commands`. Only the next `session prompt --wait` made the report count both turns. A scripted user who starts one session per task and never opens its tab would see none of that usage in the usage panes.

**Context.** The backend records usage in one place: `refreshProjectionOnce` in `apps/backend/src/core/native-agent-transcript-projection.ts` hands the provider's per-turn usage to `UsageHistoryRecorder.observe`, which writes it to the `usage-history` store. The desktop tab reads projections continuously, so a session the user watches is counted; the CLI reads transcripts and state through the progressive views (`get_native_agent_transcript_update`, `get_native_agent_session_state_update`), which evidently do not reach that call. Found by 0014's task 4 run ([0014](0014-cli-qualification.md), "Evidence log", 2026-11-11). `live-session` ends with prompts, so its manifest count is whole; a scenario whose last turn is a `session start` would under-report.

**Investigation.** Observed once, on Pi with a loopback fake model (2 turns, 123 prompt and 45 completion tokens each; the report counted 0, then 2 turns, 246 input and 90 output tokens after the follow-up). Not traced in code: which step of the follow-up records both turns (the dispatch's own projection refresh before sending, or a refresh after it settles), and whether Claude, Codex and OpenCode behave the same. Start by checking which public session actions call `refreshProjection` (`native-agent-service.ts`, `native-agent-session-operations.ts`) and whether the progressive state and transcript views read `contextUsage` without observing it. A deterministic reproduction can use `native-agent-service-usage-recording.test.ts`'s provider stub: create a session with a first prompt, finish the turn, then read only the progressive views.

**Decisions.**

- **Where should a finished turn's usage be recorded?**
  - **Observe usage wherever the backend already reads the provider's snapshot, including the progressive state and transcript views (recommended).**
    - Pros: every reader counts, whichever client drives the session; the recorder already de-duplicates by turn id, so extra observations cost a set lookup.
    - Cons: touches the progressive read path, which is performance-sensitive; it must stay non-blocking (`observe` already is).
  - **Refresh the projection once when a run settles (the run observer or the dispatch journal's settle), whoever started it.**
    - Pros: one place, tied to the moment a turn ends.
    - Cons: an extra provider read per turn; a turn that ends while no observer is attached (the client exited) would still be missed until the next read.
  - **Leave it, and document that usage counts turns the backend has read.**
    - Pros: no change.
    - Cons: CLI-only and scripted sessions stay undercounted in the usage panes, which users rely on for cost.

## Related

- [0014-cli-qualification.md](0014-cli-qualification.md) task 4: the manifest usage record that found this.
- `apps/backend/src/core/usage-history-recorder.ts`, `apps/backend/src/core/usage-history-store.ts`.

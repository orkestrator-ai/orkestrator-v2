# The Claude revision-token live spec fails on a background command's output

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`.

### Tasks

1. **Find out why the launching tool row has no final output**: the opt-in spec stops at its first case on `main`. Status: open.

### 1. Find out why the launching tool row has no final output

**Problem.** `e2e/agent-testing/claude-revision-tokens-live.spec.ts` fails with "Conditional launching tool row lacks the final background output" (`expectTaskOutput`, `claude-revision-token-reader.ts`), about 85 s in, so neither of its inactive-view cases finishes. The spec is the repository's check that a Claude tab misses no update while off screen, so that check currently proves nothing.

**Context.** Found during E8 (agent tab polling, [1202 task 4](../cross-cutting/1202-efficiency-review-follow-ups.md)), which did not cause it: the spec fails the same way with E8's polling code taken out, on a `dev:test` profile with `--credential-source claude` (Claude Code 2.1.314). The spec is opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_REVISION_TOKENS=1`), so no default suite shows this. E8 added an inactive-environment case to `agent-tab-requests-live.spec.ts`, which passes but only covers a foreground turn; it does not replace background task coverage.

**Investigation.** The failing read comes from the spec's own reader, which calls the backend's transcript command and `get_native_agent_tool_details` directly, so the renderer's read round is not involved. The check accepts the row when its detail output contains the command's output or the task's summary. Not established: whether the row never receives the final output, whether its output sits behind a detail reference that resolves to the launch placeholder, or whether Claude Code changed what a background Bash notification carries. The last reading is plausible because the check was written against an earlier Claude Code, but nothing here confirms it.

**Decisions.**

- **Where to start?**
  - **Run the spec once with the reader logging the row's content-free shape: tool state, whether a detail reference exists, and output length before and after the notification (recommended).**
    - Pros: separates a missing update from a changed notification in one run; stays content-free.
    - Cons: one more real Claude turn on host credentials.
  - **Relax the check to accept any settled row.**
    - Pros: the spec passes straight away.
    - Cons: it would stop catching the bug the check exists for, a launch placeholder that is never replaced.

## Related

- [1202 task 4](../cross-cutting/1202-efficiency-review-follow-ups.md)
- [0049 native agent idle observation](0049-native-agent-idle-observation.md)

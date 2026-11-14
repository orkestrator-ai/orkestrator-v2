# The Claude revision-token live spec fails on a background command's output

## Task analysis

Analysed 2026-11-14 against `main` at `dc90609bf` (first analysed 2026-11-04 at `e198fd4a7`).

### Tasks

1. **Find out why the launching tool row has no final output**: the opt-in spec stops at its first case on `main`. The content-free shape logging in the spec's reader is done (2026-11-14); the diagnosis and fix follow the real-Claude run on the manual-test checklist. Status: open (depends on 7568: 5040 task 1).

### 1. Find out why the launching tool row has no final output

**Problem.** `e2e/agent-testing/claude-revision-tokens-live.spec.ts` fails with "Conditional launching tool row lacks the final background output" (`expectTaskOutput`, `claude-revision-token-reader.ts`), about 85 s in, so neither of its inactive-view cases finishes. The spec is the repository's check that a Claude tab misses no update while off screen, so that check currently proves nothing.

**Context.** Found during E8 (agent tab polling, to-do 1202 task 4 (retired 2026-11-10)), which did not cause it: the spec fails the same way with E8's polling code taken out, on a `dev:test` profile with `--credential-source claude` (Claude Code 2.1.314). The spec is opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_REVISION_TOKENS=1`), so no default suite shows this. E8 added an inactive-environment case to `agent-tab-requests-live.spec.ts`, which passes but only covers a foreground turn; it does not replace background task coverage.

**Investigation.** The failing read comes from the spec's own reader, which calls the backend's transcript command and `get_native_agent_tool_details` directly, so the renderer's read round is not involved. The check accepts the row when its detail output contains the command's output or the task's summary. Not established: whether the row never receives the final output, whether its output sits behind a detail reference that resolves to the launch placeholder, or whether Claude Code changed what a background Bash notification carries. The last reading is plausible because the check was written against an earlier Claude Code, but nothing here confirms it.

Since 2026-11-14 the reader records each background task's launching row every time its shape changes (`launchRowShapes` in `claude-revision-token-reader.ts`), and the spec writes that history with the final comparison to `results.json` as the `inactive-tab-launch-row` and `inactive-environment-launch-row` annotations, whether the check passes or not. Each shape gives the task's status and the turn phase at that read, whether the row exists, its tool name and state, whether it has a detail reference and how many distinct references it has carried, and the length of its output (inline, or behind the reference, resolved once per reference) and of the task's summary. The final comparison adds whether the output contained the command's output or the summary. Read them as follows:

| What the shapes show after the task reads `completed` | Reads as |
| --- | --- |
| `detailRefs` never grows and `outputLength` stays at the launch placeholder's length | The row never received the final output: a missed update. |
| `detailRefs` grows but `outputLength` stays the same | The new reference resolves to the launch placeholder. |
| `outputLength` grows, but the comparison has `containsOutput` and `containsSummary` both false | The notification arrived but carries something else: a changed Claude Code notification. |

The reader's own unit tests cover the recording (`tests/unit/claude-revision-token-reader.test.ts`, "content-free launching row shape (5040)"); the real-Claude run that produces evidence is the checklist item.

**Decisions.**

- **Where to start?**
  - **Make the reader log the row's content-free shape: tool state, whether a detail reference exists, and output length before and after the notification, then run the spec once (recommended).**
    - Pros: separates a missing update from a changed notification in one run; stays content-free.
    - Cons: one more real Claude turn on host credentials; that run is on the manual-test checklist (7568), the logging is agent work.
  - **Relax the check to accept any settled row.**
    - Pros: the spec passes straight away.
    - Cons: it would stop catching the bug the check exists for, a launch placeholder that is never replaced.

## Assumptions and decisions

### Task 1: shape history in the reader, written through the spec's annotations

Chose the recommended option, logging only; the check is unchanged.

- **Shapes are recorded on every read, not only when the check runs.** The ticket asked for the output length before and after the notification, and only the reader sees the row before the task completes. A shape is stored only when it differs from that task's previous one, so a settled session adds nothing.
- **A detail reference is resolved once, for its length.** References are content-addressed, so a new one is the only way the output behind it can change. Resolving through `get_native_agent_tool_details` does not touch the conditional transcript or state tokens the spec qualifies. A failed resolution is recorded as an unreadable length (`null`) and never fails a read.
- **The evidence goes out as Playwright annotations.** The spec's measurements already travel that way, and its header promises that prompts and transcript text never reach test output. Tasks are numbered in the order the reader saw them; no task id, tool id, detail reference, output or summary text is kept, only lengths and booleans. The history is capped at 200 shapes (extra changes are counted as `droppedShapes`) and 32 resolved references per row.
- **The annotation is written in a `finally`,** so a failing check still leaves its evidence, which is the case this task needs.

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 1: running the spec with a real Claude login) moved there on 2026-11-10.
- to-do 1202 task 4 (retired 2026-11-10)
- 0049 native agent idle observation (retired 2026-11-11; `git show 498b68766:docs/todo/transcripts-and-observation/0049-native-agent-idle-observation.md`)

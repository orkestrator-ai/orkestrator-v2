# Transcript reads: live evidence left from E9

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`, plus the E9 build. The E9 batch file is deleted; read it as built from with `git show 69a3b4ca5:docs/reports/efficiency-logging-database/0110-e9-transcript-reads.md`, or with its outcome table at `1fcae2160`.

### Tasks

1. **Live bytes per prompt send and per turn check**: measure what a real bridge sends for each, before and after E9. From part 0150, task 1 ("Capture the baseline"). Status: open.
2. **How many Claude sessions reach large `/messages` bodies**: find the real share. From part 0150, "Needs verification". Status: open.
3. **How often a tool-detail miss happens**: count evicted references users expand. From part 0110, "Needs verification". Status: open.

### 1. Live bytes per prompt send and per turn check

**Problem.** The maintainer gated the structural transcript work on numbers (1202 task 1, decided 2026-11-01). E9 took its baseline with fakes, because a real figure needs a real provider turn, which the build could not run.

**Context.** Part 0150, task 1, asked for bridge read bytes per prompt send before any change. E9 recorded a fixture baseline on `69a3b4ca5`, in `apps/backend/src/core/native-agent-transcript-read-bytes.test.ts`: a provider fake over 400 rows of about 8 KB (3,292,561 bytes), counting the JSON each read returns. The method for live numbers is 1202 task 1's: the same measurement on two commits in an isolated `dev:test` profile.

**Investigation.** Fixture figures, before (`69a3b4ca5`) and after E9:

| Read | Before | After |
| --- | --- | --- |
| Prompt send (the dropped post-dispatch refresh) | 1 raw read, 33 rows, 271,676 bytes | Unchanged (0150 task 3 landed on 2026-11-04) |
| Turn check (a one-message projection) | 1 raw read, 2 rows, 16,466 bytes | 0 transcript bytes: one state read |
| Evicted remote tool detail | 1 raw read, 400 rows, 3,292,561 bytes, and the expansion failed | 0 raw bytes; one 8,017-byte detail read; recovered |
| `/messages` fallback keeping 100 rows | 3,292,610 bytes received | 823,299 bytes received |

The fake counts row JSON, not the HTTP envelope, compression or the bridge's own work. Nothing was measured against a real bridge.

**Decisions.**

- **How to get live numbers?**
  - **Run 1202 task 1's method for these reads in one pass with the other transcript batches (recommended).**
    - Pros: one profile run covers E9, E10 and E26; both commits are known.
    - Cons: needs a real provider turn, which is billed, so it waits for someone who may run one.
  - **Treat the fixture figures as enough.**
    - Pros: no billed turn.
    - Cons: a fake cannot show what a real bridge's envelope, compression or row sizes cost.

### 2. How many Claude sessions reach large `/messages` bodies

**Problem.** Part 0150 asked for the real share of Claude sessions whose `/messages` bodies are large. Nobody has measured it.

**Context.** Part 0200 now passes the limit to the `/messages` fallback, which stays until the support window passes a Claude bridge that loads sessions on `/transcript` ([version compatibility](../../architecture/version-compatibility.md#register), `bridge-transcript.messages-fallback`). The share says how much the fallback still costs until then.

**Investigation.** Not measured. The fallback is counted (`bridge-transcript.messages-fallback`), but body sizes are not.

**Decisions.**

- **How to measure it?**
  - **Read the fallback counter and the bridge's rollout sizes on a machine that uses Claude daily (recommended).**
    - Pros: no code; a real workload.
    - Cons: one user's sessions.
  - **Add a content-free body-size bucket to the fallback counter.**
    - Pros: lasting and exact.
    - Cons: a new metric for a path that is being retired.

### 3. How often a tool-detail miss happens

**Problem.** Part 0110 traced the miss in code; nobody has seen one live, so how often users reach the "no longer available" message is unknown.

**Context.** E9 made a miss on a remote reference recover from the row cache, the direct page cache or one summary read, and ask for a reload only when the row is held nowhere (`recoverRemoteToolDetails` in `native-agent-transcript-projection.ts`). The detail cache holds 4,096 entries or 64 MiB, so a miss needs a long session or many open sessions.

**Investigation.** Covered by tests in `native-agent-service-summary-transcripts.test.ts` ("after eviction"). No live miss was observed.

**Decisions.**

- **How to find out?**
  - **Watch for the reload message during a long multi-session day on a `dev:test` profile with a small detail cache (recommended).**
    - Pros: shows the path a user sees, with no new code.
    - Cons: needs real turns to build a long session.
  - **Add a content-free counter of misses by outcome.**
    - Pros: a lasting rate.
    - Cons: a new metric for a path that is now cheap.

## Current state

E9 is built: turn checks read session state only, an evicted remote detail is recovered without a raw read, and the `/messages` fallback asks for only the rows it keeps. Only the live evidence above is left.

## Related

- [1202 efficiency follow-ups](../cross-cutting/1202-efficiency-review-follow-ups.md), tasks 1 and 5
- [Efficiency report, B](../../reports/2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-2, TX-8, TX-15, TX-18)
- [Efficiency index, closing check of E9](../../reports/efficiency-logging-database/0000-index.md#closing-check-of-e9-transcript-reads)

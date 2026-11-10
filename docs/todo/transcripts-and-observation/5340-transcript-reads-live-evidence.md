# Transcript reads: live evidence left from E9

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`, plus the E9 build. The E9 batch file is deleted; read it as built from with `git show 69a3b4ca5:docs/reports/efficiency-logging-database/0110-e9-transcript-reads.md`, or with its outcome table at `1fcae2160`.

### Tasks

1. **Live bytes per prompt send and per turn check**: measure what a real bridge sends for each, before and after E9, with a loopback model on an isolated `dev:test` profile (no billed turn). From part 0150, task 1 ("Capture the baseline"). Status: open.

### 1. Live bytes per prompt send and per turn check

**Problem.** The maintainer gated the structural transcript work on numbers (1202 task 1, decided 2026-11-01). E9 took its baseline with fakes. A real bridge's envelope and compression can be measured without a billed turn; real row sizes need a real provider turn, which is on the manual-test checklist (7568: 5340 task 1).

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
  - **Run 1202 task 1's method for these reads with the loopback-model profile spec of [6680](6680-conditional-reads-and-deltas-measured.md) task 1 (`e2e/agent-testing/conditional-reads-live.spec.ts`), on both commits (recommended).**
    - Pros: the profile's own renderer, gateway, backend, bridge and CLI, with no billed turn; both commits are known.
    - Cons: the fake model's rows and filler text are not a real turn's sizes or compressibility; a billed real-provider run for those is on the manual-test checklist (7568: 5340 task 1).
  - **Run 1202 task 1's method on a real provider turn.**
    - Pros: one profile run covers E9, E10 and E26 with real rows.
    - Cons: billed, so it needs someone allowed to run one (manual-test checklist).
  - **Treat the fixture figures as enough.**
    - Pros: no billed turn.
    - Cons: a fake cannot show what a real bridge's envelope, compression or row sizes cost.

## Current state

E9 is built: turn checks read session state only, an evicted remote detail is recovered without a raw read, and the `/messages` fallback asks for only the rows it keeps. Only the loopback-model figures above are left here; the real-workload readings are on the manual-test checklist (7568).

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 1: a billed real-provider run; task 2, the share of large `/messages` bodies on a machine that uses Claude daily; task 3, how often a tool-detail miss happens in real use) moved there on 2026-11-10.
- to-do 1202 efficiency follow-ups, tasks 1 and 5 (retired 2026-11-10)
- Efficiency report, B (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`) (TX-2, TX-8, TX-15, TX-18)
- Efficiency outcome, closing check of E9 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`)

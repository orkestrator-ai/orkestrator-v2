# Transcript reads: live evidence left from E9

## Task analysis

Analysed 2026-11-05 against `main` at `69a3b4ca5`, plus the E9 build. Task 1 measured 2026-11-13 against `main` at `17d28238c`. The E9 batch file is deleted; read it as built from with `git show 69a3b4ca5:docs/reports/efficiency-logging-database/0110-e9-transcript-reads.md`, or with its outcome table at `1fcae2160`.

### Tasks

1. **Live bytes per prompt send and per turn check**: measure what a real bridge sends for each, before and after E9, with a loopback model on an isolated `dev:test` profile (no billed turn). From part 0150, task 1 ("Capture the baseline"). Status: done (2026-11-13, see Assumptions and decisions).

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
  - **Run 1202 task 1's method for these reads with the loopback-model profile spec from 6680 (retired 2026-11-11) task 1 (`e2e/agent-testing/conditional-reads-live.spec.ts`, [Live conditional reads](../../development/agent-testing.md#live-conditional-reads-loopback-models)), on both commits (recommended).**
    - Pros: the profile's own renderer, gateway, backend, bridge and CLI, with no billed turn; both commits are known.
    - Cons: the fake model's rows and filler text are not a real turn's sizes or compressibility; a billed real-provider run for those is on the manual-test checklist (7568: 5340 task 1).
  - **Run 1202 task 1's method on a real provider turn.**
    - Pros: one profile run covers E9, E10 and E26 with real rows.
    - Cons: billed, so it needs someone allowed to run one (manual-test checklist).
  - **Treat the fixture figures as enough.**
    - Pros: no billed turn.
    - Cons: a fake cannot show what a real bridge's envelope, compression or row sizes cost.

**Live figures (2026-11-13).** `e2e/agent-testing/transcript-read-bytes-live.spec.ts` on `17d28238c`: the profile's real Claude bridge and pinned Claude CLI 2.1.319, sent to the loopback model `fake-anthropic-model.ts`, with `conditional-reads-bridge-counter.ts` counting every bridge answer by route. No page rendered the session, so every read is the backend's own. Six streamed history turns (80 fixture lines each) came first. Bytes are response bodies as the bridge wrote them (none was compressed on this loopback hop), without HTTP headers; the backend's own timers (the activity sweep, `POST /sessions/activity`, and the change-evidence poll) are counted apart.

| Read (live, real Claude bridge) | Windows | Bridge requests | Bytes (mean, range) | Transcript bytes | Background timers in the window |
| --- | --- | --- | --- | --- | --- |
| Prompt send: `dispatch_native_agent_intent`, model parks the call, 6 s window | 5 | 11.4 | 18,569 (11,276 to 28,719) | 502 (one `/messages?limit` tail read, 330 to 1,184 bytes) | 2,731 |
| Turn check now: `get_native_agent_session_state_update` | 10 | 4.6 | 3,727 (3,683 to 3,988) | 0 | 0 |
| Turn check before E9: one-message projection (`get_native_agent_projection`, `messageLimit: 1`) | 10 | 6.7 | 7,406 (5,572 to 23,757) | 1,189 | 0 |
| Idle, no command, 10 s | 1 | 0 | 0 | 0 | 2,325 |
| A parked running turn, no command, 6 s | 5 | 0 | 0 | 0 | 2,193 |

Per prompt send the bridge answered one `POST /session/:id/prompt` (117 bytes), two `GET /session/:id` (3.6 to 5 KB each, growing with the session), the bounded tail read above, `/mcp` (700 bytes), the questions, plan-approval, interaction and human-prompt lists (under 100 bytes each), and on two of five sends the 18,152-byte command catalogue (`/commands`) together with `/init`: the catalogue is re-read when a new CLI query bumps its revision. Without those two, a send is 11 to 13 KB. A turn check is one state read (`GET /session/:id`, about 3.6 KB) plus three empty interaction lists, and no transcript row. The pre-E9 path still costs a row read and a `/mcp` read on every call. Dispatch answered in 63 to 94 ms and the model held the call 169 to 203 ms after it was sent. The run took 160 s:

```bash
ORKESTRATOR_HOST_REACHABILITY_CHECK=off mise run dev:test --profile b5340qa --fixture --headless \
  --no-agent-credentials --no-host-seed --agent-platforms claude
ORKESTRATOR_HOST_REACHABILITY_CHECK=off ORKESTRATOR_AGENT_TEST_PROFILE=b5340qa \
  ORKESTRATOR_AGENT_TEST_RUN_ID=b5340qa ORKESTRATOR_AGENT_TEST_E9_READS=1 \
  mise run test:logged -- --name e9-reads -- bunx playwright test \
  --config e2e/agent-testing/playwright.browser.config.ts transcript-read-bytes-live.spec.ts --workers=1
```

## Current state

E9 is built: turn checks read session state only, an evicted remote detail is recovered without a raw read, and the `/messages` fallback asks for only the rows it keeps. The loopback-model figures are measured (above); the real-workload readings are on the manual-test checklist (7568). No agent work is left, so this file is retired.

## Assumptions and decisions

### Task 1: a spec of its own rather than another conditional-reads scenario

Chose a new opt-in spec, `transcript-read-bytes-live.spec.ts`, that reuses the conditional-reads bridge counter and the shared loopback Anthropic model. The conditional-reads spec measures a streaming tab with viewers; these reads are the backend's own, so the new spec sends commands through `/invoke` with no rendered page and parks the model call with `[hold:<id>]`, which keeps streaming and viewer polling out of the prompt-send window. A scenario inside the conditional-reads spec would have shared its viewer setup, which is exactly what has to be absent here.

### Task 1: "before E9" measured through the old command on today's commit

The live "before" turn check is the one-message projection the turn checks called before E9, which still exists, measured beside today's state read on the same commit and session. A second profile on `69a3b4ca5` was not run: that commit has neither this spec nor E9's changes to compare against beyond what the fixture baseline already records, and the decision the figures gate (1202 task 1) needs the post-E9 cost of a real bridge, now measured. The pre-E9 prompt-send refresh no longer exists in code, so its "before" stays the fixture figure. Real row sizes need a billed turn, which stays on the manual-test checklist (7568).

### Task 1: background timers counted apart

The activity sweep and the change-evidence poll run every few seconds whatever a client does, and fell into most prompt-send windows. They are reported in their own column (and measured alone in the idle and running background windows) so a figure says what the command cost.

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 1: a billed real-provider run; task 2, the share of large `/messages` bodies on a machine that uses Claude daily; task 3, how often a tool-detail miss happens in real use) moved there on 2026-11-10.
- to-do 1202 efficiency follow-ups, tasks 1 and 5 (retired 2026-11-10)
- Efficiency report, B (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`) (TX-2, TX-8, TX-15, TX-18)
- Efficiency outcome, closing check of E9 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`)

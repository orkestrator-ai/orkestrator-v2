# 04 — Control terminal and native-session timer tests

Status: Partially implemented; remaining waits retained after review. Depends
on: [03](03-settings-autosave-time.md).

## Implementation result

The ActionBar long-press suppression case now advances Bun's clock through its
15 ms press delay and 1,000 ms suppression window. Two native-agent polling
cases invoke the captured production interval callback and await the resulting
read, removing 3.3 seconds of literal sleeps; their two-file run fell from
23.07 to 19.3 seconds. The terminal bootstrap cancellation case controls its
300 ms retry and proves an advanced cancelled callback cannot reconnect after
unmount. The rest of the terminal/native waits are retained because they mix
multiple timer families, event delivery and negative assertion windows; a
generic fake clock would weaken or destabilize those contracts. The full
ActionBar and terminal files passed, although their whole-file timings varied
enough that no additional measured speedup is claimed.

## Goal

Remove artificial waiting in the next expensive UI owners while preserving the
distinction between UI cleanup and durable background work. Reuse lessons from
the settings conversion, not necessarily the same helper: these components own
different timers, external events and asynchronous resources.

## Initial targets

| File | Review duration | Identified artificial work |
| --- | ---: | --- |
| `apps/web/src/components/terminal/PersistentTerminal.test.tsx` | 22.09 s | 15 literal waits totaling 8.26 s; bootstrap retries and negative assertions |
| `apps/web/src/components/native-agent/AgentNativeTab.test.tsx` | 15.33 s | Repeated 120 ms event waits; 1,700 ms polling-cycle wait |
| `apps/web/src/components/layout/ActionBar.test.tsx` | 17.43 s | A 1,025 ms wait alongside already controlled timer cases |
| `apps/web/src/components/native-agent/AgentNativeTab.progressive.test.tsx` | 7.74 s | Review only waits whose lifecycle can be driven explicitly |

Inspect `useNativeAgentSession.ts`, related progressive hook tests, terminal
bootstrap/redraw helpers and the existing `interceptDisconnectedNoticeTimer`
before adding any new interception code.

## Tasks

### 1. Classify every targeted wait

- [ ] For each literal delay, record its test name, purpose, triggering event,
  actual production timer, expected completion signal and cleanup owner.
- [ ] Separate debounce/retry/deadline behavior from real I/O readiness. A
  resolved mock/deferred request should be awaited directly; a retry deadline
  should be advanced; a real process should expose a bounded readiness signal.
- [ ] Leave waits outside the reviewed families unchanged until evidence shows
  they are material. Avoid repository-wide sleep replacement.

### 2. PersistentTerminal

- [ ] Convert bootstrap success/retry cases to explicitly advance each retry
  boundary. Assert no early duplicate bootstrap, the correct retry budget and
  the final launch warning on exhaustion.
- [ ] Convert `cancels a scheduled bootstrap retry when the terminal unmounts`
  so it waits for the first real attempt, unmounts, advances past the retry
  deadline and verifies no second attempt. Do not weaken it to an immediate
  assertion made before the retry could possibly run.
- [ ] Keep session-replacement cases driven by deferred results. A completion
  for the old terminal must not mark the replacement bootstrapped or write to it.
- [ ] Preserve redraw, resize and disconnect-notice ordering. Use the existing
  narrow timer controller where it is sufficient; do not stack two unrelated
  global timer overrides on the same case.
- [ ] Keep backend terminal/session lifetime assertions separate from component
  timer cleanup. UI unmount is not authority to stop a live backend terminal.

### 3. AgentNativeTab and progressive state

- [ ] Drive resource events, advance their debounce and resolve the authoritative
  projection request in that order. Assert which request occurred and the
  visible result; advancing time alone is not evidence of reconciliation.
- [ ] Rewrite the creation-failure persistence case to advance one complete
  poll cycle explicitly, return the same missing-session result, and verify the
  actionable error and Retry control remain.
- [ ] Preserve inactive-tab cases: no inappropriate liveness touch while
  inactive, background work continues, and reactivation reconciles from a
  snapshot rather than requiring every live event to have been observed.
- [ ] Preserve stale generation/session response rejection, subscription
  teardown, remount recovery and pending interaction rehydration.
- [ ] For negative request assertions, establish that the relevant event queue
  or timer cycle has drained. Do not replace a 25 ms wait with an assertion
  immediately following render unless the path is proven synchronous.

### 4. ActionBar and common cleanup

- [ ] Identify the exact action guarded by the 1,025 ms delay and advance its
  production grace period using the existing timer technique in that file.
- [ ] Keep deadline-before/deadline-after and user action cancellation checks.
- [ ] Restore timers, Date overrides, mock implementations, subscriptions,
  terminal callbacks and pending deferred promises on every exit path.
- [ ] Limit shared helpers to concrete lifecycle operations. Do not build a
  generic `flushEverything()` that hides which background work completed.

## Validation

Run these as separate logged commands so file duration and failure evidence
remain attributable. For example:

```bash
mise run test:logged -- --name streamlining-terminal -- \
  bun test --cwd apps/web ./src/components/terminal/PersistentTerminal.test.tsx \
  --parallel=1 --only-failures

mise run test:logged -- --name streamlining-native-tab -- \
  bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.test.tsx \
  ./src/components/native-agent/AgentNativeTab.progressive.test.tsx \
  --parallel=1 --only-failures

mise run test:logged -- --name streamlining-action-bar -- \
  bun test --cwd apps/web ./src/components/layout/ActionBar.test.tsx \
  --parallel=1 --only-failures
```

Then run the affected hook/terminal helper suites and default validation under
the normal worker plan. Retain the existing browser/agent inactive-environment
checks when changed test seams reach real user-facing lifecycle code. A pure
test-clock edit does not by itself require a new application profile.

## Completion and rollback

- [ ] Each removed wait has an explicit deterministic replacement and retained
  positive or negative assertion.
- [ ] No production timing constant, retry count or background lifetime changed.
- [ ] Focused durations fall; unchanged timing/case families remain documented.
- [ ] No new timer leakage, hanging async queries or aggregate-only failures.

Separate terminal, native-session and action-bar conversions into independent
commits. If a timer mechanism conflicts with real I/O, keep that case's bounded
real wait until a faithful replacement exists rather than weakening the test.

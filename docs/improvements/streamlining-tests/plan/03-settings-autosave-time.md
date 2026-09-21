# 03 — Replace settings autosave sleeps with controlled time

Status: Implemented; pending review and integration. Depends on:
[01](01-baseline-and-coverage-inventory.md).

## Implementation result

A small test helper controls one specifically requested timeout while leaving
Testing Library, network and unrelated component timers on real time. Both
settings suites use it for the 400 ms autosave boundary. Coverage now explicitly
proves no early save, one due save, in-flight edit handling and one unmount
flush with no later callback write. The focused settings run passed in 5.1
seconds, compared with 42.4 seconds in the review measurement.

## Goal and scope

Keep the settings behavioral suite while removing repeated 450 ms waits.
The review measured 32.23 seconds for `GlobalSettings.test.tsx` and 10.13
seconds for `GlobalSettingsDefaults.test.tsx`. About 25.2 and 7.2 seconds,
respectively, are represented by active literal helper call sites before
loop expansion. The exact savings must be measured after conversion.

Primary files:

- [Root GlobalSettings tests](../../../../tests/unit/components/GlobalSettings.test.tsx)
- [Defaults tests](../../../../tests/unit/components/GlobalSettingsDefaults.test.tsx)
- [Production GlobalSettings](../../../../apps/web/src/components/settings/GlobalSettings.tsx)
- [Existing helper tests](../../../../apps/web/src/components/settings/GlobalSettings.test.ts)

Do not change the production `AUTO_SAVE_DEBOUNCE_MS` value, currently 400 ms.
Do not move all settings tests to a new framework or restructure the component
as a prerequisite for controlling its clock.

## Behavioral contract

| Situation | Required assertion after conversion |
| --- | --- |
| Valid edit | No save before 400 ms; exactly one save at the due boundary |
| Sustained edits | Timer re-arms; final normalized value is saved once |
| Unchanged/normalized-equivalent value | No redundant save after later timer cycles |
| Edit while persistence is in flight | Late response cannot discard the newer edit; newer value is eventually saved |
| Persistence rejection | Failed signature does not retry indefinitely; a changed edit can retry |
| Credential propagation failure | Preserve its separate existing retry/toast contract |
| Store update unrelated to draft | Preserve unsaved user fields and avoid spurious writes |
| Validation blocker | Invalid core edit is not persisted; actionable blocker remains |
| Credential blur/save | Preserve the immediate credential path; do not incorrectly debounce it |
| Form unmount with valid pending edit | Flush once immediately; cancelled debounce must not write again |
| Unmount with blocked/failed/in-flight edit | Preserve the current guard behavior without extra writes |

The unmount behavior is an explicit refinement of the review: the form flushes
pending edits. Only the scheduled timer is cancelled; the edit is not discarded.

## Tasks

### 1. Prove clock control on a small slice

- [ ] Verify the pinned Bun timer API and existing `ActionBar` timer patterns.
  Keep module mocks file-scoped; vary stable mock functions rather than
  replacing the component/backend module graph per test.
- [ ] Install the controlled clock before rendering the component or creating
  timers relevant to the case. Keep clock setup independent of import-time
  environment changes.
- [ ] Convert one ordinary save case, the sustained edit-burst case and one
  rejected-save case before migrating the rest of the files.
- [ ] Advance time inside the appropriate React `act` boundary and explicitly
  settle the promises triggered by that advance. Avoid an unbounded
  run-all-timers operation: retries and periodic UI work can re-arm themselves.
- [ ] Confirm how Testing Library's async queries behave with this clock. Do
  not replace the real sleep with an async query that secretly waits the same
  wall time or deadlocks because its polling clock cannot advance.

### 2. Convert the ordinary save matrix

- [ ] Replace `flushAutoSave()` with a named operation that advances one
  debounce interval and settles resulting state updates. Share the helper
  between the two suites only if it remains small and does not own hidden
  store resets or assertions.
- [ ] Preserve each existing input and saved-payload assertion. A helper must
  not itself call persistence or replace the real effect.
- [ ] Use exact before/at-boundary checks in the dedicated debounce tests;
  other field-specific tests can advance one known interval without repeating
  that boundary matrix for every field.
- [ ] Rewrite the two 200 ms pauses in the edit-burst case as controlled
  advances, checking no intermediate persistence occurred.
- [ ] Keep deferred promises explicit for in-flight saves and external store
  updates so a completed timer is not confused with a completed request.

### 3. Handle exceptional lifetime paths

- [ ] Unmount explicitly in the unmount case and assert one flush before
  advancing past the old debounce deadline. Assert the write count stays one.
- [ ] During teardown, unmount while the test's mocks and clock still exist,
  settle expected cleanup promises, clear owned timers, then restore real time
  and reset state. Test teardown must not accidentally save into the next case.
- [ ] Restore real timers and temporary global overrides even on assertion
  failure. Do not call global run-all-timers to clean up a retry loop.
- [ ] Leave the already skipped persistent-propagation case visibly tracked.
  Its 14 helper calls are not a current speed saving. Re-enabling or changing
  that case is separate bug work, with its original intent preserved.

## Validation

```bash
mise run test:logged -- --name streamlining-settings -- \
  bun test ./tests/unit/components/GlobalSettings.test.tsx \
  ./tests/unit/components/GlobalSettingsDefaults.test.tsx \
  --parallel=1 --only-failures
```

Compare the same files, worker count and warm conditions before and after.
Run the two files in normal aggregate isolation as well, since successful
focused clock tests do not prove there is no leaked global timer state.
Keep the production helper suite and relevant repository-settings suite in
the changed-code check.

Use a temporary wrong debounce boundary or disabled unmount flush to verify
that the dedicated timing/lifetime tests fail for the intended reason. This
is a targeted verification exercise, not a new permanent mutation framework.

## Completion and rollback

- [ ] Ordinary autosave coverage contains no real 450 ms waits.
- [ ] All matrix rows above retain an identifiable test owner.
- [ ] Active test coverage is unchanged, apart from any separately explained
  assertion grouping; the skipped case is not counted as removed runtime.
- [ ] Both settings files show a repeatable reduction in execution time without
  new act warnings, unhandled rejections, pending timers or order dependence.
- [ ] The default suite and required static checks retain their assurance.

Land the clock helper and small slice first if reviewability warrants it, then
the mechanical conversions. Revert a problematic family independently; do not
change the production debounce to compensate.

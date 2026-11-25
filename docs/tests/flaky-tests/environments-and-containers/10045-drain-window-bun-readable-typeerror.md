# Copy drain window: an uncaught TypeError inside Bun's readable streams

- **ID:** 10045
- **Status:** resolved
- **Date observed:** 2026-11-23
- **Base:** `a7d21c3f5` (`main`, CI run 45238054215, job 137915138079
  `Tests (root-bridges)`).
- **Test:** `the drain window against the real copy helper > the helper's work
  after its input ends fits well inside the default window`
  (`tests/unit/migrate-copy-drain-window.test.ts`).
- **Failure:** after 711.22 ms, `TypeError: undefined is not an object
  (evaluating 'n')` at `howMuchToRead (internal:streams/readable:310)`, called
  from `flow` and `resume_`. The stack holds no repository frame. The failing
  expression is `state.buffer[state.bufferIndex].length`, with a non-zero
  `state.length`.
- **Original command:** the CI `Tests (root-bridges)` shard of the complete
  non-iOS suite, Bun 1.4.4.
- **Isolated rerun:** the runner's lone rerun of the file passed (25.5 s).

## Investigation (2026-11-24)

The streams in that test are the child processes' pipes in
`pipeContainerPath` (`apps/backend/src/core/containers/replacement.ts`), which
reads `producer.stdout` with both a `data` listener and `pipe`. The same error
in the backend would be an uncaught exception during a container rebuild.

Not reproduced on beelink2 (16 CPUs). Under
`scripts/test-under-contention.ts --burners 4` the test did not finish within
the 200 s given to it, three times, so those runs say nothing. Uncontended,
`bun test tests/unit/migrate-copy-drain-window.test.ts --rerun-each=25` passed
(25 pass, 0 fail, 448.9 s).

## Hypothesis (unproven)

A Bun runtime defect in the paused/flowing transition of a `Readable` whose
buffer was emptied in between. Nothing in the repository's code is on the
stack. No code was changed for it.

## Next evidence

A second occurrence, with its Bun version. If it recurs, replace the `data`
listener plus `pipe` pair with one consumer that counts and writes.

## Recurrence found (2026-11-20)

CI run 44728684540 (`main`), job `Tests (root-bridges)`, failed the same test
after 555 ms with `RangeError: Range consisting of offset and length are out of
bounds` in `fromList` (`internal:streams/readable:850`), again from `flow` and
`resume_`.

## Resolution (2026-11-25)

- **Root cause:** a Bun 1.4.4 defect. When a flowing child `stdout` is paused
  and resumed under backpressure, its `Readable` loses count of its own buffer
  and throws where no caller can catch it. `pipeContainerPath`
  (`apps/backend/src/core/containers/replacement.ts`) drove the archive that
  way, so the same exception could end the backend during a container rebuild.
- **Fix:** the pump reads the archive with `for await` and waits for the
  helper's `drain` itself. Once the helper is gone it still reads to the end, so
  the producer is seen to close. `container-replacement.test.ts` gains a case
  that checks every byte reaches a slow helper.
- **Reproduced:** yes, at base `2478cf993`, with the unchanged owning file run
  in fresh processes pinned to two cores each
  (`taskset -c 2,3 bun test ./tests/unit/migrate-copy-drain-window.test.ts`,
  four or six pairs at once): 10 of 32, 3 of 30 and 9 of 30 runs failed. Every failure
  seen locally was the `RangeError`. Comparing readers in a temporary build of the pump under
  the same condition: `data` plus `pipe` failed 12 of 156 runs, `pipe` alone 3 of
  24, a `data` listener with `pause`/`resume` 2 of 24; `for await` 0 of 90 and
  `readable` with `read()` 0 of 90. Not reproduced by a script outside the test,
  so what inside Bun goes wrong is not established.
- **Stress:** the fixed pump passed 60 of 60 under the same condition;
  `bun test tests/container-replacement.test.ts` passed (63 tests).

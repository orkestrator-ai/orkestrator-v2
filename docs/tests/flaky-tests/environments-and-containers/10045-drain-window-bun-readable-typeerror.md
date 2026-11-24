# Copy drain window: an uncaught TypeError inside Bun's readable streams

- **ID:** 10045
- **Status:** open
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

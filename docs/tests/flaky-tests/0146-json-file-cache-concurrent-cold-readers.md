# JSON file cache concurrent cold readers

- **ID:** 0146
- **Status:** resolved
- **Date observed:** 2026-09-18
- **Test:** `json file cache > slices > shares a single parse between concurrent cold readers`
- **File:** `bridges/claude-bridge/src/services/json-file-cache.test.ts:151`
- **Original command:** `mise run test`
- **Worker configuration:** the aggregate bridge group ran package tasks in
  parallel; Claude bridge used Bun's package test runner.
- **Failure:** `getJsonFileParseCount(file)` expected `1` and received `3`
  after 1.30 ms. The Claude bridge owner reported 887 tests, one skipped and
  one failed.
- **Isolated rerun:** the original owner passed repeatedly in isolation, which
  made this a credible aggregate-only race rather than a deterministic cache
  correctness failure.

## Resolution (2026-09-18)

Cold slice readers registered only after their independent `stat` operations.
The first reader could finish parsing and remove the shared in-flight promise
before a slower reader's metadata request completed, so callers started in one
`Promise.all` could parse the same unchanged file three times.

Readers now join a per-file cohort synchronously, before their first filesystem
await. The parsed document stays transient, but its settled promise remains
available until every overlapping reader leaves the cohort. A deterministic
regression delays two metadata reads until the first parse has completed, the
owner passed 1,300 cases under 100 repetitions, and all 888 Claude bridge tests
passed.

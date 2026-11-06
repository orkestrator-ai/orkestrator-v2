# ACP trim-to-notice chunk lands in one part

- **ID:** 2410
- **Status:** resolved
- **Test:** `ACP bridge > starts a new part when a chunk follows a message trimmed to its notice`
- **File:** `bridges/acp-bridge/src/acp-transcript.test.ts:2691` (was `:3347`)

On 2026-11-01, GitHub Actions CI run 41359051447 (`mise run test:full`, head
`bf5964511`, the bridges group) failed `expect(assistant.parts).toHaveLength(2)`
with a received length of 1, after 415.56 ms. The same test passed in the three
other CI runs examined that day (41358751023, 41360552300, 41360672784), none of
which changed `bridges/acp-bridge`.

The complete unchanged owner passed alone on `fix-pr-ci-c5bff78410b8-r1` (based on
`4626c4d7a`) in 20.8 s, and the single test passed three times in a row by name:

```sh
mise run test:logged -- --name acp-transcript-owner -- bun test --cwd bridges/acp-bridge ./src/acp-transcript.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures
```

Hypothesis, not established: the test waits only for `status === "idle"`, so the
snapshot may have been read before the trailing "Recovered summary." chunk was
applied as its own part. This establishes intermittency; it does not establish
the cause. No bridge source, assertion, timeout or skip changed.

## CI recurrences (2026-11-03)

Failed in the `Tests (root-bridges)` shard on `main` at
[`0bd2cea99`](https://github.com/orkestrator-ai/orkestrator-v2/actions/runs/41735714522/job/126264255616)
and `b7f41b692` (306.56 ms), with the same 1 part instead of 2 at
`acp-transcript.test.ts:3347`. The owning file passed alone on 2026-11-04
(`bun test --cwd bridges/acp-bridge ./src/acp-transcript.test.ts --parallel=1 --only-failures`,
exit zero, 22.3 s). The cause remains unconfirmed.

## Root cause and fix (2026-11-06)

Recurred in `mise run test:full` on beelink during to-do 0190 task 3
(branch `linux-reviewer-56224b1498be-r1`, the bridges group, 779.97 ms, the
same 1 part instead of 2).

- **Root cause:** the test waited by polling `GET /session/:id`, and every such
  read runs `boundTranscriptForRead`, which calls `boundTranscript` and resets
  the write path's dirty counter (`uncheckedTranscriptBytes`). The write path
  bounds only once that counter reaches `TRANSCRIPT_CHECK_INTERVAL_BYTES`
  (1 MiB), which here equals the lowered budget. When a poll landed between
  `bulk-0` and `bulk-1`, the second call left the counter near 606 KiB, so
  nothing trimmed during the turn. The assistant row still ended with a tool
  call, so the unidentified "Recovered summary." chunk opened a row of its own
  (the tool-call row boundary), and the read after the turn evicted the user
  prompt and the tool-call row, leaving that one-part row last. Without an
  interleaved read the counter crosses 1 MiB at `bulk-1`, the row trims to its
  notice, and the chunk joins it as the second part. The bridge behaves as
  designed in both orders; the assertion depended on which one the poll timing
  produced.
- **Reproduction:** with a temporary 500 ms `setTimeout` between the fixture's
  two `tool_call` writes (not committed), the previous test failed every time
  with `Expected length: 2, Received length: 1` (663.57 ms).
- **Fix:** the test waits on `GET /session/:id/activity`, which never bounds
  the transcript, then reads the session once. With the same 500 ms delay in
  place it passed. No bridge source, fixture or assertion changed.
- **Verification (2026-11-06, beelink):** the complete owner passed
  (`mise run test:logged -- --name acp-transcript-owner -- bun test --cwd bridges/acp-bridge ./src/acp-transcript.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`,
  11.3 s), and the single test passed 20 repetitions
  (`--rerun-each=20 -t 'trimmed to its notice'`, 2.9 s).

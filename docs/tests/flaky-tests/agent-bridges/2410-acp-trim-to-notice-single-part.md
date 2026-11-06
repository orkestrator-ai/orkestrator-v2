# ACP trim-to-notice chunk lands in one part

- **ID:** 2410
- **Status:** resolved
- **Test:** `ACP bridge > starts a new part when a chunk follows a message trimmed to its notice`
- **File:** `bridges/acp-bridge/src/acp-transcript.test.ts:3347`

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

### Resolution — 2026-11-06

**Root cause (test).** The aggregate bound that trims the message runs from
two places: the update path, once `uncheckedTranscriptBytes` reaches
`TRANSCRIPT_CHECK_INTERVAL_BYTES` (1 MiB), and every session read
(`boundTranscriptForRead`, which also resets that counter). The test waited
for idle by polling `GET /session/:id`. When a poll landed between the two
600 KiB tool updates (likely when a slow host splits those lines across event
loop turns), it reset the counter, so the second tool part did not reach the
threshold and no trim ran before the text chunk. The chunk then followed an
untrimmed tool call, which by design (`acp-rows.ts`) opens a new row. The final
read trimmed the earlier row away and left the last assistant message with the
chunk alone: one part. Product behaviour is correct in both orderings; the
scenario the test asserts needs the trim the agent's own updates trigger.

**Fix.** `bridges/acp-bridge/src/acp-transcript.test.ts` waits on
`/session/:id/activity` (which never bounds the transcript) for `idle`, then
reads the session once and asserts it is idle. No assertion was removed.

**Verification.**

- Reproduced before the fix: 4 of 40 repetitions failed with `Received length: 1`
  under three extra CPU-bound loops
  (`mise run test:logged -- --name br-2410-stress -- bun test --cwd bridges/acp-bridge --preload ../../tests/setup-node.ts ./src/acp-transcript.test.ts -t "starts a new part when a chunk follows a message trimmed" --rerun-each=40`, exit 1).
  A temporary 300 ms pause in the fake agent between the two tool updates
  made it fail every time (`br-2410-forced`, exit 1).
- With the fix: the forced-pause variant passed (`br-2410-forced-fixed`, exit 0;
  pause removed afterwards), and 60 repetitions under the same CPU load passed
  (`br-2410-stress-fixed`, exit 0).

The other trim cases in this file that wait by polling `GET /session/:id`
during a streaming turn could have the same ordering dependence; they were not
changed here.

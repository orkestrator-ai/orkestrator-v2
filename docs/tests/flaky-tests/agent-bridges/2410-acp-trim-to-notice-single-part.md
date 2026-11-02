# ACP trim-to-notice chunk lands in one part

- **ID:** 2410
- **Status:** open
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

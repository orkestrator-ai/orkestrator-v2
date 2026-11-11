# Mark the legacy projection read for the narrowed splice

## Task analysis

Analysed 2026-11-11 against `main` at `498b68766`, found while doing
7553 (retired 2026-11-11: the gateway's splice of marked transcript reads was
narrowed and measured; see Related).

### Tasks

1. **Mark `get_native_agent_projection` as spliced**: Status: open.

### 1. Mark `get_native_agent_projection` as spliced

**Problem.** The gateway serialises the legacy `get_native_agent_projection`
result with `JSON.stringify`, re-encoding every row of a whole-session
projection that was already encoded once to hash and size it. Since 7553
narrowed the splice, splicing that result measures cheaper than serialising
it, so the command pays for a second encoding of every row for no reason.

**Context.** 6860 (deleted 2026-11-10) left the command unmarked because the
first splice cost more there (about 600 µs against 450 to 500 µs CPU per read
on the 100-row, 430 KB window). With the splice 7553 put in place, the
changed-read benchmark measured 570 to 690 µs (`legacy-spliced`) against 740
to 820 µs (`legacy`) CPU per read on 2026-11-11, three alternating runs of
300 reads on beelink2 (Intel Core Ultra 9 285H, Bun 1.4.4) while other builds
shared the host. The figures and the method are in
[native-transcripts.md](../../architecture/native-transcripts.md#response-encoding).
Its callers are mostly in-process (Control MCP environment tools,
`control-mcp-nodes.ts`, `node-coordinator-remote.ts`) and the coordinator
live scripts; only calls that cross the gateway (a remote node, the CLI, the
renderer's legacy path) gain.

**Investigation.** Marking takes three edits: wrap the handler's result in
`markSpliceableResult` (`apps/backend/src/core/commands-registry-native.ts`),
flip its row in `commands-registry-native-splice.test.ts`, and set
`encoded: true` on `getNativeAgentProjectionCommand`
(`packages/protocol/src/contract/domains/native-sessions/commands-agent.ts`),
with its row in `native-sessions.test.ts` (`ENCODED`). `encoded: true` makes
`checkCommandResult` pass the result through unchecked in development and
tests (`packages/protocol/src/contract/command.ts`), so the projection's result
schema would no longer catch a drifting handler there. Whether the contract
manifest records `encoded` (and so needs regenerating) was not checked.

**Decisions.**

- **Mark it?**
  - **Mark it, with the contract flag, and re-run `legacy` against `legacy-spliced` first (recommended).**
    - Pros: about 100 to 200 µs less CPU per gateway read of a large projection; byte-identical output.
    - Cons: a `packages/protocol` change, which runs the full suite; the result schema check in development stops covering this command.
  - **Leave it unmarked.**
    - Pros: no contract change; the result stays schema-checked in development.
    - Cons: every gateway read of a large legacy projection keeps serialising its rows twice.

## Related

- 7553 (retired 2026-11-11, done): narrowed the gateway's splice so marked
  transcript reads encode faster than `JSON.stringify`; the figures are in
  [native-transcripts.md](../../architecture/native-transcripts.md#response-encoding).
- [6260](6260-projection-hashing-measurements.md): the E11 measurement that
  introduced the changed-read benchmark (`scripts/benchmark-transcript-changed-read.ts`).

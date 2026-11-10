# Gateway transcript splice is slower than `JSON.stringify` on large-row snapshots

## Task analysis

Analysed 2026-11-10 against `main` at `04639b12b`, found while measuring
6860 (whether to splice the legacy projection response, decided no; see
Related).

### Tasks

1. **Measure the splice on snapshot responses of the four marked transcript commands**: Status: open.
2. **Keep, narrow or remove the splice**: Status: open (depends on 1).

### 1. Measure the splice on snapshot responses of the four marked transcript commands

**Problem.** E11 part 0340 marked four transcript commands
(`get_native_agent_transcript_update`, `get_native_agent_live_update`,
`get_native_agent_projection_update`, `get_native_agent_message_page`) so the
gateway writes them with `spliceEncodedJson`, copying each row's memoised
JSON instead of serialising it again (`apps/backend/src/gateway-handlers.ts`,
`apps/backend/src/core/native-agent-projection-encoding.ts`). Measured while
deciding 6860, the splice is slower than `JSON.stringify` for a snapshot
whose rows are a few KiB each, which is the read a tab pays on open, reload
and every snapshot fallback.

**Context.** The gateway builds `{"result":<splice>}` and then calls
`Buffer.byteLength` on it for its metrics before writing it. Probe figures
(one process on beelink, Intel Core Ultra 9 285H, Bun 1.4.4, 2,000 runs after
200 warm-up, `Buffer.byteLength` of the body included, which is what the
gateway does), for each changed-read benchmark scenario's first snapshot:

| Scenario (`scripts/benchmark-transcript-changed-read.ts`) | `JSON.stringify` | Splice |
| --- | ---: | ---: |
| `tool-parts` (20 rows, 46 KB) | 27 µs | 22 µs |
| `revised` (100 rows, 242 KB) | 45 µs | 95 µs |
| `near-full` (100 rows, 423 KB) | 71 µs | 153 µs |
| `short-incomplete` (60 rows, 62 KB) | 30 µs | 29 µs |

Changed reads answer with small deltas, where the end-to-end benchmark shows
no measurable difference either way. For the legacy projection's 430 KB body
the same probe gave 69 µs against 162 µs, broken down as: the non-row fields
cost 39 µs walked in JavaScript against 7.6 µs natively, the rows cost 47 µs
copied from the memo against 61 µs serialised, and sizing the joined body
added about 45 µs because the concatenation is flattened again.

**Investigation.** Only probes so far: the figures above come from timing
`spliceEncodedJson` against `JSON.stringify` on each scenario's real first
snapshot, in a scratch copy of the benchmark. Not yet measured: the HTTP
write itself (whether Bun's response path flattens or encodes the body a
second time), and snapshot sizes from real sessions.

Steps:

1. Add a `--snapshot` mode to `scripts/benchmark-transcript-changed-read.ts`
   that times the first snapshot's encoding both ways, `Buffer.byteLength`
   included, for every progressive scenario.
2. Time the same through the gateway (`apps/backend/tests/gateway-test-harness.ts`)
   so the write is counted.
3. Record the figures here.

**Decisions.**

- **Where to measure?**
  - **The changed-read benchmark plus one gateway-harness run (recommended).**
    - Pros: same row shapes as E11's measurement; the gateway run counts the
      write the probe left out.
    - Cons: the row shapes are still fixtures.
  - **An isolated `dev:test` profile with a loopback model.**
    - Pros: real row shapes from a real bridge.
    - Cons: much slower to set up, and the encoding cost is a small share of
      a real read, so the signal is harder to see.

### 2. Keep, narrow or remove the splice

**Problem.** If task 1 confirms the probe, the splice adds latency to every
snapshot read it was meant to make cheaper.

**Context.** The splice was added to stop serialising each row a second time.
The row copy is still a small win; what loses is the walk over everything
else and the extra copy of the joined body.

**Investigation.** Not started; depends on task 1.

**Decisions.**

- **What to do?**
  - **Narrow it: serialise the result natively with each row array replaced
    by a placeholder, then put the joined memo encodings in place of the
    placeholder (recommended if task 1 shows the walk dominates).**
    - Pros: keeps the row win, drops the JavaScript walk; output stays
      byte-identical.
    - Cons: the placeholder must be one that no other field can produce, and
      the joined body is still copied once more when it is sized and written.
  - **Remove the splice and serialise with `JSON.stringify`.**
    - Pros: simplest; fastest in three of the four probes.
    - Cons: loses the small row win on many-small-part rows (`tool-parts`).
  - **Keep it as it is.**
    - Pros: no change.
    - Cons: snapshot reads of large rows pay up to twice the encoding time.

## Related

- 6860 (deleted 2026-11-10, done): decided not to splice the legacy
  `get_native_agent_projection`; the measurement is in
  [native-transcripts.md](../../architecture/native-transcripts.md#response-encoding).
- [6260](6260-projection-hashing-measurements.md): the E11 measurement that
  introduced the changed-read benchmark.

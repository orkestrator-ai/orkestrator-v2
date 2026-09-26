# 10 — Use one transcript cursor validation contract

Status: Planned.  
Depends on: [01](01-contract-baseline-and-regression-fixtures.md).  
Finding: INC-09.

## Target behavior

Equivalent `/messages?fromIndex=` routes accept the same safe, nonnegative
integer syntax and use the same authoritative fallback for invalid input.
Pi no longer truncates fractions or consumes numeric prefixes. A shared pure
parser prevents future drift between Pi, Cursor, and Grok's ACP bridge.

## Owners

- [Shared transcript utilities](../../../../packages/protocol/src/transcript-window.ts)
  and [tests](../../../../packages/protocol/src/transcript-window.test.ts).
- [Pi public projection](../../../../bridges/pi-bridge/src/public.ts) and
  [HTTP routes](../../../../bridges/pi-bridge/src/http.ts).
- [Cursor public projection](../../../../bridges/cursor-bridge/src/public.ts) and
  [HTTP routes](../../../../bridges/cursor-bridge/src/http.ts).
- [ACP public projection](../../../../bridges/acp-bridge/src/acp-public.ts) and
  [HTTP routes](../../../../bridges/acp-bridge/src/acp-http.ts).

Cursor and ACP currently use `Number` plus `Number.isSafeInteger`; Pi uses
`parseInt` plus `Number.isInteger`. Neither existing version should be copied
without deciding the treatment of alternate syntax such as exponent notation.

## Proposed normalized contract

Add a pure helper such as `parseTranscriptFromIndex(value: string | null)` to
the already exported `transcript-window` module. It returns `number | null`.

- Accept canonical decimal strings `0` or a nonzero decimal digit followed by
  decimal digits, with value no greater than `Number.MAX_SAFE_INTEGER`.
- Reject signs, fractional forms, exponent/hex syntax, suffixes, whitespace,
  leading zeros other than `0`, infinity, and unsafe integers.
- Missing or invalid input returns `null`, meaning the retained authoritative
  window is requested. Preserve this fallback instead of introducing a 400 that
  could make older clients unable to recover.
- Bound the input length before numeric conversion. Sixteen decimal digits are
  sufficient for safe integers; reject longer encodings without expensive work.
- Valid cursors older than the retained base return the retained window with
  its true absolute `baseIndex`. Valid cursors beyond the end follow the existing
  documented window contract; do not invent a new generation/cursor protocol.

This deliberately tightens alternate forms currently accepted by `Number`.
Before adopting it, inventory all actual emitters and fixtures. If supported
clients intentionally emit leading zeros or another form, document and implement
one shared compatible grammar instead of silently breaking those clients.

## Implementation tasks

- [ ] Search both renderer and backend consumers for construction of `fromIndex`
  query parameters. Record their output syntax and whether values can be strings
  supplied by persisted state or external callers.
- [ ] Implement the pure parser and exhaustive table-driven cases in protocol.
  No bridge types, filesystem access, or browser globals belong in this helper.
- [ ] Replace Pi, Cursor, and ACP implementations with the shared helper or thin
  compatibility exports while updating imports. Keep one parsing implementation.
- [ ] Preserve message-window math, retained indexes, revision/generation fields,
  and truncated/omitted metadata. This is input normalization, not a transcript
  pagination redesign.
- [ ] Audit Claude/Codex routes for the same literal parameter. Adopt the helper
  only where the semantics match; do not apply an integer parser to opaque
  replay cursors, SSE Last-Event-ID, or different transcript cursor types.
- [ ] Keep input validation bounded before allocating response work. Invalid
  input must select an already bounded retained window, not an unbounded full
  vendor transcript read.
- [ ] Reuse the existing package export. If an implementation instead adds a new
  export/metadata entry, follow the pinned-Bun lockfile workflow in AGENTS.md.

## Test matrix

| Input | Expected result under the proposed grammar |
| --- | --- |
| `null`, empty string | `null` |
| `0`, `1`, `123` | Corresponding integer |
| `9007199254740991` | Maximum safe integer |
| `9007199254740992`, `9007199254740993` | `null` |
| `12junk`, `1.5`, `1.0` | `null` |
| `-1`, `-0`, `+1` | `null` |
| `1e3`, `0x10`, `Infinity`, `NaN` | `null` |
| Leading/trailing whitespace, line break | `null` |
| `00`, `01` | `null`, subject to emitter compatibility audit |
| Very long digits or non-ASCII numeral characters | `null` without expensive parsing |

Protocol tests cover this grammar. Bridge route tests must also verify observable
windows so a correct helper cannot be wired to the wrong query parameter:

1. Missing and malformed cursor return the retained tail with correct base index.
2. A valid cursor inside the tail returns the expected suffix.
3. A valid cursor before eviction base reconciles to the retained window.
4. A valid cursor after the current end gives the existing bounded empty result
   and consistent totals.
5. The same fixture/input produces the same shape-relevant result in Pi, Cursor,
   and ACP, allowing only legitimate provider metadata differences.

## Validation

Run the protocol transcript-window tests, each affected bridge's HTTP tests,
and relevant protocol/bridge typechecks. Use explicit logged focused commands;
for example, after adding the helper to this existing module:

```sh
mise run test:logged -- --name transcript-cursor-contract -- \
  bun test ./packages/protocol/src/transcript-window.test.ts \
  --parallel=1 --only-failures
```

Add a backend incremental-read regression if its request builder or fallback
interpretation changes. This step alone needs no new UI, but step 11 should
exercise reload/reconciliation after transcript shedding together with it.

## Acceptance

- [ ] All equivalent routes use one parser and documented grammar.
- [ ] Malformed and unsafe values cannot be partially consumed or rounded.
- [ ] Correct existing clients remain compatible; alternate syntax changes are
  explicitly reviewed against emitters.
- [ ] Invalid input selects a bounded authoritative fallback.
- [ ] No SSE or opaque cursor protocol is altered accidentally.
- [ ] Protocol, route, and type checks pass with the new boundary cases.


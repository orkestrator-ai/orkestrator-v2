# 02 — Make transcript size accounting and trimming linear

Status: Complete. Prerequisite: 01. Findings: E09; supports E01/E05.

## Outcome

Reaching a transcript ceiling must not repeatedly serialize the entire shrinking
history. The same inputs must preserve each bridge's current retention order,
truncation metadata, and background-task semantics.

## Owners

- [Shared windowing](../../../../packages/protocol/src/transcript-window.ts) and
  its adjacent test file.
- [Cursor transcript](../../../../bridges/cursor-bridge/src/transcript.ts),
  [Pi transcript](../../../../bridges/pi-bridge/src/transcript.ts), and
  [ACP transcript](../../../../bridges/acp-bridge/src/acp-transcript.ts).
- Corresponding translators/part-budget helpers: every mutable field contributing
  to encoded size must either invalidate a cached size or update it exactly.

## Implementation

1. Specify the accounting unit as UTF-8 encoded JSON bytes, including escaping,
   array commas/brackets, and any caller-specified envelope reserve. Do not use
   JavaScript string length or unescaped UTF-8 length as an exact JSON size.
2. Refactor shared trimming to use offsets into messages and parts, then one
   final slice. Remove repeated `shift()` operations where they repeatedly move
   large arrays. Compute each candidate message size once per uncached pass.
3. When one message alone exceeds the ceiling, compute its part sizes once and
   subtract dropped sizes. Account for removal of the last comma correctly.
   Recheck only the final altered message if fallback/truncation markers change
   its shape; do not recheck every prefix.
4. Expose an internal result with retained range, omitted counts, exact retained
   size, and overflow. Keep existing public behavior stable unless an additive
   internal size field is useful. Never trust a supplied size from a client.
5. Adapt Cursor/Pi to the algorithm while preserving their counters and in-place
   session ownership. ACP requires its notice-aware `trimPartsTo` behavior:
   account for the notice replacement explicitly rather than replacing that
   logic with generic array slicing.
6. Add per-message/per-part cached sizes only where mutation identity is proven.
   A WeakMap keyed by a mutable part alone is insufficient. Key it by object
   plus mutation version, or invalidate at the mutation boundary. Start with
   once-per-bound sizing if a complete mutation audit is not yet available.
7. Use a conservative growth charge between exact checks. Charge negative
   replacements/invalidation separately; a shrink can invalidate a cached
   measurement even though it does not increase the dirty-byte counter.
8. Ensure discarded display rows release supporting display-only lookup entries.
   Keep active child lifecycle registries, approvals, and dispatch journals.

## Tests

- Port the 100-message probe into an operation-count regression: linear
  serialization visits and identical retained message IDs/content.
- Test empty input, exact fit, one-byte excess, only one remaining message,
  all parts removed, content fallback, and overflow with fallback disabled.
- Test quotes, backslashes, control escapes, astral characters, and multibyte
  boundaries. Compare reported encoded size with actual serialized output.
- Test ACP notice insertion and stable truncation metadata across repeated reads.
- Mutate a previously measured tool part without replacing its object and prove
  the cache does not reuse stale size. Test replay/restore with unmeasured data.
- Verify active child state remains actionable after its old display row is shed.

## Acceptance and rollout

One uncached trim is O(total candidate bytes + candidate count); removing many
entries does not multiply full-history serialization. Unchanged reads remain
cheap. Preserve all current ceilings. Ship the shared primitive and adapters in
small PRs if needed, with each adapter retaining its existing response contract.
This step provides the safe producer-side enforcement used by step 03.

## Execution record

```text
Status: Complete
Implementation commit / PR: branch 20260927-125815-7f0993836777 (perf(transcripts): linear trim accounting and producer-side Cursor bounds)
Protocol or storage decisions:
  - New packages/protocol/src/transcript-budget.ts: planOldestFirstTrim measures
    each candidate message once (and, only when one message is left over
    budget, each of its parts once), subtracts sizes, and returns a plan with
    the exact retained encoded size (UTF-8 JSON bytes incl. escapes, commas,
    brackets). boundTranscriptInPlace applies Cursor/Pi structural + byte
    bounds with one splice per array.
  - ACP keeps its notice-aware trimPartsTo: the planner sizes the notice part
    exactly (leadingReplacement), reproduces "each pass strictly shortens
    parts" semantics, and ACP applies the plan with one trimPartsTo call.
  - transcript-window.ts part shedding now advances an index and slices once
    instead of repeated shift().
  - jsonStringContentBytes gives an exact escaped-byte charge for appended
    text; Cursor and Pi producers now charge UTF-8/escape-aware upper bounds
    (both the part and the mirrored message body) instead of UTF-16 length.
  - transcript-part-ids.ts nextPartOrdinal: per-message monotonic part
    ordinals (WeakMap, scans restored messages once) replace
    `parts.length`-derived ids in Cursor and Pi, so trimmed fronts cannot
    make a new part reuse a retained part's id.
Tests and isolated profiles:
  - packages/protocol/src/transcript-budget.test.ts: 60 seeded transcripts x 7
    ceilings with multibyte/astral/quote/backslash/control text compared with
    the old quadratic loops (with and without the ACP notice); reported bytes
    equal actual serialized bytes; empty/exact/one-byte/overflow cases;
    operation counts (validation probe: 100 x 8 KiB at 256 KiB -> 31 kept,
    100 serializations; previously 4,585); one visit per part for a
    5,000-part message; concatenation charge is an upper bound.
  - transcript-part-ids.test.ts: ordinals never reissued after front trims,
    restored messages continue past the largest suffix.
  - Pi translate.test.ts: UTF-8 charge; unique ids after front trimming.
  - Full suites: bun test ./bridges/{cursor,pi,acp}-bridge/src (pass),
    packages/protocol ./src (pass); protocol/bridge typechecks; format, lint.
Before/after measurements: validation probe serialization visits 4,585 -> 100
  (Cursor trim, same 31 retained messages). Deterministic counts only; no
  wall-clock claims.
Compatibility/migration result: no wire or persisted-schema change. Part ids
  for new parts keep the `${messageId}:<n>` / `summary:<n>` / `retry:<n>` shapes.
Remaining limitations: per-message sizes are recomputed once per bound pass
  (no cross-pass size cache): the plan's step 6 cache requires a mutation
  audit that tool-card patching makes risky; one pass is linear and runs only
  after 1 MiB of charged growth or a structural overflow.
```

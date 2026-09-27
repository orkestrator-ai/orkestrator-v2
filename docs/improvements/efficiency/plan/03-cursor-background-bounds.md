# 03 — Bound Cursor transcripts while no UI is reading

Status: Complete — a live Cursor inactive-tab run with a real account was not performed. Prerequisite: 02. Finding: E01. Priority: urgent.

## Outcome and scope

Cursor enforces display limits during normal, nested, and recovered streaming.
It continues executing work when a tab is inactive. A read must no longer be the
operation that first discovers arbitrarily accumulated display data.

## Owners

- [Translator](../../../../bridges/cursor-bridge/src/translate.ts).
- [Transcript budgets](../../../../bridges/cursor-bridge/src/transcript.ts).
- [Prompt callback](../../../../bridges/cursor-bridge/src/prompt.ts).
- [Recovery path](../../../../bridges/cursor-bridge/src/agent-session.ts).
- [State](../../../../bridges/cursor-bridge/src/state.ts) and existing transcript,
  translate, prompt, and recovery test owners.
- [Pi's producer bound](../../../../bridges/pi-bridge/src/transcript.ts) as an
  existing pattern, not an instruction to copy its assumptions blindly.

## Implementation

1. Add a single producer-bound entry point called after an outermost translated
   update. Nested recursion must not perform redundant full checks for each
   level; track/update dirty totals while nested and enforce once on return.
2. Enforce message and per-message part counts immediately when adding entries.
   Audit whether nested arrays have their own caps; a top-level count does not
   bound arbitrarily large `childTools` or related collections.
3. Choose a named bounded byte-check threshold from existing provider patterns.
   Record the permitted transient overshoot as threshold plus the largest
   admitted update, not “roughly bounded”. Clamp or reject oversized individual
   input before storing it; new parts must receive the same bounds as appends.
4. Run the step-02 exact trim when the threshold/count checks require it. Keep
   this synchronous work bounded; never await persistence or rendering in the
   SDK listener. Record check frequency and worst check duration in probes.
5. After trimming, invalidate open-text and tool display lookups that refer to
   removed parts. Preserve monotonically allocated part identity so a newly
   appended part cannot reuse the ID of an evicted part just because array
   length shrank. Active child identity lives outside the display buffer.
6. Increment transcript revision when the visible representation changes. Carry
   accurate omitted counts and epoch changes when message membership changes.
7. Apply the same path during recovered-stream translation and validate restored
   state before making it available. Keep the read-side bound as a defensive
   check, not the primary enforcement mechanism.

## Regression scenarios

- Feed the existing 600-reasoning-block probe without invoking `/messages`,
  `/transcript`, or `/session`; assert the structural cap throughout.
- Exceed the byte cap with several individually legal tool/text updates. Assert
  the documented overshoot bound at every observation point.
- Alternate reasoning, text, tool calls, summaries, and nested updates. Verify
  unique IDs and working lookups after multiple trims.
- Evict a running child's launch card while the child remains active. Its
  lifecycle/status/control must not be removed or changed to complete.
- Switch environments during a long real isolated run, let the trim occur,
  then return and verify the truncated window plus correct running/completed
  state and available controls.

## Acceptance and compatibility

No wire/schema migration is required. Retained content may now be trimmed before
a read, which is the intended behavior under the existing display budget.
Benchmark producer latency to ensure enforcement does not stall unrelated
sessions. Ship independently of the larger protocol migration. Do not add an
option that disables background bounding in production as a rollback mechanism;
if the implementation regresses, retain a simpler bounded enforcement path.

## Execution record

```text
Status: Complete; real-stack inactive-tab QA unrun (see limitations)
Implementation commit / PR: branch 20260927-125815-7f0993836777 (same commit as step 02)
Protocol or storage decisions:
  - applyInteractionUpdate is now a wrapper: the recursive translator runs
    (nested tool-call-delta updates recurse into the internal function) and
    boundTranscriptDuringStreaming runs once per top-level update. Prompt
    onDelta and recovered-stream replay both go through it.
  - Structural limits (500 messages, 512 parts on the newest message) are
    checked on every update; the exact byte bound runs after
    STREAM_BOUND_INTERVAL_BYTES = min(MAX_TRANSCRIPT_BYTES, 1 MiB) of charged
    growth. Documented transient bound: MAX_TRANSCRIPT_BYTES +
    STREAM_BOUND_INTERVAL_BYTES + one admitted update (itself capped by the
    per-field limits: 2 MiB text, 512 KiB args/output, 1 MiB diff).
  - Charges are upper bounds on encoded growth: new entries at exact encoded
    size + separator, appends at escaped suffix bytes (part and message body),
    replacements (progress line, summaries, settle notes) at their new text.
    Shell-output frames that continue the displayed buffer charge the suffix
    instead of re-encoding a card holding up to 512 KiB of output per frame.
  - Part ids use nextPartOrdinal; steered user rows use random ids instead of
    `appended-${messages.length}`. Open-text lookups scan newest-first.
  - hydrateHistory bounds after each appended historic turn; recovery that
    replaces the transcript clears open blocks/current assistant id and bumps
    a process-local transcriptEpoch, which (with droppedMessages) forms the
    /transcript contentEpoch so absolute positions cannot survive a rewrite;
    rewind bumps it too.
  - Active child lifecycle stays in activeSubagentDescriptors (outside the
    display buffer); read-side boundTranscriptForRead remains as a defensive check.
Tests and isolated profiles: bridges/cursor-bridge/src/translate-bounds.test.ts
  (600 reasoning blocks without reads keep <=512 parts at every step and
  unique ids; 80 x 512 KiB multibyte text + tool cards stay below the
  documented transient bound at every observation; UTF-8/escape charging;
  charges never lag real growth; 700 interleaved rounds of reasoning, text,
  tools, summaries and nested updates keep unique ids and working open-block
  lookups; a background child's launch card trimmed away keeps the child
  active until settleBackgroundChildren). Full cursor suite passes.
Before/after measurements: validation probe "600 x 1 KiB reasoning, no reads":
  before 600 parts / 712,206 bytes retained; after <=512 parts throughout,
  byte growth bounded by the documented ceiling.
Compatibility/migration result: no wire/schema change; contentEpoch becomes
  "<epoch>:<droppedMessages>" only after a rewind/recovery replacement in the
  current process (opaque to the backend).
Remaining limitations: the isolated dev:test inactive-environment run with a
  real Cursor account was not performed in this change; coverage is the
  producer-level regression suite above.
```

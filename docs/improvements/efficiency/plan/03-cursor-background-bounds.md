# 03 — Bound Cursor transcripts while no UI is reading

Status: Not started. Prerequisite: 02. Finding: E01. Priority: urgent.

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

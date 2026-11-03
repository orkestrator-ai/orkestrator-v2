# Bridge transcript windows are always sent whole

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Capture the baseline**: measure bridge transcript bytes while a turn streams. Status: open.
2. **Add a v2 `delta` answer**: a bridge answers with changed rows, the id order and `revisedMessages`. Status: open (depends on 1).

### 1. Capture the baseline

**Problem.** The report measured nothing, and the maintainer gated this on numbers.

**Context.** Decided 2026-11-01 in 1202 task 1: task 4, which holds this finding, needs a baseline first.

**Investigation.** Not started; the method is 1202 task 1's.

**Decisions.** None: the decision was made in 1202.

### 2. Add a v2 `delta` answer

**Problem.** Any change re-sends and re-parses up to 100 rows or 512 KiB between bridge and backend, when usually only the tail row moved.

**Context.** The bridges already track revised rows (`RecentlyRevisedRows`), and the backend already sends a `knownToken`.

**Investigation.** `readHttpBridgeSummaryTranscript` (`apps/backend/src/core/http-bridge-transcript-v2.ts:160`) handles `unchanged` (`:197`) and otherwise a whole snapshot. The bridges answer through the shared code in `packages/protocol/src/node/bridge-transcript-summary.ts`, whose contract tests (`bridge-transcript-contract.ts:335-365`) cover `knownToken` for unchanged and changed reads, so a fix lands in one place plus each bridge's source.

**Decisions.**

- **What is the base of a delta?**
  - **The `knownToken`, falling back to a snapshot on an unknown base (recommended).**
    - Pros: the report's fix; it mirrors the backend's own delta and needs a small ring on each bridge.
    - Cons: every bridge holds recent views; a new wire form needs a capability check and a version-compatibility entry.
  - **Keep whole windows and rely on TX-1 and the client delta.**
    - Pros: no bridge change.
    - Cons: the loopback cost stays. It is CPU rather than remote bandwidth, so this is a fair choice if the baseline shows it is small.

## Constraints and rationale

- Decided 2026-11-01 (1202 task 1): baseline first.
- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): a transcript row is one model response, so deltas must carry `revisedMessages` for rows outside the live tail; missed events stay detectable; any ring needs byte and count bounds.

## Related

- [Efficiency report, B](../2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-6)
- [1202 tasks 1 and 4](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
- [0160](0160-tx-1-delta-base-ring.md): the backend's delta bases

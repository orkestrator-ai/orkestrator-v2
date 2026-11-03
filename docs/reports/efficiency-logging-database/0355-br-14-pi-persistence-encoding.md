# Pi persistence serialises every session on each write

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Encode each record once**: follow Cursor's budget code so a write and its shedding do not re-serialise everything. Status: open.

### 1. Encode each record once

**Problem.** Each state write serialises every session, and if the state is over budget, shedding serialises the whole payload again after each session it trims.

**Context.** It runs only at turn and request edges, and bursts are coalesced (`schedulePersist`, `bridges/pi-bridge/src/persistence.ts:69`), so the report rates it Low.

**Investigation.** `persistNow` (`persistence.ts:164`) does `JSON.stringify(payload)` (`:175`). `shedToFit` re-serialises in its loop (`:152`). Cursor's `bridges/cursor-bridge/src/persistence-budget.ts` plans each record once (`planRecord`, `:201`) and splices them into the envelope (`:128-130`). The two differ in policy: Pi sheds the oldest transcripts, while Cursor refuses with `persistence-budget-exceeded`.

**Decisions.**

- **Port or share?**
  - **Port the encode-once technique into Pi's shedding, keeping Pi's policy (recommended).**
    - Pros: small and local; no change to what is written.
    - Cons: a second copy of the technique.
  - **Move a shared budget helper into `packages/protocol/src/node`.**
    - Pros: theme T4's direction.
    - Cons: the two policies differ, so the helper would need both, for a Low finding.

## Constraints and rationale

- A durability barrier must still throw when the state cannot fit (`bridges/pi-bridge/src/persistence.ts:176-181`), so dispatch stops when nothing was published.
- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) apply as usual.

## Related

- [Efficiency report, C](../2026-10-27-efficiency.md#c-bridges) (BR-14)
- [1202 task 6](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
- [0240](0240-br-1-acp-persist-fragments.md): the same pattern in ACP

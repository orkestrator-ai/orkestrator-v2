# Splice the legacy projection command's response

## Task analysis

Analysed 2026-11-05 against `main` at `e6c3da899`, found while measuring E11 for [6260](6260-projection-hashing-measurements.md) task 2.

### Tasks

1. **Decide whether `get_native_agent_projection` should be spliced like the transcript commands**: Status: open.

### 1. Decide whether `get_native_agent_projection` should be spliced like the transcript commands

**Problem.** E11 part 0340 marked four transcript commands so the gateway copies already-encoded rows into the response instead of serialising them again (`markSpliceableResult` in `apps/backend/src/core/commands-registry-native.ts`, `spliceEncodedJson` in `apps/backend/src/gateway-handlers.ts`). `get_native_agent_projection`, the legacy full projection, is not marked, so the gateway runs `JSON.stringify` over the whole window on every read. Its rows come from the same per-row memo, so each row was already encoded once for its size.

**Context.** The changed-read benchmark's `legacy` scenario (`scripts/benchmark-transcript-changed-read.ts`, 100 rows) answers 431,511 bytes per read. After the 6260 fix the read serialises 445,057 characters, of which the gateway's response is all but about 13,500. The read costs 281 µs of CPU. Callers are the renderer's workflow helpers (`apps/web/src/lib/backend/workflows.ts`), the remote node coordinator (`apps/backend/src/core/nodes/node-coordinator-remote.ts`) and the control MCP tools (`apps/backend/src/core/control-mcp-tools.ts`). Those over the gateway would gain; in-process callers receive the same plain object either way.

**Investigation.** Not measured with splicing. The 0340 outcome in the efficiency outcome report (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`) names "the four transcript commands" and gives no reason for leaving this one out. The splice already falls back to `JSON.stringify` for anything that is not a plain object or array, and the gateway test compares spliced bodies with `JSON.stringify({ result })`.

**Decisions.**

- **Mark it?**
  - **Mark the result, add a gateway test for this command, and re-measure the `legacy` scenario with the spliced body (recommended).**
    - Pros: one line in the registry; removes the largest serialisation left on that read; output is byte-identical by construction.
    - Cons: one more marked command to keep in mind if the projection ever gains a non-plain field. The splice handles that by falling back, so the risk is cost, not correctness.
  - **Leave it.**
    - Pros: no change on a legacy path.
    - Cons: the path still has three production callers, and each read serialises about 430 KB that the memo already holds.

## Related

- [6260](6260-projection-hashing-measurements.md): the measurement that found it
- Efficiency outcome, measurement of E11 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`)

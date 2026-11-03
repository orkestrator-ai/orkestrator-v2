# ACP stdout framing is quadratic for large frames

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Frame stdout with a chunk list and scan offset**: stop copying and rescanning the buffer on each chunk. Status: open.

### 1. Frame stdout with a chunk list and scan offset

**Problem.** Each stdout chunk copies the whole pending buffer and searches it again from the start, so a large frame costs in proportion to its size squared.

**Context.** The shared SSE decoder had the same flaw and is fixed (GW-4). Codex's client is the report's model.

**Investigation.** `bridges/acp-bridge/src/acp-context.ts:1386` does `Buffer.concat([this.#stdoutBuffer, chunk])`, then `indexOf(0x0a)` from zero (`:1388`). The frame limit is `MAX_LINE_BYTES`, 4 MiB (`:870`), enforced at `:1390` and `:1399`. Codex keeps `bufferScannedTo` so a scan resumes where it stopped (`bridges/codex-bridge/src/app-server/jsonl-rpc-client.ts:246`), but over decoded text, so it cannot be copied as it is: ACP buffers bytes.

**Decisions.**

- **Where does the code live?**
  - **In `acp-context.ts`: search only the new chunk for a newline, and join chunks when one arrives (recommended).**
    - Pros: small and local; a newline cannot straddle a chunk, as it is one byte.
    - Cons: the helper stays ACP's own.
  - **A shared JSONL framer in `packages/protocol/src/node`.**
    - Pros: theme T4's direction.
    - Cons: a protocol change for a low-impact fix, and Codex's version would have to move too, which its stdout rule makes riskier.

## Constraints and rationale

- The oversized-frame close must still fire at the same limit, both for a terminated and an unterminated line.

## Needs verification

- The size ACP frames reach in practice. Reasoned from the limit, not measured.

## Related

- [Efficiency report, C](../2026-10-27-efficiency.md#c-bridges) (BR-12)
- [1202 task 6](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)

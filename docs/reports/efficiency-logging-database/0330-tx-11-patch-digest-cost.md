# Patch building re-serialises and hashes whole rows in a JavaScript loop

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Reuse encodings in patch building**: compare content-less parts field by field and avoid re-serialising the part list for the digest. Status: open.

### 1. Reuse encodings in patch building

**Problem.** For each patched message, the builder serialises its parts and walks every character in JavaScript to compute a digest. It also serialises patches to compare sizes.

**Context.** The same digest is checked on the client when it applies a patch, so both sides must compute the same value. This limits the report's "use a native hash": the renderer has no synchronous native hash.

**Investigation.** In `packages/protocol/src/native-agent-transcript-patch.ts`, `partsDigest` (`:71`) does `JSON.stringify(parts)` and a per-character loop. It is called to build (`:251`) and to apply (`:270`). The size comparison is `JSON.stringify(patch)` at `:151`. An injectable `encode` exists (`:67-69`), and the backend passes the memoised one (`apps/backend/src/core/native-agent-transcript-patches.ts:16`), but `partsDigest` does not use it.

**Decisions.**

- **How to make the digest cheaper?**
  - **Keep the algorithm, and feed it from the memoised encodings on the backend (recommended).**
    - Pros: the digest's value is unchanged, so no protocol change; removes the repeat serialisation, the larger part of the cost.
    - Cons: the per-character loop remains; encodings must join to byte-identical text as `JSON.stringify(parts)`.
  - **Change to a native hash.**
    - Pros: the report's suggestion; much faster on the backend.
    - Cons: the browser would need `crypto.subtle`, which is asynchronous, or a JavaScript copy of the hash, and a changed digest needs a new patch version and a version-compatibility entry.

## Constraints and rationale

- Patch semantics are negotiated by `NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION`; a client must still reject a patch that does not line up with its base.
- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) apply as usual.

## Needs verification

- The share of a transcript read this takes. Reasoned, not measured.

## Related

- [Efficiency report, B](../2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-11)
- [1202 task 5](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)

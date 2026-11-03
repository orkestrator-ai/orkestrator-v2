# The preview body rewrite makes many full regex passes

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Combine the rewrite passes**: one regex per content kind, with a cheap skip when nothing matches. Status: open.

### 1. Combine the rewrite passes

**Problem.** Rewriting one HTML body on the legacy preview route runs nine `replace` passes (the report counted up to ten), and several buffer and string copies.

**Context.** GW-9 is done, so a reload now revalidates, and this runs only on a first load or a changed module. The legacy route is also a fallback. So the remaining cost is much lower than when the report was written.

**Investigation.** `rewriteBrowserPreviewBody` is at `apps/backend/src/gateway-support-extra.ts:555`. HTML runs all its groups (`:569-608`): two for attributes, two for CSS, four for imports, and one for a loopback origin. The caller joins, decodes and re-encodes (`apps/backend/src/gateway-proxy.ts:368-369`). No check skips a body with nothing to rewrite.

**Decisions.**

- **How much to do?**
  - **One combined regex per kind plus a no-match skip (recommended).**
    - Pros: the report's fix; one pass per body.
    - Cons: the current passes run in sequence, so a combined regex must be proved to give the same output; each kind's alternation is harder to read.
  - **Only add the no-match skip.**
    - Pros: small; helps the many modules with nothing to rewrite.
    - Cons: a body with one match still pays every pass.

## Constraints and rationale

- `gateway-proxy-etag.ts` hashes the rewriter's source into the derived ETag, so any edit here costs one full reload per module after an update. That is by design.
- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) apply as usual.

## Open questions

- Whether this is worth doing at all now. 1202 lists GW-6 ahead of it for that reason, and no first-load profile was run.

## Related

- [Efficiency report, A](../2026-10-27-efficiency.md#a-gateway-and-transport) (GW-10)
- [1202 task 11](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)

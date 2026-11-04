# E24: Gateway static and preview

This file combines 2 reports into one batch to build together. Both in `gateway-proxy.ts`.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0310](#0310-static-fallback-compression-runs-before-the-304-check) | Low | GW-15: Static fallback compression runs before the 304 check |
| [0365](#0365-the-preview-body-rewrite-makes-many-full-regex-passes) | Low | GW-10: The preview body rewrite makes many full regex passes |

## 0310: Static fallback compression runs before the 304 check

### Task analysis

#### Tasks

1. **Answer `If-None-Match` before compressing**: skip the fallback compression for a revalidation that will match. Status: open.

#### 1. Answer `If-None-Match` before compressing

**Problem.** A browser revalidating a static file with no precompressed sibling makes the gateway compress the file, then throw the result away and answer 304.

**Context.** Affects only files without a sibling, and only what is under `MAX_STATIC_FALLBACK_SOURCE_BYTES`.

**Investigation.** In `apps/backend/src/gateway-proxy.ts`, the compression runs at `:794`, and the 304 check at `:860`. The check needs the ETag, built from `etagForStaticVariant` (`:846`) with `selectedEncoding`, which is only final after compression, because a declined or failed compression falls back to identity. `compressStaticFileWithinLimits` (`gateway-support-core.ts:1931`) keeps no results between requests.

**Decisions.**

- **How to check before compressing?**
  - **Compute the ETag for the encoding the fallback would choose, and compare before compressing (recommended).**
    - Pros: the report's first fix; needs no cache; a matching revalidation does no work.
    - Cons: if the compression would have failed, a client holding the encoded tag still gets a 304, which is fine because it holds valid bytes for that tag.
  - **Add a small bounded result cache as well.**
    - Pros: the report's second fix; also saves work on full 200s.
    - Cons: a new cache with byte and count bounds for a low-impact path. Leave it out until a measurement asks for it.

### Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): a compression buffer or cache needs byte and count bounds.
- The `Vary` and `Content-Encoding` headers on the 304 must match what a 200 would send (see `gateway-proxy.ts:843-858`).

## 0365: The preview body rewrite makes many full regex passes

### Task analysis

#### Tasks

1. **Combine the rewrite passes**: one regex per content kind, with a cheap skip when nothing matches. Status: open.

#### 1. Combine the rewrite passes

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

### Constraints and rationale

- `gateway-proxy-etag.ts` hashes the rewriter's source into the derived ETag, so any edit here costs one full reload per module after an update. That is by design.
- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) apply as usual.

### Open questions

- Whether this is worth doing at all now. 1202 lists GW-6 ahead of it for that reason, and no first-load profile was run.

## Related

- [Efficiency report, A](../2026-10-27-efficiency.md#a-gateway-and-transport) (GW-15, GW-10)
- [1202 task 11](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)

# Static fallback compression runs before the 304 check

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Answer `If-None-Match` before compressing**: skip the fallback compression for a revalidation that will match. Status: open.

### 1. Answer `If-None-Match` before compressing

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

## Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): a compression buffer or cache needs byte and count bounds.
- The `Vary` and `Content-Encoding` headers on the 304 must match what a 200 would send (see `gateway-proxy.ts:843-858`).

## Related

- [Efficiency report, A](../2026-10-27-efficiency.md#a-gateway-and-transport) (GW-15)
- [1202 task 11](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)

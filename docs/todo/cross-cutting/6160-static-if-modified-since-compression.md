# A static revalidation by date alone still compresses first

## Task analysis

Analysed 2026-11-05 against `main` at `0194a0675`.

### Tasks

1. **Decide what an `If-Modified-Since`-only revalidation should do**: it still runs the on-the-fly compression before its 304. Status: open.

### 1. Decide what an `If-Modified-Since`-only revalidation should do

**Problem.** Batch E24 (GW-15) made a matching `If-None-Match` on a static file with no precompressed sibling answer 304 with no compression. A request with `If-Modified-Since` and no `If-None-Match` still compresses the file, throws the result away and answers 304 (`serveStatic` in `apps/backend/src/gateway-proxy.ts`).

**Context.** Every static response carries an ETag and a `Last-Modified`, and a browser that has both sends both, so this needs a client that keeps only the date. The cost is bounded by `MAX_STATIC_FALLBACK_SOURCE_BYTES` and the fallback's concurrency limit, and the on-the-fly path applies only to files with no precompressed sibling.

**Investigation.** Read from the code on 2026-11-05; no such client was looked for. A tag says which variant the client holds, so the 304's `Content-Encoding` can be taken from it. A date says nothing about the variant. Today's 304 describes the coding this request's compression chose, and that is not necessarily what the client stored, for example after an earlier decline. `apps/backend/tests/gateway-events.test.ts` has the only test of this path, on a document with no compression negotiated.

**Decisions.**

- **What to do with a date-only revalidation?**
  - **Leave it, and close this to-do if no client we ship sends a date without a tag (recommended).**
    - Pros: no change for a path browsers do not take; the answer keeps describing what a 200 would send now.
    - Cons: a client that does take this path pays one compression per revalidation.
  - **Answer before compressing, with the first-choice coding's tag and headers.**
    - Pros: no compression on this path either.
    - Cons: for a file where compressing does not help, the 304 names a coding no 200 would send, and a cache that copies that field onto its stored identity copy could then misdecode it.
  - **Answer before compressing, naming no coding.**
    - Pros: cannot mislabel a stored copy.
    - Cons: RFC 9110 requires a 304 to carry the ETag a 200 would have sent, and which tag that is depends on compressing.

## Related

- Closing check of E24 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`), where this was left.
- to-do 1202 task 11 (retired 2026-11-10).

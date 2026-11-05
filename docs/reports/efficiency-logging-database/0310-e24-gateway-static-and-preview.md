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

## Check-back

Built on 2026-11-05 on branch `gateway-static-preview-b18ff877de68-r1`, based on `main` at `0194a0675`. The first commit was made on `ecff91f74` and rebased; the four commits between them change no gateway source, only two gateway test files.

### Re-check of the claims

Every claim held. E18 moved the lines without changing these paths:

- `0310`: compression is at `gateway-proxy.ts:806` before this change, the 304 check at `:875`, the tag at `:861`, `compressStaticFileWithinLimits` at `gateway-support-core.ts:1956`. It still keeps no results between requests, though concurrent requests share one in-flight run.
- `0365`: `rewriteBrowserPreviewBody` is at `gateway-support-extra.ts:569`, its groups at `:591-620`, the caller's decode and re-encode at `gateway-proxy.ts:405-406` after this change. No skip exists. Nine passes is right for HTML only: JavaScript runs five and CSS three, and a Vite first load has one HTML body.

### First-load numbers for 0365

Bodies captured from a real Vite dev server, then measured with `apps/backend/scripts/preview-rewrite-costs.ts`: Bun 1.4.4, medians of 15 interleaved rounds for the rewriter and 7 for the replay, three sets, ranges across the sets. The host's load average was 41 to 49, so the milliseconds are noisy and the counts are not. The replay is the real gateway, compressing with gzip, on an ephemeral port with a temporary data directory, against an application served from memory, with the client in the same process. That inflates its wall clock, so the rewrite's share is if anything understated there and overstated against a real page, which also waits on Vite and the browser.

| Corpus | Bodies (bytes) | Nothing to rewrite | Rewrite today | Combined regex saves | No-match skip saves | Gateway first load | Repeat load (all 304) | First-load bytes on the wire |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `fixture`: `test-fixtures/preview-vite` | 5 (43,637) | 2 bodies, 643 bytes (1.5%) | 0.25–0.27 ms | 0.01–0.05 ms | Within noise | 8.7–12.4 ms | 5.5–8.1 ms | 14,219 |
| `wide`: the fixture plus 150 generated one-line modules | 154 (60,123) | 151 bodies, 4,133 bytes (6.9%) | 0.36–0.47 ms | 0.09–0.12 ms | About 0.1 ms | 43–48 ms | 34–44 ms | 18,332 |
| `web`: this repository's `apps/web`, with every lazy route, so an upper bound | 1,754 (27,957,113) | 319 bodies, 3,044,053 bytes (10.9%) | 152–190 ms | 46–93 ms | −6 to 13 ms, within noise | 1,531–3,094 ms | 749–1,081 ms | About 7.09 MB |

The rewrite is 2–3% of the gateway's first load on `fixture`, about 1% on `wide` and 6–10% on `web`. Walking the `web` closure through Vite itself took 8,166 ms (one capture), about 50 times the rewrite. On `web` a combined regex would save 2–3% of the gateway's first load, or under 1% once Vite's own time is counted.

A rewriter edit changes the rewrite key, so after an update every module of a previewed app is a full response once. On `web` that costs 782–2,013 ms more gateway time and 7.09 MB on the wire, against 46–93 ms saved per first load: 17 to 29 complete first loads of the whole closure per update to break even on time, and the bytes never pay back. On `wide` it takes about 100.

### Outcome

| Part | Item | Outcome | Code, evidence or to-do |
| --- | --- | --- | --- |
| 0310 | Task 1: skip the fallback compression for a revalidation that will match | Done | `heldStaticFallbackEncoding` (`apps/backend/src/gateway-proxy.ts:95`), called at `:835` before the compression at `:850`. Tests in `apps/backend/tests/gateway-static-revalidation.test.ts`: "a matching tag gets a 304 with no compression run", which also asserts that a full response does compress. With the check disabled, 6 of the file's 17 tests fail. In headless Chromium against a real gateway, reloads ran 0 compressions, and the script, the stylesheet and the 9,252-character body stayed intact. |
| 0310 | Decision: compute the tag before compressing | Done, recommended option, widened | It compares every variant this request could have been given, not only the first choice, and identity when acceptable. Comparing the first choice alone would still compress on every revalidation of a file where compressing does not help, or of a client holding its second choice. Tests: "a tag held from an uncompressed answer matches without compressing", "a client holding the second choice keeps it, with that coding's headers". |
| 0310 | Decision's stated cost: a client holding the encoded tag gets a 304 where compressing would fail | Accepted, as the report says | Test: "a client holding an encoded tag gets a 304 even when compressing would decline". The same holds for a client holding identity after a decline: it keeps valid bytes until the file changes, and pays no transfer. |
| 0310 | Decision: a small bounded result cache | Left out, as recommended | No measurement asks for it. No cache or buffer was added. |
| 0310 | Constraint: the 304's `Vary` and `Content-Encoding` match a 200 | Done | Test: "a 304 carries the Vary, Content-Encoding and validators of the 200", for `br`, `gzip` and both. |
| 0310 | Found while building: the 304 cannot state a coded length | Done | Only compressing would tell us, and a cache copies a 304's fields onto its stored response, so the identity size would be wrong. The field is omitted for a coded variant. Test: "a 304 never states a length it did not measure". |
| 0310 | Found while building: `If-None-Match: *` names no variant | Done | It takes the normal path, so its coding is the one a 200 would have. Test: "a wildcard takes the normal path, so its coding is the one a 200 would have". |
| 0310 | Non-matching requests keep the right body and encoding | Done | Tests: "a stale tag gets the coded body", "a tag from before the file changed does not match", "a coded tag the request no longer accepts gets a coding it does accept", "an identity tag is not a match where identity is forbidden", "a declined compression serves identity, with the identity tag", "a failed compression serves identity, with the identity tag", "a client holding a coded copy of a file over the cap is not answered by it", "a precompressed sibling still takes precedence over the on-the-fly tags", "a HEAD revalidation still reports the identity metadata it always did". The failure test settles the in-flight run as `declined`, the outcome a codec failure produces; a real codec failure was not forced. |
| 0310 | `If-Modified-Since` with no `If-None-Match` | Not done, moved to a to-do | It still compresses first, because it names no variant, so nothing tells the gateway which coding the 304 should describe. Every static response carries an ETag, so a browser sends `If-None-Match` as well. To-do [6160](../../todo/cross-cutting/6160-static-if-modified-since-compression.md). |
| 0365 | Open question: is this still worth doing? | Answered: no | The numbers above. Real bodies rewrite in well under 1 ms for a small page and about 150–190 ms for a 1,754-module, 28 MB closure. |
| 0365 | Task 1 and decision: one combined regex per kind | Declined | It would save 46–93 ms on the largest case at the cost of a one-time reload, and needs 17 to 29 complete first loads per update to break even. The nine HTML passes run on one body per page, so the HTML alternation would save almost nothing, and it could not be byte-identical in any case: a single pass matches non-overlapping text, while today `<a href="/a url(/b) c">` becomes `<a href="<P>/a url(<P>/b) c">` (observed). The JavaScript variant differed on none of 1,753 real bodies, which is not proof and was not taken further, so no differential test was written. |
| 0365 | Decision: only a no-match skip | Declined | A good share of bodies have nothing to rewrite only by count: 18% of `web`, but 10.9% of its bytes, and `wide`'s 98% is 6.9% of its bytes because the generated modules are one-liners. The saving is within noise on `web` and about 0.1 ms on `wide`. Inside the rewriter it pays the same reload. In the caller it pays none but keeps a second copy of the patterns, where a missed shape silently leaves a body unrewritten, and the decode and re-encode stay because they change invalid UTF-8. |
| 0365 | Constraint: the rewriter's source is hashed into the tag | Not triggered | `rewriteBrowserPreviewBody` and `gateway-proxy-etag.ts` are unchanged, so nothing reloads after this update, and the existing tag behaviour stands. |
| 0365 | Context: the route is a fallback | Confirmed | To-do [0042](../../todo/previews-and-annotations/0042-service-preview-rollout.md) plans to retire it. That is why GW-10 is recorded as declined rather than left open: reopen it only if the route stays and a real page shows the rewrite in a profile. |
| Both | Report invariants | Held | No new cache, queue or buffer. The script's output is aggregates only, and its corpus stays in the git-ignored `output/`. |

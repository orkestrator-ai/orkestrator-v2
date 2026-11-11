# A static revalidation by date alone still compresses first

## Task analysis

Analysed 2026-11-11 against `main` at `14df96544` (first analysed 2026-11-05 against `0194a0675`).

### Tasks

1. **Decide what an `If-Modified-Since`-only revalidation should do**: it still runs the on-the-fly compression before its 304. Status: open (decided and pinned by tests on 2026-11-11, and Chromium never takes the path; WebKit, the engine of the iOS app and Safari, still needs observing on macOS before this file is deleted).

### 1. Decide what an `If-Modified-Since`-only revalidation should do

**Problem.** Batch E24 (GW-15) made a matching `If-None-Match` on a static file with no precompressed sibling answer 304 with no compression. A request with `If-Modified-Since` and no `If-None-Match` still compresses the file, throws the result away and answers 304 (`serveStatic` in `apps/backend/src/gateway-proxy.ts`).

**Context.** Every static response carries an ETag and a `Last-Modified`, and a browser that has both sends both, so this needs a client that keeps only the date. The cost is bounded by `MAX_STATIC_FALLBACK_SOURCE_BYTES` and the fallback's concurrency limit, and the on-the-fly path applies only to files with no precompressed sibling. The clients we ship are the desktop app (Electron, so Chromium), the iOS app (a `WKWebView`, so WebKit) and whatever browser a user points at the gateway. The iOS app's own top-level loads use `.reloadIgnoringLocalAndRemoteCacheData` with `Cache-Control: no-store` (`apps/ios/OrkestratorMobile/Views/RemoteWebView.swift`), so they send no validator at all; its subresources go through WebKit's ordinary cache.

**Investigation.** A tag says which variant the client holds, so the 304's `Content-Encoding` can be taken from it. A date says nothing about the variant. The 304 describes the coding this request's compression chose, which is not necessarily what the client stored, for example after an earlier decline.

- 2026-11-11, beelink2 (Linux): `apps/backend/scripts/static-revalidation-probe.ts` runs the real gateway with `compression: "body"` and a renderer root whose script and stylesheet have no precompressed sibling, behind a recording proxy, and drives each Playwright engine through a first load, a reload, a second navigation and two `fetch()` modes. Chromium 158.0.8127.18 (Playwright 1.65.0): 11 requests, 8 revalidations, every one with both `If-None-Match` and `If-Modified-Since`, 0 date-only; every 304 named `br`, the coding of the 200 it revalidated.
- WebKit and Firefox did not launch on this host: Playwright's WebKit needs Ubuntu's ICU 74, libxml2 and WPE libraries, which this Arch host lacks and an agent cannot install without root, and Playwright's Firefox build is not downloaded here. Firefox is not an engine we ship.
- `apps/backend/tests/gateway-static-revalidation.test.ts` ("revalidating a static file by date alone") now pins the kept behaviour: a date-only 304 carries the `Vary`, `Content-Encoding`, `ETag` and `Last-Modified` a 200 would send now and costs one compression; it names this request's coding, not one held from an earlier answer; a date is ignored when a tag is sent; an older date gets the body.

**Decisions.**

- **What to do with a date-only revalidation?**
  - **Leave it, and close this to-do if no client we ship sends a date without a tag (recommended; taken 2026-11-11).**
    - Pros: no change for a path browsers do not take; the answer keeps describing what a 200 would send now.
    - Cons: a client that does take this path pays one compression per revalidation.
  - **Answer before compressing, with the first-choice coding's tag and headers.**
    - Pros: no compression on this path either.
    - Cons: for a file where compressing does not help, the 304 names a coding no 200 would send, and a cache that copies that field onto its stored identity copy could then misdecode it.
  - **Answer before compressing, naming no coding.**
    - Pros: cannot mislabel a stored copy.
    - Cons: RFC 9110 requires a 304 to carry the ETag a 200 would have sent, and which tag that is depends on compressing.
- **How to observe WebKit?**
  - **An agent on macOS runs `mise exec -- bun apps/backend/scripts/static-revalidation-probe.ts --engines webkit`, where Playwright's WebKit runs natively (recommended).**
    - Pros: the same probe and the same gateway as the Chromium run; no person needed.
    - Cons: needs a Mac agent; Playwright's WebKit is close to, not identical with, the system `WKWebView`.
  - **Run WebKit in a Linux container with Playwright's dependencies.**
    - Pros: possible on a Linux host with Docker access.
    - Cons: beelink2's account cannot reach the host Docker daemon, and the disposable daemon has no image to start from; an extra image to keep current.

## Current state

The code is unchanged by decision and the kept behaviour is tested. If the macOS run shows WebKit with 0 date-only revalidations, record it in the Investigation and delete this file with its index row and links. If WebKit does send a date alone, reopen the decision above with that evidence.

## Assumptions and decisions

### Task 1: kept the compression on the date-only path

Chose the recommended option. The Chromium probe found no date-only revalidation, and the alternatives either name a coding a 200 would not send or omit the tag RFC 9110 requires. Added tests so a later change to this path is deliberate.

### Task 1: committed the probe instead of a one-off script

The WebKit half has to run on another machine, so the probe lives in `apps/backend/scripts/` beside the gateway's other measurement scripts. It prints only paths, statuses, codings and which validators were present, never the gateway token.

## Related

- Closing check of E24 (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`), where this was left.
- to-do 1202 task 11 (retired 2026-11-10).

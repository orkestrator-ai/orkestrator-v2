# Cross-service reads on private preview origins

Checked against `main` at `06297124` (2026-10-23).

Found by the hostile service-worker run of 2026-10-22 (evidence log of
[0042-service-preview-rollout.md](0042-service-preview-rollout.md)). Script on
one published service (a page or its service worker) could send a credentialed
`GET` to a sibling service's host, and the backend forwarded it to the sibling
application with the user's session. The script could not read the response
(opaque, or a CORS failure), and writes were refused. That contradicted the
threat model's "application code is untrusted relative to other services"
for blind reads, and the qualification's "no other service is ever reached".
Publication is off by default and a per-deployment opt-in, so only operators
who enabled private origins were exposed.

The read policy is implemented and browser-tested in Chromium, Firefox and
Playwright WebKit (2026-10-23). A live Tailscale Serve probe preserves its
metadata headers. Shipping Safari/iOS and full wildcard-DNS deployments
through `publicPort` remain unqualified.

## Current state

- Each published service has its own host under one preview domain
  (`s-…<domain>`), so all services are same-site. Their host-only
  `__Host-orkestrator-preview` cookies are `SameSite=Lax`, so the browser
  attaches service B's cookie to a subresource request from service A.
- `crossSiteViolation` (`packages/protocol/src/preview-header-policy.ts`),
  used by `PreviewPublicationManager` (`apps/backend/src/preview-publication.ts`),
  still checks writes and upgrades exactly as before. For `GET`, `HEAD` and
  `OPTIONS` it now calls `crossServiceReadViolation`:
  - `Sec-Fetch-Site: same-origin` or `none` passes.
  - Any other `Sec-Fetch-Site` passes only with `Sec-Fetch-Mode: navigate`,
    `Sec-Fetch-Dest: document` and no `Sec-Purpose: prefetch`. Fetches,
    images, scripts, frames, objects, workers, prefetch and prerender are
    refused with `403` before forwarding and count as
    `http.rejected{forbidden}`.
  - Without `Sec-Fetch-Site`, a foreign or duplicated `Origin` is refused
    (browsers send `Origin` on a `GET` only for CORS and WebSocket requests);
    no `Origin` or the service's own passes.
- The check runs after the session cookie is authenticated, so it only ever
  applies to cookie-authenticated requests. The sign-in path
  (`/__orkestrator_preview/session`) is answered before it and is unaffected.
- The refusal page now says that only the preview itself can send writes or
  embedded requests, and that links from elsewhere still open it.
- The desktop tunnel is not affected: its partitions are per service and the
  ingress credential is injected only for the service's own origin.
- Documented in [browser-previews.md](../../architecture/browser-previews.md)
  ("Private HTTPS origins", "Security boundaries", "Framework configuration",
  "Known limitations").

## Outstanding work

### Code

1. Done 2026-10-23: read policy for cookie-authenticated requests on private
   origins. Chose Fetch Metadata refusal of non-navigation requests from
   other sites and services (see **Assumptions and decisions**).
   - Unit: `packages/protocol/src/node/preview-forward.test.ts`
     ("cross-service reads pass only as top-level document navigations",
     plus a write check under `same-site`) and
     `apps/backend/src/preview-publication.test.ts` ("cross-service
     subresource reads are refused before forwarding; links still open").
   - Real Chromium: the hostile-worker spec's sibling assertion now expects
     nothing to reach the sibling, and a new case covers a fetch, an image
     and a frame from one service to its sibling (all refused, three
     `forbidden` rejections, nothing forwarded) and a top-level link between
     them (opens the sibling signed in).

### Qualification

- Done 2026-10-23: Chromium, Firefox and WebKit projects in
  `e2e/preview/playwright.preview.config.ts`, including sibling reads and the
  hostile worker. A browser-local proxy maps only the harness's test hosts
  to loopback without changing URLs, Fetch Metadata, system DNS or trust.
  Chromium pins the test certificate; Firefox/WebKit bypass certificate
  checks in throwaway contexts only.
- Done 2026-10-23: direct same-origin iframe, external identity-provider
  redirect back into that iframe, and top-level return through the same
  redirect. Chromium returns `403` with cross-site/iframe metadata and the
  session cookie; Firefox/WebKit omit the cookie and return `401` earlier.
  Neither rejected return reaches the application; each increments
  `http.rejected{forbidden}`. Direct frames and top-level returns work.
- Done 2026-10-23: live Tailscale Serve metadata transport test,
  `apps/backend/src/tailscale-serve-metadata.test.ts`. See **Evidence**.
- Open: shipping Safari and iOS, including private-browsing behavior, and
  full browser publication through real wildcard DNS/certificates and
  `publicPort`. Playwright WebKit is early engine signal, not Safari/iOS
  qualification. Follow 0042's platform and deployment gates.

## Evidence

- Review follow-up, 2026-10-23, macOS 27.0, Playwright 1.64.0:
  `mise run test:logged -- --name preview-browser-cross-engine -- mise run
  test:preview:browser` passed (80.8 s): 24 passed, 3 skipped (Vite HMR,
  fixture unset), eight cases each in Chromium 156.0.8078.4, Firefox 157.0
  and Playwright WebKit 27.2. WebKit blocks the worker's HTTPS-to-HTTP
  gateway probes before they reach the gateway; all six attempts fail and
  zero gateway requests arrive. Chromium/Firefox reach the gateway without
  credentials and are refused there. No sibling request is forwarded in any
  engine. An explicit fixture data-URL icon prevents delayed browser favicon
  loads from contaminating the "nothing forwarded" snapshots.
- Follow-up validation: `mise run check`, focused protocol forwarding (32
  cases), publication (13 cases), preview spec loading and the final iframe
  regression in all three engines passed. `mise run test` exited 1 after
  938.4 s: root/support, bridge and protocol groups passed; the backend had
  9553 passed, 61 skipped and one recurring-baseline timeout. Its unchanged
  owning file also timed out alone (4 passed, 1 failed). Latest observation
  remains unresolved in existing case
  [0177](../../tests/flaky-tests/native-agents-and-transcripts/0177-driven-observation-baseline-timeout.md),
  with exact commands and compressed failure artifacts. No baseline timeout
  or assertion was changed. Docker, native Electron, iOS and published-CLI
  scenario suites were omitted because this follow-up changes preview
  documentation and test infrastructure.
- Final verification after merging `origin/main` (`cda435fc9`), 2026-10-23:
  `mise run test:preview:browser` 24 passed, 3 skipped (Vite) in Chromium,
  Firefox and WebKit; focused protocol, publication, spec-loading, flake
  index and mise-task tests, `format:check`, `lint` and `typecheck` passed.
  `mise run test` (511.5 s) failed only in
  `content-server.engines.test.ts` ("executable document policy in firefox >
  popups, new-window links and top navigation reach the sink zero times"):
  installing Playwright Firefox for this suite enabled that previously
  skipped engine, and Firefox's late `GET /favicon.ico` from a control page
  that really navigates to the sink reached the next observation (every
  restricted path stayed at zero hits). It failed alone 2 of 2. The sink page
  now declares a `data:` icon, so no sink document requests one; no
  assertion changed. The owner then passed alone 3 of 3 (94 to 100 s).
  A last `mise run test` (398.0 s) passed that owner in the suite and
  failed only in unrelated owners: the backend command-registry rename and
  backoff cases and a Pi preflight-cancel case. Each complete owner passed
  alone, so they are recorded as flakes in
  [0696](../../tests/flaky-tests/aggregate-validation-runs/0696-cross-service-reads-validation.md).
- Live transport, Tailscale Serve 1.102.4 on the same host:
  `ORKESTRATOR_TEST_TAILSCALE_SERVE_METADATA=1 mise run test:logged --
  --name tailscale-metadata-live-final -- bun test --cwd apps/backend
  ./src/tailscale-serve-metadata.test.ts --parallel=1` passed (one test,
  eight requests, 16 assertions). All three `Sec-Fetch-*` fields and
  `Sec-Purpose` arrived unchanged, including prefetch/prerender; the received
  metadata produced the expected read-policy verdicts. TLS certificate
  verification stayed enabled on the client. A temporary, tailnet-only
  HTTPS listener on unused port 18443 forwarded to a synthetic loopback
  receiver; teardown removed it and left existing listeners intact. No
  production backend, credentials, wildcard DNS or trust-store edits used.
- 2026-10-23, macOS, Playwright 1.64.0, Chromium 156.0.8078.4:
  `mise run test:logged -- --name preview-browser -- mise run
  test:preview:browser` passed. With the list reporter: 7 passed, 1 skipped
  (Vite HMR, `ORKESTRATOR_TEST_PREVIEW_VITE_DIR` unset).
- Negative check, same run: with the safe-method branch temporarily set
  back to `return false`, the new sibling case and the hostile-worker case
  both failed on their "nothing reached the sibling" assertions (44 and 9
  unexpected request records). Restoring the branch made them pass.
- `bun test src/node/preview-forward.test.ts` in `packages/protocol`: 32
  pass. `bun test src/preview-publication.test.ts` in `apps/backend`: 13
  pass.
- `mise run format:check`, `mise run lint` and `mise run typecheck` passed.
  `mise run test` (803 s, host load 42 to 75) failed only in owners that do
  not import the changed code (environment move, coordinator fixture digest,
  Codex delayed retry); each passed when rerun alone. Recorded as
  [0696](../../tests/flaky-tests/aggregate-validation-runs/0696-cross-service-reads-validation.md).
- Tailscale Serve, source only (not a live run): in `tailscale/tailscale`
  `main` at `f8ad538a`, `ipn/ipnlocal/serve.go` proxies through
  `httputil.ReverseProxy` with a `Rewrite` that sets `X-Forwarded-Host`,
  `X-Forwarded-Proto` and `X-Forwarded-For` and replaces the
  `Tailscale-User-*`, `Tailscale-Funnel-Request`, `Tailscale-Headers-Info`
  and app-capability headers. Nothing removes `Sec-Fetch-*` or
  `Sec-Purpose`, and Go's proxy drops only hop-by-hop headers.

## Constraints and rationale

- Never weaken the write and upgrade checks while changing reads. The write
  branch is unchanged; a unit test pins that `same-site` writes are still
  refused.
- The policy must fail open to the old behaviour, never closed, when
  metadata is missing: browsers without Fetch Metadata and non-browser
  clients keep working, and only CORS reads (which carry `Origin`) are
  refused for them.

## Open questions

- Do real projects publish a frontend and its API as two services and rely on
  cookie-authenticated cross-service reads? Not answerable from this
  repository. Such a pair could already not write (writes were refused) or
  send a bearer token (its CORS preflight carries no cookie and gets `401`),
  so only simple credentialed reads ever worked. The documented path is to
  proxy the API through the frontend's dev server. If users report breakage,
  revisit the per-deployment opt-out rejected below.

## Needs verification

- Shipping Safari and iOS, with their actual privacy settings and certificate
  trust; Playwright WebKit does not close this gate.
- Full browser traffic through a wildcard-DNS Tailscale Serve deployment
  (`publicPort`). Header preservation itself passed the live synthetic probe
  in **Evidence**; DNS, preview Host routing, TLS renewal and session handling across
  that deployment are separate. Batch them with 0042's "Real private DNS and
  certificates" run. From an authenticated service page, send a sibling
  `fetch(url, { credentials: "include", mode: "no-cors" })`, image and frame;
  confirm each receives `403`, adds a `http.rejected{forbidden}` and never
  reaches the sibling. Follow with a top-level link and verify it opens.
  Exercise speculation with `Sec-Purpose: prefetch` and `prefetch;prerender`
  where the browser supports it. Record the browser and Serve versions;
  do not infer support from an opaque fetch result alone.

## Assumptions and decisions

### Read policy: refuse non-navigation requests from other sites and services

- **Options considered**:
  1. Refuse a cookie-authenticated request when `Sec-Fetch-Site` is
     `same-site` or `cross-site` and it is not a navigation.
  2. Make the preview cookie `SameSite=Strict`.
  3. Keep forwarding and document that mutually untrusted services need
     separate preview domains.
  4. Option 1 plus a per-deployment setting that allows cross-service reads.
- **Choice**: option 1, narrowed to top-level document navigations
  (`Sec-Fetch-Mode: navigate` and `Sec-Fetch-Dest: document`) that are not
  prefetches, with an `Origin` fallback when Fetch Metadata is absent.
- **Why**: it closes the reachable blind read with one header check on the
  existing refusal path and keeps every flow the product uses: links between
  services, the bootstrap redirect chain (`cross-site` navigate document),
  the iOS handoff opened in Safari (`none`), and each service's traffic that
  remains `same-origin`. A same-service iframe return through an external identity provider is an exception: the
  redirect chain can make it `cross-site`, so it is refused.
- **Pros**: no cookie, sign-in or client change; refused requests never
  reach the application; same metric as other refusals; Chromium-verified
  with a negative check.
- **Cons**: browsers without Fetch Metadata keep the blind `no-cors` read;
  a sibling can still navigate the top-level window to another service
  (visible to the user, the same as a link); a frontend that fetches,
  embeds or loads assets from a sibling service stops working and must
  proxy through its own dev server.
- **Rejected**: option 2 also drops the cookie on top-level navigations from
  other sites, including the final hop of the bootstrap redirect chain (the
  chain starts on the Orkestrator client), so sign-in and every outside
  link would land unauthenticated. Option 3 leaves the stated threat model
  false by default for every operator who publishes more than one service.
  Option 4 adds a setting and its UI for a need nobody has reported; it can
  be added later if the open question turns up real users.

### Frames count as embedded requests, not navigations

- **Options considered**: allow every `Sec-Fetch-Mode: navigate` (frames,
  objects and embeds included), or allow only `Sec-Fetch-Dest: document`.
- **Choice**: `document` only.
- **Why**: a hidden same-site frame is a blind credentialed `GET` the user
  never sees, which is exactly the exposure being closed.
- **Pros**: no invisible cross-service loads at all.
- **Cons**: one service cannot frame another. A service's own hidden iframe
  also cannot return through an external identity provider when the redirect
  chain makes the request `cross-site`; this breaks iframe-based OIDC silent
  renewal. Use refresh tokens, popup or top-level redirect renewal instead.
  Allowing cross-site `navigate` + `iframe` would let siblings bypass the
  frame restriction with an external redirect, so no exception is added.
  Embedded previews in the web client ([0046-embedded-service-previews.md](0046-embedded-service-previews.md))
  will need their own rule; they are cross-site, so the `SameSite=Lax`
  cookie is not sent to them anyway.

### Prefetch and prerender are refused

- **Options considered**: treat speculative navigations like real ones, or
  refuse them by `Sec-Purpose: prefetch`.
- **Choice**: refuse.
- **Why**: a speculation-rules prefetch is a document navigation the user
  never sees. When it fails the browser falls back to an ordinary
  navigation, so nothing visible breaks.
- **Pros**: closes the last invisible navigation path.
- **Cons**: links between services lose prefetch speed-ups.

### Missing Fetch Metadata fails open, with an `Origin` fallback

- **Options considered**: refuse requests without `Sec-Fetch-Site`, allow
  them, or allow them unless they carry a foreign `Origin`.
- **Choice**: allow unless a foreign or duplicated `Origin` is present.
- **Why**: refusing would break old browsers, non-browser clients and any
  forwarder that strips the headers. A `GET` with an `Origin` is always a
  CORS or WebSocket request, so refusing a foreign one costs nothing
  legitimate. Fetch Metadata is checked first, so a browser that sends it is
  never judged by `Origin`.
- **Pros**: preserves clients that send no metadata; still refuses CORS
  reads from old browsers.
- **Cons**: blind `no-cors` reads from browsers without Fetch Metadata still
  reach the sibling.

### Assumptions

- Browsers set `Sec-Fetch-*` and `Sec-Purpose` themselves; page script
  cannot set or override them (they are forbidden request headers).
- Fetch Metadata is sent by Chromium 76+, Firefox 90+ and Safari 16.4+.
  Observed here in Chromium 156, Firefox 157 and Playwright WebKit 27.2.
- The bootstrap chain starts on the Orkestrator client (desktop loopback
  handoff page or web client form), so its last hop is a `cross-site`
  document navigation; the iOS handoff URL opens with `Sec-Fetch-Site: none`.

## Related

- [0042-service-preview-rollout.md](0042-service-preview-rollout.md) (hostile
  service worker qualification, evidence log; Firefox, Safari and real
  private DNS runs).
- [0046-embedded-service-previews.md](0046-embedded-service-previews.md)
  (embedded previews will need their own frame rule).
- [browser-previews.md](../../architecture/browser-previews.md) §"Security
  boundaries".

## Replaces

Nothing; new on 2026-10-22.

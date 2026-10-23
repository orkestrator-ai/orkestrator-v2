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

The read policy is now implemented (2026-10-23). What remains is running it in
other browsers and through a real Tailscale Serve forwarder.

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

- Done 2026-10-23 in Chromium: `mise run test:preview:browser` after the
  change. See **Evidence**.
- Open: the same two cases ("sibling services cannot read each other in the
  background; links between them still open" and the hostile worker) in
  Firefox and Safari, when those runs happen
  ([0042-service-preview-rollout.md](0042-service-preview-rollout.md),
  "Firefox, Safari and iOS"). The spec launches Chromium only, so the run
  needs either those browsers driven by hand or Playwright projects for
  them (item 3 of 0042's local work). Both browsers have sent Fetch Metadata
  since Firefox 90 and Safari 16.4, so the same result is expected; it has
  not been observed.

## Evidence

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

- Whether `Sec-Fetch-*` metadata reaches the backend unchanged through a
  real Tailscale Serve forwarder (`publicPort`). The source says it does
  (see **Evidence**). Not run live: it needs `tailscale serve` turned on for
  the preview listener on a signed-in tailnet node, which changes that
  node's tailnet configuration, and a real private DNS name and certificate.
  Batch it with 0042's "Real private DNS and certificates" run. To check,
  open a sibling's `/echo` from a service page with
  `fetch(url, { credentials: "include", mode: "no-cors" })` and confirm a
  `403` and a new `http.rejected{forbidden}`. If the forwarder strips the
  headers, the read policy falls back to the `Origin` check and blind
  `no-cors` reads reach the sibling again; links still work.

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
  the iOS handoff opened in Safari (`none`), and each service's own traffic
  (`same-origin`).
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
- **Cons**: one service cannot frame another. Embedded previews in the web
  client ([0046-embedded-service-previews.md](0046-embedded-service-previews.md))
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
- **Pros**: never breaks a working flow; still refuses CORS reads from old
  browsers.
- **Cons**: blind `no-cors` reads from browsers without Fetch Metadata still
  reach the sibling.

### Assumptions

- Browsers set `Sec-Fetch-*` and `Sec-Purpose` themselves; page script
  cannot set or override them (they are forbidden request headers).
- Fetch Metadata is sent by Chromium 76+, Firefox 90+ and Safari 16.4+.
  Observed here only in Chromium 156.
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

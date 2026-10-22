# Cross-service reads on private preview origins

Checked against `main` at `b83ae534` (2026-10-22).

Found by the hostile service-worker run of 2026-10-22 (evidence log of
[0042-service-preview-rollout.md](0042-service-preview-rollout.md)). Script on
one published service (a page or its service worker) can send a credentialed
`GET` to a sibling service's host, and the backend forwards it to the sibling
application with the user's session. The script cannot read the response
(opaque, or a CORS failure), and writes are refused. That contradicts the
threat model's "application code is untrusted relative to other services"
for blind reads, and the qualification's "no other service is ever reached".
Publication is off by default and a per-deployment opt-in, so only operators
who enabled private origins are exposed.

## Current state

- Each published service has its own host under one preview domain
  (`s-…<domain>`), so all services are same-site. Their host-only
  `__Host-orkestrator-preview` cookies are `SameSite=Lax`, so the browser
  attaches service B's cookie to a subresource request from service A.
- `crossSiteViolation` (`packages/protocol/src/preview-header-policy.ts`),
  used by `PreviewPublication` (`apps/backend/src/preview-publication.ts`),
  checks only writes and WebSocket upgrades: `GET`, `HEAD` and `OPTIONS`
  return `false` before `Origin` or `Sec-Fetch-Site` is looked at.
- Observed in real Chromium 156 (`e2e/preview/private-origin.spec.ts`, "a
  hostile service worker blocks re-sign-in…"): a `no-cors` credentialed
  `GET /echo` from service A's worker reached service B's application; the
  credentialed `POST` and a CORS bearer request were refused before
  forwarding. The test asserts that observed read so a change shows up.
- The desktop tunnel is not affected: its partitions are per service and the
  ingress credential is injected only for the service's own origin.

## Outstanding work

### Code

1. Decide and implement the read policy for cookie-authenticated requests on
   private origins. Options:
   - Refuse a request authenticated by the preview cookie when
     `Sec-Fetch-Site` is `same-site` or `cross-site` and `Sec-Fetch-Mode` is
     not `navigate`. Top-level links between services keep working; a
     frontend service fetching another service's API with the user's cookie
     stops working (its writes are already refused today).
   - Make the preview cookie `SameSite=Strict`. That also drops it on
     top-level navigations from another site, so every link from outside
     (including the bootstrap redirect chain) would need re-checking.
   - Keep forwarding and document that mutually untrusted services need
     separate preview domains (as already said for parent-domain cookies).
   Whatever is chosen, keep the hostile-worker spec's sibling assertion in
   step with it and update the limitation in
   [browser-previews.md](../../architecture/browser-previews.md).

### Qualification

- Re-run `mise run test:preview:browser` after the change, and the same
  case in Firefox and Safari when those runs happen
  ([0042-service-preview-rollout.md](0042-service-preview-rollout.md),
  "Firefox, Safari and iOS").

## Constraints and rationale

- Not changed in the run that found it: it alters what applications on
  published previews can do across services, in a security path, so it needs
  its own reviewed change and a decision on the option above.
- Never weaken the write and upgrade checks while doing this.

## Open questions

- Do real projects publish a frontend and its API as two services and rely on
  cookie-authenticated cross-service reads?

## Needs verification

- Whether `Sec-Fetch-*` metadata reaches the backend unchanged through a
  Tailscale Serve forwarder (`publicPort`).

## Related

- [0042-service-preview-rollout.md](0042-service-preview-rollout.md) (hostile
  service worker qualification, evidence log).
- [browser-previews.md](../../architecture/browser-previews.md) §"Security
  boundaries".

## Replaces

Nothing; new on 2026-10-22.

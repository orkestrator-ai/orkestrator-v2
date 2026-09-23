# 10 — Publish isolated private HTTPS origins

Status: Not started. Depends on: 01, 05–07. Unlocks: 11.

## Outcome and owners

Expose a selected registered service at a private HTTPS origin usable by normal
browsers, without requiring Electron hooks or path rewriting. Use the proven
step-01 DNS/TLS/bootstrap design. This step is required for cross-client browser
support and can follow the desktop delivery independently.

Integrate [Tailscale Serve](../../../../apps/backend/src/tailscale-serve.ts),
[managed web access](../../../../apps/backend/src/managed-web-client.ts),
[desktop web client controls](../../../../apps/desktop/electron/web-client-controller.ts),
and [web client contracts](../../../../packages/protocol/src/web-client.ts).
Add a proposed publication manager; do not make the UI launch/own DNS or listener
processes directly.

## Publication contract

Persist desired publication settings separately from runtime certificate,
listener, and health status. A service's public origin maps to its stable ID;
generation changes revoke access and reconnect to the new endpoint only after
resolution. Never reuse an old published hostname for a different service while
its cookies/workers/grants could still be associated with the old owner.

The publication descriptor should report:

- Service and backend identity, effective HTTPS origin, and intended audience.
- DNS/TLS/listener readiness with safe failure categories and retry advice.
- Supported top-level/embedded modes and bootstrap method.
- Stable public-origin behavior across restart and explicit expiry/removal.

Certificates/private keys/provider credentials remain in backend-owned protected
storage, not registry events or frontend settings snapshots.

## DNS and TLS tasks

1. Implement the selected provisioning adapter, with a documented operator setup
   and verification command. Do not assume wildcard `<service>.<machine>.ts.net`
   works because the backend machine's Tailscale HTTPS name works.
2. Bind routing only on intended private interfaces/Serve configuration. Never
   enable Funnel or add public ingress as an implementation shortcut.
3. Validate the relationship between DNS name, certificate coverage, listener,
   and service mapping. Reject unrecognized Host values even if DNS happens to
   resolve them to the same address.
4. Implement certificate renewal, failure reporting, and reload without losing
   unrelated gateway listeners. A certificate failure disables publication,
   not local backend control or unrelated services.
5. Reconcile desired versus observed publication after restart and Tailscale
   reconnect. Preserve unrelated user-managed Serve entries; no global reset.
6. Remove only owned routes/listeners/cert artifacts when publication is disabled.
   Registration and development-server processes remain intact.

If the installation lacks a supported private-origin provider, advertise that
browser publication is unavailable and keep desktop transport working. An
alternate HTTPS port on the control hostname is not an automatic substitute:
cookies ignore port boundaries.

## Control and application isolation

The preview listener must not serve `invoke`, gateway settings, agent bridges,
or the Orkestrator renderer. Reject privileged control paths or treat them as
ordinary application paths only on an entirely separate listener with no control
dispatch. Resolve exact authority to service before applying app routing.

Do not share control-app cookies with preview hosts. Enforce the step-01 cookie
domain policy for both server-set and script-set cookie threats. If using sibling
hosts, test parent-domain cookie injection and duplicate-cookie ambiguity. A
hostname wildcard is not automatically a safe multi-tenant cookie boundary.

Keep bootstrap/control handoff outside application service-worker authority.
Honor app CSP and framing headers on ordinary responses. Set the bootstrap's
own strict headers, no-store behavior, and allowed redirect destination. App
assets should not be globally no-store solely because transport authentication
exists; test caches and revocation with the defined delivered-data limitation.

## Origin-aware application behavior

Return a stable public base URL to the trusted configuration UI. Provide a
per-framework setup hint for allowed hosts, public API origin, WebSocket origin,
and OAuth callback URLs, based on the fixture's installed version. Do not edit
project configuration or relax allowed-hosts automatically.

Map same-service private redirects to the public origin under a narrow rule.
Application requests to another service require that service's own registration
and auth/CORS design, or a user-configured same-origin app proxy. Do not allow
a preview to mint credentials for other services merely by constructing a URL.

## Tests and completion

Use real trusted test certificates and private DNS/reachability checks from a
second machine. Verify HTTP, HMR, app WS, streaming, app auth, and secure cookies
through the published origin. Include renewal, expired cert, hostname mismatch,
DNS failure, unknown Host, Serve restart, route conflict, and revoked service.

Verify a service cannot access control endpoints or another service's storage
and sessions. Test existing app workers during rebootstrap and generation change.
Confirm unrelated Serve configuration survives enable/disable/recovery.

Exit with reproducible operator setup, automated ownership-aware cleanup, and
publication capability gated on actual readiness. Record supported deployment
providers/platforms; untested DNS/TLS arrangements remain unsupported.

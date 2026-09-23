# 05 — Add scoped access, bootstrap, and revocation

Status: Not started. Depends on: 02–04 and the step-01 auth decision.
Unlocks: 06–08 and publication/bootstrap work.

## Outcome and ownership

A trusted client can authorize one registered service without exposing the
gateway token to application code or replacing application authentication.
Implement a proposed `PreviewAccessService` in backend core, with narrow gateway
adapters. Integrate existing token rotation in
[gateway base](../../../../apps/backend/src/gateway-base.ts),
[authentication](../../../../apps/backend/src/gateway-auth.ts), and the
[desktop connection manager](../../../../apps/desktop/electron/connection-manager.ts).

## Grant model

Mint cryptographically random opaque grants after the existing control API
authenticates the initiating client. Store only the verification material
needed by the server, with service ID, backend epoch, endpoint generation,
audience, attachment ID, expiry, and one-use state. Use the step-02 count/TTL
bounds; reject excess issuance and expire abandoned grants.

Audiences distinguish native tunnel establishment, trusted browser bootstrap,
and any native local-listener handoff. A grant for one audience cannot be used
as another. A service ID is an identifier, never access authority. Bind grants
to resolved endpoint identity; do not accept a destination URL in the handshake.

Consume bootstrap grants atomically. Concurrent exchanges yield one success.
Define response-loss behavior: obtain a fresh grant through the trusted client,
not unlimited replay of the old one. Reissuing transport access is distinct
from retrying an application request and never triggers the application turn
or request by itself.

## Desktop authentication path

Electron main obtains a scoped attachment through the authenticated connection
manager, retains its secret outside renderer/app contexts, and establishes WSS
using a dedicated transport credential. The outer tunnel handshake consumes
that credential; inner application HTTP retains its own Authorization.

At the client-local listener, main-process request interception supplies a
separate per-service ingress credential for permitted native HTTP and WS
requests. Strip that credential before sending application bytes through the
tunnel. Validate the actual requesting WebContents/session and service scope,
not just a URL prefix supplied by a page. Explicitly support upgrade requests;
do not assume the existing HTTP-only hook handles WS/WSS.

Prevent application requests from invoking privileged APIs or gaining another
service's credential. Do not expose transport grants through preload bridges,
page globals, annotations, returned DOM data, clipboard, or DevTools log output.
Document that a user debugging their own native session can inspect application
state; this is not a secrecy boundary against the workstation owner.

## Browser bootstrap/session path

Implement only the step-01 proven handoff. Its invariants are:

1. The trusted initiating client sends the one-use grant through a bounded POST
   or equivalently proven channel, with a fixed expected destination.
2. A trusted bootstrap authority validates the grant and establishes the
   service-scoped preview session before redirecting to a clean app URL.
3. The application origin cannot service-worker-intercept the credential
   exchange or forge a privileged bootstrap response. Validate this with an
   already-installed hostile worker, not only a fresh browser profile.
4. The final preview cookie is HttpOnly/Secure where applicable, host-scoped,
   limited by server-side expiry/revocation, and stripped on upstream forwarding.
   It does not authenticate control routes.
5. Application Authorization and non-transport cookies continue to reach the
   app. Reserved cookie names cannot be overwritten, shadowed through duplicate
   cookie fields, or accepted from upstream Set-Cookie.
6. Every control/preview origin and redirect destination is validated. No token
   or durable credential is placed in query strings or history.

If step 01 cannot prove bootstrap with worker and cookie isolation, keep browser
capability disabled. The desktop path can still proceed. Do not substitute the
global gateway cookie as a temporary browser-preview solution.

## Authorization and revocation

Validate service status, generation, audience, expiry, and revocation on HTTP
admission and WS/tunnel upgrade. Track active resources by attachment and
service generation so token rotation, service removal, environment stop, and
backend shutdown can close them. Reject new work immediately before cleanup
begins. Expiry timers are bounded and coalesced; shutdown is idempotent.

For cookie-based preview access, defend write requests and upgrades against
cross-site requests. Origin checks belong before forwarding. Do not globally
allow `Origin: null`, blindly trust forwarded headers, or strip Origin merely
to make framework checks disappear. Direct/native requests follow their own
authenticated ingress policy from step 01.

Lease renewal is a trusted-control action or a narrowly authenticated transport
operation with an absolute lifetime. Arbitrary preview-page traffic must not
extend access forever. Revocation prevents future server access; it cannot
erase page bytes already delivered to browser caches. Reset-site-data is a
separate user action.

## Tests and completion

Test forged/wrong-service/wrong-generation/wrong-audience grants, expired grants,
atomic one-use consumption, duplicate transport cookies, malicious Set-Cookie,
bootstrap redirects, worker interception, cross-site HTTP/WS attempts, and
grant limits. Assert no secrets in logs/errors/events/layout storage.

Rotate credentials with both active HTTP and upgraded sockets; verify denial of
new requests and closure of old resources. Simulate disconnect during bootstrap,
token rotation during admission, and process restart. Demonstrate bearer/basic
application auth survives to a fixture while transport auth does not.

Exit with authorization tests independent of UI and a written credential-flow
diagram matching actual code. Do not advertise browser support before its
real-browser bootstrap tests pass. Existing legacy route semantics remain
explicitly isolated from new scoped sessions.

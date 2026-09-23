# 01 — Set architecture decisions and fixture baselines

Status: Not started. Depends on: investigation. Unlocks: step 02.

## Outcome

Before building production transports, prove how one service is addressed,
authenticated, isolated, and revoked on desktop and in a normal browser. Turn
the uncertain points in the investigation into recorded decisions with concrete
fixture results. This step builds disposable prototypes and test fixtures;
it does not enable production preview routes.

## Existing owners to inspect

- [BrowserTab](../../../../apps/web/src/components/browser/BrowserTab.tsx),
  [address routing](../../../../apps/web/src/lib/browser-address.ts), and
  [native manager](../../../../apps/desktop/electron/browser-preview-manager.ts).
- [gateway proxy](../../../../apps/backend/src/gateway-proxy.ts),
  [gateway listener](../../../../apps/backend/src/gateway-base.ts), and
  [Electron credential hooks](../../../../apps/desktop/electron/remote-gateway-request-auth.ts).
- [window partitioning](../../../../apps/desktop/electron/desktop-window-lifecycle.ts),
  [Tailscale integration](../../../../apps/backend/src/tailscale-serve.ts), and
  [managed web client](../../../../apps/backend/src/managed-web-client.ts).
- [agent browser suite](../../../../e2e/agent-testing/browser-gateway.spec.ts)
  and [agent Electron suite](../../../../e2e/agent-testing/electron-main.spec.ts).

## Work

1. Capture the supported platform/version baseline: pinned Bun, Electron,
   operating systems, Docker Engine/Desktop, browser versions, and current iOS
   wrapper. Separate the application framework fixture versions from Orkestrator's
   own frontend dependencies.
2. Create an isolated fixture project with a tiny deterministic HTTP/WS server.
   It needs controlled endpoints for HTML, chunked HTML, cookies, bearer auth,
   redirects, a WS echo/subprotocol endpoint, a deliberately stalled response,
   and binary transfer. Keep fixture content synthetic.
3. Add a Vite fixture and one streaming/router framework fixture. Lock their
   versions. Give each an identifiable service marker so tests detect a wrong
   application rather than merely a successful HTTP response.
4. Run each fixture directly, through the current local preview, and through
   the existing gateway preview. Record baseline failures by finding ID F1–F8.
   Include a second machine; localhost-only tests cannot expose accidental
   client-local fallback.
5. Prototype one Electron-local HTTP listener per service attachment group,
   with an authenticated WSS connection to the backend that carries only the
   approved service's stream. Prove cancellation, root URLs, HMR, isolation,
   and bounded backpressure. Prototype code must not reach production startup.
6. Prototype one isolated HTTPS preview host with a one-use bootstrap exchange.
   Test a top-level browser before an iframe. Then test hosted-client embedding
   with third-party cookies blocked and actual Safari/WKWebView behavior.
7. Compare operational cost: DNS/cert provisioning, local listeners, socket
   counts, extra handshakes, reconnect behavior, and setup required from users.
   Choose the default/fallback order and record where HTTPS upstreams fit.

## Decisions to record before step 02

| Decision | Required answer |
| --- | --- |
| Desktop remote transport | Accept the scoped loopback/WSS prototype or name a proven replacement. No open-ended “choose a tunnel later.” |
| Browser origin authority | Who provisions hosts, TLS, renewals, and private routing? What happens if unavailable? |
| Cookie boundary | How control cookies and preview transport cookies remain safe from app script and sibling-service Domain cookies. |
| Worker boundary | How an application service worker cannot intercept or forge trusted bootstrap/control flows. |
| Bootstrap handoff | How a grant reaches a trusted endpoint without URL/history/referrer leakage, with no authenticated bridge exposed to app scripts. |
| Host/Origin policy | Whether upstream sees its private authority or the public preview authority; how framework host checks and WS Origin validation work. |
| TLS | Which ingress/egress combinations are supported and how certificates are verified. |
| Session persistence | Which partitions persist across restarts and when old service data is retired. |
| Sharing | Whether multiple tabs/windows share application login; how external-browser attachments expire. |
| Target scope | Definition of owned-container, registered-worktree, and explicit backend-host services. |

Treat application code as untrusted relative to Orkestrator control and other
environments. Same-service code can use the service it is previewing; it must
not gain control-API authority. Native Electron sessions help isolate browser
state but do not by themselves restrict every outbound network request.

Specific traps to resolve in the prototypes:

- A new bootstrap endpoint on an origin already controlled by an application
  service worker is not automatically trusted. Consider a dedicated bootstrap
  authority and one-use server-side handoff; test worker interception explicitly.
- Local loopback endpoints can be contacted by other local processes. Port
  secrecy is not authentication. Either require a scoped transport credential
  at the local HTTP/WS ingress or explicitly design an OS-local trust boundary;
  the default in this plan is credentialed ingress.
- Different port numbers do not isolate cookies. Parent-domain cookies from
  sibling hosts require a deliberate domain policy and transport-cookie parser.
- A raw stream tunnel must not place gateway credentials inside application
  HTTP bytes, and must not allow the client to pick arbitrary connect targets.
- Transparent proxying does not rewrite absolute application URLs. Document
  public-origin configuration and multi-service behavior instead of promising
  compatibility with every hardcoded localhost URL.

## Validation and completion

Produce a decision record beside the implementation, an executable fixture
inventory, and a result table for the two prototypes. Include incomplete
platforms as explicit rollout blockers, not inferred support. Record timings
as observations rather than performance promises.

Exit only when an implementer can draw the complete credential/data path and
identify who owns every socket, cookie, endpoint generation, and cleanup action.
Remove prototype listeners/processes, stop/reset isolated profiles, and retain
only scrubbed evidence. Failed prototypes are useful results; update the
dependent plan before proceeding rather than hiding them behind feature flags.

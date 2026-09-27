# Browser implementation plan

Status: Steps 01–13 are implemented behind disabled-by-default capabilities. Steps 14 and
15 are in progress. The single-machine gate passed; the rows in [evidence](evidence.md)
marked not run are still open. Prepared: 2026-09-21. Investigation baseline: `88c2f9cc`.
Implementation: branch `webbrowser-functionality-cfc4abe48d47-r1` (2026-09-23), not merged.

This plan turns the [investigation](../README.md) into individually reviewable
changes. It covers local worktrees, owned Docker containers, remote Orkestrator
backends, Electron, external browsers, and eventually embedded web/iOS clients.
The living product and operator documentation is
[browser-previews.md](../../../architecture/browser-previews.md). This directory
remains the execution history.

## Intended result

A user selects a service in an environment and gets the correct application,
including assets, navigation, login, streaming, and WebSockets. They do not need
to translate container ports into host ports. Returning to an inactive
environment, restarting a backend, or recreating a container restores the
correct service identity without following a stale port to another app.

The backend owns service definitions, endpoint generations, readiness, grants,
and remote/container transport. Electron owns native views, isolated browser
sessions, and any client-local transport. React displays reconciled snapshots.

## Numbered steps

Each step file records its commit and remaining evidence under
**Implementation record**. No step is merged into `main`.

| Step | Work | Depends on | Delivery group | Status |
| --- | --- | --- | --- | --- |
| [01](01-architecture-and-fixtures.md) | Set architecture decisions, threat boundaries, and fixture baselines | Investigation | Foundation | Done |
| [02](02-contracts-and-capabilities.md) | Define service contracts, limits, errors, and capability negotiation | 01 | Foundation | Implemented |
| [03](03-service-registry-and-lifecycle.md) | Build backend registry, persistence, lifecycle, and reconciliation | 02 | Foundation | Implemented |
| [04](04-target-resolution-and-readiness.md) | Resolve Docker/worktree targets and publish readiness | 03 | Foundation | Implemented; Docker Desktop not run |
| [05](05-scoped-authentication.md) | Implement scoped grants, sessions, revocation, and bootstrap | 02–04 | Transport | Implemented; Chromium only |
| [06](06-http-forwarding.md) | Implement complete streaming HTTP forwarding | 04–05 | Transport | Implemented |
| [07](07-websocket-and-tunnel-transport.md) | Implement application WebSockets and desktop tunnel transport | 04–06 | Transport | Implemented; two-machine not run |
| [08](08-electron-transport-and-isolation.md) | Integrate desktop endpoints, service partitions, and native lifecycle | 05–07 | Desktop | Implemented; real Electron window not run |
| [09](09-client-resolution-and-migration.md) | Migrate tabs and unify entry buttons, address input, and links | 03–04, 08 | Desktop | Implemented |
| [10](10-private-preview-origins.md) | Provision isolated private HTTPS preview origins | 01, 05–07 | Browser expansion | Implemented; real DNS/certs not run |
| [11](11-web-external-and-ios-clients.md) | Enable external browser, then supported embedded web/iOS modes | 09–10 | Browser expansion | Top-level only; embedded unadvertised |
| [12](12-service-controls-and-diagnostics.md) | Add service picker, registration, settings, and actionable diagnostics | 09; 11 for browser controls | Product completion | Implemented |
| [13](13-optional-container-relay.md) | Add an optional container-network relay for unpublished services | 04–07, 12 | Optional extension | Implemented, off by default |
| [14](14-system-validation-and-observability.md) | Complete cross-platform, failure, resource, and performance validation | Steps in the delivery group; 01–12 for full core, 13 if included | Release gate | In progress (single-machine gate passed) |
| [15](15-migration-rollout-and-operations.md) | Roll out capabilities, document operations, and prove rollback | Relevant 14 gate | Release gate | In progress (rollout not started) |

The numbering is the recommended integration order. A dependency means its
contract must be settled and its required implementation available before the
dependent behavior can ship. Work on fixtures and acceptance cases belongs in
each step, not just step 14. Step 13 is explicitly optional and must not delay
published-port support.

## Delivery decisions

Adopt these defaults, subject to the bounded feasibility work in step 01:

1. Keep `WebContentsView` and existing browser controls. Replace the fragile
   target/transport assumptions underneath them.
2. Keep the existing gateway path route for old clients and explicit
   compatibility mode. Do not extend regex rewriting into the main architecture.
3. Deliver a desktop path without mandatory new DNS infrastructure: a
   service-scoped loopback endpoint carried over an authenticated backend tunnel,
   isolated by Electron session. Prefer a validated dedicated preview origin
   when one is available.
4. For normal browsers, use HTTPS preview hosts separate from the control app.
   Do not claim that paths or alternate ports provide complete cookie isolation.
5. Keep preview traffic private to the existing backend/tailnet relationship.
   Do not add a public relay, Tailscale Funnel, or arbitrary remote-host proxy.
6. Require an Orkestrator backend on remote machines initially. Managed SSH
   forwarding and remote-rendered pixel streaming remain out of scope.
7. Target HTTP/1.1 application HTTP and WebSockets first. HTTPS upstreams require
   verified TLS and an explicit advertised capability. HTTP/2-specific features,
   HTTP/3, WebTransport, and generic UDP forwarding are not initial promises.

The desktop tunnel and hosted HTTP/WS route share service resolution and
authorization policy. They need not share their on-wire framing. Step 01 must
prove that these are maintainable adapters, rather than two inconsistent policy
implementations. If the desktop tunnel spike fails, record the replacement
decision before implementing steps 07–09.

## Shared terminology

| Term | Meaning |
| --- | --- |
| `serviceId` | Backend-issued stable identity for one registered application service. Never a host port or a credential. |
| `backendInstanceId` | Stable non-secret backend identity, independent of a client's saved connection label. |
| `backendEpoch` | Changes on backend restart; invalidates runtime endpoints, grants, and old event cursors. |
| `endpointGeneration` | Changes when a service's actual process/container/binding identity changes. |
| `registryRevision` | Monotonic ordering of registry updates within a backend epoch. |
| Definition | Durable desired service configuration. Does not contain resolved ephemeral addresses or credentials. |
| Snapshot | Current authoritative definition plus runtime readiness and endpoint metadata safe for the trusted client. |
| Attachment | A client/view/external-browser consumer's transport lifetime; separate from the application's lifetime. |
| Compatibility mode | Existing loopback path proxy or old-backend behavior, with its known limitations. |

Client `connectionId` remains a client routing key. Never use it as the backend's
authorization identity: different clients may name the same backend differently.

## Rules every step must preserve

- Environment/tab inactivity does not cancel application work. Unmount releases
  presentation subscriptions, not authoritative service state.
- Events supplement snapshots. Epoch/revision gaps, deletion, and expired
  cursors must be detectable. Subscribe before reconciling replay ranges.
- Preview credentials cannot invoke commands, choose arbitrary endpoints, or
  authorize another service. Application auth must remain application auth.
- No transparent retries of ambiguous HTTP writes or WebSocket messages.
- Every queue, replay ring, decoded request, rewritten response, and compression
  buffer has explicit byte/count bounds and an overload action.
- Asynchronous cleanup handles rejection. New long-lived entrypoints install
  the repository's fatal rejection guard and parent/lifecycle supervision.
- Logs and metrics exclude credentials, full URLs, queries, page/terminal/file
  contents, and attachments. Labels have bounded cardinality.
- Keep new modules focused; do not grow already large gateway/UI files into
  another monolith. Register commands through `createCommandRegistry()`.

## How to execute a step

Read its prerequisites and the current source first; paths identify owners at
the investigation baseline, not permission to overwrite unrelated work.
Proposed new module names are explicitly marked. Implement the smallest
reviewable slice, include meaningful tests for changed behavior, and record
evidence in the step's completion section. Use the repository's
[testing guide](../../../development/testing-guide.md),
[agent-testing guide](../../../development/agent-testing.md), and applicable
`AGENTS.md` instructions. Fetch current library documentation before introducing
version-specific API calls.

Use feature branches and PRs; leave merge into `main` to a human. A feature may
be available experimentally without a step being complete: distinguish code
merged, checks passed, real-stack evidence, and rollout enabled. Do not mark a
step complete while its mandatory acceptance cases remain untested.

Each step should eventually record: implementation PR/commit, selected design,
exact validation commands, pass/fail evidence, isolated-profile cleanup,
remaining limitations, and the feature/capability configuration exercised.

## Findings traced to implementation

| Investigation finding | Primary steps | Proof required |
| --- | --- | --- |
| F1 — Lost container/service identity | 02–04, 09 | Container terminal links and saved tabs follow the correct service after port reassignment. |
| F2 — Missing remote WebSockets | 05, 07–08, 10 | HMR and binary app sockets work remotely with scoped auth and bounded cleanup. |
| F3 — Path rewriting limitations | 06, 08, 10–11 | Full-origin fixtures pass root-path/router/assets/SRI cases without body rewriting. |
| F4 — Application authentication conflicts | 05–06, 10–11 | App auth survives; gateway auth does not leak; host-prefixed cookies remain valid. |
| F5 — Shared preview storage | 01, 08, 10–11 | Independent services cannot read or overwrite each other's intended browser state. |
| F6 — Creation-time container connectivity | 04, 12–13 | Published-port diagnosis works first; optional relay later reaches new/loopback-only services. |
| F7 — Buffering and lifetime bounds | 02, 06–07, 14 | Streaming begins early; stalled/slow connections cannot retain unbounded resources. |
| F8 — Weak service diagnostics | 03–04, 09, 12, 14 | Authoritative readiness and useful recovery survive inactive tabs and reload. |

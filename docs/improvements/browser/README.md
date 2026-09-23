# Browser preview improvements

Status: Investigation and proposal; implementation has not started.
Investigated: 2026-09-20–21, repository commit `88c2f9cc`.
Scope: displaying applications running in containers or on remote backend
machines, in Electron, web clients, and iOS. No application code was changed.

The largest improvement would be to make a preview a backend-owned service
with a stable identity and a complete HTTP/WebSocket transport. Today, a
browser tab stores a loopback URL, and remote previews load that URL through a
path-rewriting proxy. This handles basic pages, but does not reliably preserve
the networking, authentication, storage, or URL semantics of a web application.

Start with [current behavior and findings](current-state.md), then read the
[architecture proposal](proposal.md) and [delivery and validation plan](validation.md).

The detailed [implementation plan](plan/00-index.md) breaks the work into 15
numbered steps with dependencies, implementation tasks, acceptance tests,
migration rules, and rollout gates. All implementation steps remain unstarted.

| Priority | Improvement | Expected result |
| --- | --- | --- |
| P1 | Resolve previews by backend, environment, and service | Container links use the right mapped port; saved tabs survive mapping changes. |
| P1 | Add authenticated preview WebSocket forwarding | Remote HMR and application WebSockets work through the same connection as the page. |
| P1 | Separate preview authentication from application authentication | Applications retain their own bearer/basic authentication without receiving gateway credentials. |
| P1 | Establish preview origin and storage isolation | Independent apps do not share remote-origin storage; browser support can be enabled safely. |
| P1 | Add readiness diagnostics and bounded connection lifecycles | Distinguish an unmapped port, a stopped server, a bind-address issue, and a transport failure. |
| P2 | Offer full-origin previews and browser-safe bootstrap | Root paths, cookies, workers, streaming, and external-browser access become practical. |
| P2 | Discover and register multiple services | Frontend, API, and alternate development ports are accessible without guessing host ports. |
| P3 | Add an in-container relay for unpublished/loopback-only services | New services can be previewed without recreating a container. |

These priorities express recommended order, not accepted delivery commitments.
Origin/authentication design should be settled early even if the first release
retains the existing proxy. Do not enable browser/iOS previews simply by
removing the current availability check.

The investigation combines source inspection, passing focused existing tests,
and direct probes of the current rewrite/header helpers. It does **not** claim
end-to-end validation across Docker, remote Tailscale machines, Electron, or
Safari. Those acceptance scenarios are specified in the validation plan.

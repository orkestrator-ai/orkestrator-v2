# 04 — Resolve targets and report readiness

Status: Not started. Depends on: 03. Unlocks: 05 and client resolution.

## Outcome and owners

Map a stable service to a currently authorized endpoint on the backend machine.
Keep source-environment URL interpretation separate from client transport URL
construction. Suggested new modules: `preview-target-resolver.ts` and
`preview-readiness.ts` under backend core.

Integrate with [Docker port inspection](../../../../apps/backend/src/core/commands-container-exec.ts),
[container creation](../../../../apps/backend/src/core/commands-containers.ts),
[environment lifecycle](../../../../apps/backend/src/core/commands-environment.ts),
and [existing server health](../../../../apps/backend/src/core/commands-server-health.ts).
Do not reuse agent-specific bridge probes as generic application probes.

## Docker resolution

1. Read the service's owning environment from storage; obtain its current
   container ID through backend state, never from an untrusted request body.
2. Verify container ownership using the existing owner policy. Check running
   state and inspect the mapping for the precise application port/protocol.
3. Normalize IPv4/IPv6 binding results and select a reachable loopback binding.
   Report unsupported/multiple incompatible bindings explicitly rather than
   taking an arbitrary line from `docker port`.
4. Include container identity and mapping identity in endpoint generation logic.
   A registry definition survives recreation, but authorization to the previous
   container does not. Record the verified owner with the endpoint snapshot.
5. Return `target-unmapped` when there is no published port. The optional relay
   in step 13 will add another resolver adapter; do not silently connect to a
   similarly numbered host port as a fallback.
6. Coalesce inspect work across related services and cache only for a short,
   bounded period. Invalidate immediately on known lifecycle changes. Recheck
   generation before opening a socket; document residual external-Docker races.

A published port cannot prove which application inside the container is serving
it. The verified container is the initial ownership boundary. Track known
managed process identity if available, but do not claim cryptographic process
identity from a TCP handshake.

## Worktree and explicit host resolution

For managed local development processes, record the owning backend process
identity/start marker with registered port information. For user-started
processes, registration is an explicit association with an environment, not
proof of ownership. Mark it `user-registered` and explain that association in
diagnostics. Reject known reserved control/agent/Docker endpoints.

Resolve `localhost`, `127.0.0.1`, and `[::1]` deliberately. Carry address family
through to connect; do not accept IPv6 input and force IPv4 later. Initial
manual targets remain backend-loopback only. Remote hostnames are reached by
selecting a remote backend, not by passing arbitrary hosts into the resolver.

HTTPS registrations carry verification settings, including the expected server
name. Use trusted system/custom CA configuration or an explicit per-service
trust workflow if designed; never globally disable verification. Advertise
HTTPS only for transports that can preserve that verification model.

## URL-intent resolver

Accept either a service reference or a bounded intent containing source
environment, source kind, scheme/host/port/path. Terminal `localhost:3000` from
a container is interpreted as application port 3000 in that container. Manual
backend-port mode is distinct. An unregistered or ambiguous service produces a
choice/error, not a guess based on whichever service is active.

Reject embedded credentials, unsupported schemes, non-decimal/overflow ports,
control characters, and authority-changing path forms. Decode and canonicalize
once using documented rules. Preserve path/query/fragment for navigation but
exclude them from discovery logs, metrics, and health-probe labels.

## Readiness job

Use bounded, cancellable probes for successive layers:

| Layer | Observation | User action |
| --- | --- | --- |
| Environment | Stopped/missing/current generation | Start or select a valid environment |
| Binding | Published/relay available or absent | Configure mapping or use supported relay |
| TCP | Accepted/refused/timeout | Start app, inspect bind address, retry |
| TLS | Verified/failed | Fix certificate/hostname trust |
| HTTP | Response received, status class | Open app or resolve application auth |

Do not execute arbitrary health URLs copied from terminal output. Use a
configured safe path or a bounded TCP-only probe. HEAD may be unsupported;
fallback GET must be explicit, safe, body-limited, and not treated as harmless
for every application route. Treat 401/403/404 as reachable HTTP responses.

Probe on lifecycle/registration changes and explicit retry, with capped
exponential backoff while starting. Stop repetitive probing of unchanged idle
services; expose stale observation time and revalidate on attachment. Cancel
jobs on generation change. A failed probe must not stop the application's
process or trigger container recreation.

## Tests and acceptance

Use two owned containers both listening on 3000, with different ephemeral host
ports. Verify entry-port and terminal intent resolve each correctly. Occupy
host port 3000 with a decoy fixture and prove it is never selected implicitly.
Cover missing/stopped/foreign containers, multiple bindings, IPv6-only service,
TLS mismatch, managed/unmanaged worktrees, and changed container ID with reused
host port. Inject inspect timeouts and late probe completions.

Exercise the inactive-environment/reload path and verify all readiness layers
are available through snapshot commands alone. Acceptance requires correct
target identity, safe failure on ambiguity, bounded job counts, and no automatic
destructive actions. Linux Docker and Docker Desktop are separate evidence rows.

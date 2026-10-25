# Preview service discovery

Checked against `main` at `2459b05c` (2026-10-15).

Preview services are generated automatically only for containerized
environments, from the entry port and TCP port mappings. Local worktree and
backend-host services have to be registered by hand, and they are always
labelled `user-registered`. Several convenience paths from the plan were left
for later: local seeding, recording which process owns a server the backend
starts itself, agent links that open preview tabs, and copyable framework
setup hints. Each one lowers setup friction. None may weaken the rule that an
open port is never treated as proof of ownership.

## Current state

- `desiredGeneratedDefinitions` (`apps/backend/src/core/preview-service-registry.ts`)
  returns `[]` unless `environment.environmentType === "containerized"`. For
  containers it yields `environment.entryPort` and every `mapping:<port>` TCP
  mapping. For local environments, `getEnvironmentBrowserUrl`
  (`apps/web/src/lib/environment-address.ts`) also returns `null`, so the
  environment browser button (`environmentBrowserTarget`) opens nothing until
  the user registers a service.
- `PreviewTargetResolver` (`apps/backend/src/core/preview-target-resolver.ts`)
  resolves both `worktree` and `backend-host` targets through
  `resolveLoopback(definition, "user-registered")`. The protocol's
  `ownership: "managed-process"` (`PreviewEndpointSnapshot` in
  `packages/protocol/src/preview-services.ts`) is accepted by `resolveLoopback`
  but never produced.
- `linkBrowserTarget(environment, url, origin)`
  (`apps/web/src/lib/preview-service-entry.ts`) maps `origin: "agent"` to the
  `agent-link` intent source. Only the terminal calls it
  (`TerminalContainer.view.tsx`). Chat links in `MessageMarkdown.tsx` go to
  `openInBrowser` (the system browser), so agent output never opens a preview
  tab.
- Framework setup guidance (`X-Forwarded-Host`, public origin, OAuth redirect
  URIs) lives only in [browser-previews.md](../../architecture/browser-previews.md)
  §"Framework configuration". The UI shows target-kind hints
  (`TARGETS` in `apps/web/src/components/browser/PreviewServiceDialog.tsx`) and
  the `0.0.0.0` bind hint (`resolution.bindHint` in `ServiceBrowserTab.tsx`),
  nothing else.
- The resolver refuses Orkestrator's own ports (reserved through
  `PreviewRuntime.reservePorts`) and the in-container agent servers on
  4096–4101.

## Outstanding work

### Code

1. Local seeding. Local environments already carry `environment.entryPort`
   (copied from the repository config at creation), but every local
   environment of a project gets the same value, and they all share the
   backend host's loopback. A seeded `worktree` definition therefore cannot
   tell whose server is listening. Either seed it as `user-registered` and have
   diagnostics say that any process on that port will be shown, or wait for
   managed-process ownership (item 2) and seed only from that. Never seed from
   a port scan.
2. Managed-process ownership. For servers the backend starts itself, record
   the owning process identity and start marker with the registered port, so
   the resolver can report `managed-process`. Without that record an open port
   stays an unverified association, and diagnostics must say so.
3. Port increments. When a dev server moves to the next free port, update the
   registry explicitly: a terminal hint offers re-registration, and the user
   confirms. Never guess.
4. Agent links. If chat links gain an "open in browser tab" action, route
   loopback links through `linkBrowserTarget(environment, url, "agent")` so they
   resolve in the source environment like terminal links. Do not change the
   default behaviour of every chat link silently.
5. Optional framework setup hints in the service dialog or diagnostics. Make
   them version-aware and copyable (for example `X-Forwarded-Host` use, the
   public origin, and OAuth redirect URIs for the `s-<hash>` host). Never edit
   the user's project.

### Qualification

- With seeding or ownership in place: two local environments using the same
  dev port, a reused port after a restart, and an auto-incremented port. Each
  must resolve to its own service or ask the user to choose, and must never
  open another environment's server.

## Constraints and rationale

- No broad port scans, and terminal output is never logged as discovery
  telemetry.
- Terminal and agent text is a hint, never authority to publish or associate a
  service.
- Never associate an arbitrary host listener with an environment implicitly.
  Manual targets stay backend-loopback only.
- Keep refusing reserved Orkestrator, agent-bridge, agent-tool and Docker API
  ports.
- A TCP handshake does not prove process identity. `managed-process` means
  "started by this backend", not cryptographic proof.

## Open questions

- Is local-worktree seeding wanted, or is explicit registration the product
  choice?
- Is there a backend-owned dev-server launcher that item 2 can hook into, or
  does the item depend on one being built first?

## Related

- [0042-service-preview-rollout.md](0042-service-preview-rollout.md) (transports,
  qualification and legacy route).
- [browser-previews.md](../../architecture/browser-previews.md) §"Registering
  services" (target scope) and §"Framework configuration".

## Replaces

- `docs/improvements/browser/plan/04-target-resolution-and-readiness.md`
  (worktree and managed-process ownership)
- `docs/improvements/browser/plan/09-client-resolution-and-migration.md`
  (agent-provided links)
- `docs/improvements/browser/plan/12-service-controls-and-diagnostics.md`
  (framework setup hints, later discovery)
- `docs/improvements/browser/proposal.md` §1 and §6 (later discovery,
  multiple services)

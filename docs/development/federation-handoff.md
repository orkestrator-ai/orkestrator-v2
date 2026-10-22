# Federated multi-backend client: implementation handoff

> **Superseded direction (2026-10-21):** this records the client-side
> federation delivered on this branch. The agreed objective is now
> [command-nodes.md](../architecture/command-nodes.md); the "no central
> coordinator / client aggregates" statements below describe the delivered
> code, not the target. What carries over, moves or is removed is listed in
> command-nodes.md.
>
> **Since built:** the client-side runtime was removed in favour of command
> nodes; see [command-nodes-handoff.md](command-nodes-handoff.md).

Handoff for the plan in `docs/temp/remote.md` (sections 21 and 23). The
living references are
[federation.md](../architecture/federation.md),
[ssh-routes.md](ssh-routes.md),
[federation-migration.md](federation-migration.md) and
[federation-benchmarks.md](federation-benchmarks.md).

## Architecture in one page

- **Backends stay independent.** Each owns its projects, environments,
  agents, workflows and records. There is no coordinator, relay, shared
  database or backend-to-backend link. Clients connect to every machine
  directly.
- **Protocol** (`packages/protocol`): `federation.ts` (branded `BackendId` /
  `RouteId`, project/environment/session/file references, structured keys,
  machine-qualified links), `backend-profile.ts` (profile, palette tokens,
  hello schema v1, endpoint roles, capabilities), `device-catalogue.ts`
  (catalogue v2, SSH input validation, v1 migration), and federation fields
  on `ConnectionSummary`.
- **Backend**: a canonical machine profile store with compare-and-swap
  edits and `backend-profile-changed`; authenticated
  `GET /__orkestrator/hello` (role `client` or `control`); an opt-in
  loopback client gateway (`--loopback-client-port`) as the SSH target, with
  control-only routes kept off it; endpoint roles in the instance
  descriptor.
- **Desktop main**:
  - A native device catalogue (`<userData>/connections`) that works when the
    local backend is down.
  - A multi-route `ConnectionManager` with hello-verified identity,
    quarantine on trust failures, and fallback only within a verified
    machine holding an equivalent credential. It also handles route
    handover with epochs and a preserved terminal fence, observation
    leases, and bounded background attempts.
  - The OpenSSH tunnel supervisor (`electron/ssh/`).
  - Federated IPC, and machine panels (a child view per machine, each with
    its own connection scope).
  - Remote-only startup when the local backend fails.
- **Renderer**:
  - Per-machine `BackendRuntime`s (bound client, summary store, prefetch
    cache, epoch-fenced bounded hydration, outcome-unknown recovery and
    last-known persistence) under a `BackendClientRegistry`.
  - Aggregation projections.
  - The All machines sidebar: filter, grouping, dots, captured-owner
    actions, cross-machine search.
  - Side-by-side machine panels.
  - Machine cards in Connections, and a settings scope banner.
  - Storage keyed by machine identity.
- **Panels are separate renderer realms**, one per machine. The bound
  machine keeps the existing single-backend stores, so isolation is
  structural. See "Deviations".

## Versions and schemas

| Contract | Version |
| --- | --- |
| Backend hello | `schemaVersion: 1`, client API 1 |
| Backend profile store | record `version: 1`, revision starts at 1 |
| Device catalogue | `version: 2` (v1 = `StoredDesktopConnections` in `config.json`) |
| Instance descriptor | unchanged `version: 1`, optional `endpoints` |
| Persisted last-known summaries | `federation-summary:v1:<backendId>` (renderer storage) |

## Migration and rollback

See [federation-migration.md](federation-migration.md):

- **Import.** The v1 list is imported once, possibly late if Local was down,
  with a create-only v1 snapshot.
- **Downgrade.** The untouched v1 list is the downgrade path.
- **Feature flags.** The `federation`, `sshRoutes` and `routeFallback` flags
  each stop client machinery only, never remote work.

## Validation evidence (2026-10-21)

Every command ran through `mise run test:logged`.

| Check | Result |
| --- | --- |
| `mise run format:check` | PASS |
| `mise run lint` | PASS (no new findings in touched files) |
| `mise run typecheck` | PASS |
| `mise run test` (complete non-iOS suite) | PASS, 600 s. An earlier run had two guard-test failures (fixed) and flake 0512 (recorded). |
| `mise run test:browser` | PASS. Connections specs were updated for the new labels. |
| `mise run test:agent:electron` | PASS |
| SSH real-sshd suites (`ORKESTRATOR_SSH_INTEGRATION=1`) | PASS, 96 tests: SH-01/02/03/04/05/06/07/10/11, ID-02, OP-01 |
| `bun scripts/qa-federation-browser.ts` (since removed) | PASS |
| `bun scripts/benchmark-federation.ts` (since removed) | Results in federation-benchmarks.md |

The real-stack QA screenshots are in
`output/agent-testing/federation-qa/<run>/`, which is gitignored. They are
taken from a desktop-width and a narrow viewport and cover:

- Connections → Other machines;
- the All machines sidebar with machine sections and dots;
- grouping by project;
- the machine filter;
- a side-by-side panel of the other machine;
- an offline machine with its last-known state and disabled writes;
- reconnecting;
- a shared colour edit.

The acceptance-ID → test map is in
[federation.md](../architecture/federation.md#acceptance-id-map).

## Deviations from the plan, and why

1. **Panels are realms, not scopes in one React tree.** The renderer holds
   about 50 singleton stores and over 150 modules that reach the window's
   single backend. Turning all of them into backend-scoped factories would
   be a rewrite of most of the app. Instead, each machine's workspace runs
   in its own renderer:
   - Desktop: a child view with the standard preload and its own connection
     scope.
   - Hosted browser: a same-origin frame with its own direct session.

   This keeps every existing invariant per realm. Cross-machine leakage is
   prevented by construction, without careful keying. The unified sidebar,
   actions, search, links and notifications are in-tree and backend-bound.
2. **No `packages/client-runtime` package.** The runtime lives in
   `apps/web/src/lib/federation`. It is React-free and Electron-free, with a
   lint boundary against the single-backend invoke surface. Its only
   consumer today is the web renderer; the iOS app is a WebView of it.
3. **Desktop panels have no native previews or live artifact hosts.** Both
   use their non-native fallbacks inside a panel, as the plan's
   capability-gated fallback allows.
4. **Grant equivalence is "same token".** The gateway has one shared token
   and backends do not publish an `authorizationScopeId`.
5. **Mobile stays single-machine.** Mobile SSH and federated resume
   handling are not implemented; the plan marks native mobile SSH as a later
   adapter.

## Untested or not implemented

These are listed in detail under "Known limitations" in federation.md:

- RT-07, OP-04, UI-03, UI-06, FS-01, FS-02, CT-01, CT-03 and MB-01 have no
  dedicated tests. FS/CT isolation follows from the realm design, and the
  hosted-browser frame was observed calling only its own machine.
- The real-backend performance matrix (p95 visibility, bytes per minute,
  multi-client) was not measured.
- iOS was not built or tested; no iOS code changed.
- Windows SSH is not qualified.
- Live Electron QA of desktop machine panels against two real backends was
  not performed. The Electron scenario suite passes, and desktop panel
  behaviour is covered by unit tests of the panel view manager and IPC.

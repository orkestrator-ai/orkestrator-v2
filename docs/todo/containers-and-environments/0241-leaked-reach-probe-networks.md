# Leaked host-reachability probe networks exhaust Docker address pools

Seen on omarchy-hp (Arch Linux, Docker Engine 29.9.1) on 2026-10-26 while
qualifying [0058-legacy-migration-root-symlink.md](0058-legacy-migration-root-symlink.md).

## Current state

- `ContainerHostReachabilityService` (`apps/backend/src/core/container-host-reachability.ts`)
  creates `ork-<owner>-reach-probe-net` per check (`createProbeNetwork`) and
  removes it in a `finally`. A process killed during the check (a test
  watchdog, a timeout, a crash) leaves the network behind.
- `createProbeNetwork` removes a leftover only for its own owner name, and
  `reapStaleProbes` removes stale probe **containers** of its own owner, never
  networks. A real backend's owner is stable, so it leaks at most one network.
  Tests use a temporary data directory per run, so each leaked owner is never
  seen again and nothing removes its network.
- On 2026-10-26 the daemon held 29 unattached probe networks labelled
  `orkestrator-resource-role=host-reachability-probe`, all created on
  2026-09-28 by owners that no data directory on the host maps to (not the
  live instance `fa3e5358402ef5a5`, not `orkestrator-v2-dev`). With the bridge
  network they used all 31 default address pools, so every
  `createDockerContainer` failed with `resource-exhausted: Docker has no free
  address range for another environment network`. That blocks every live
  Docker suite and, on that host, any new environment of the live instance.
- To run the 0058 live cases, the eight oldest were removed (names below).
  Within minutes another run on the host leaked four more
  (`ork-ba077af2d5d36602`, `ork-74e3e0fcfc850592`, `ork-2b4ccf00afa71af0`,
  `ork-17b9c6e937ff5d30`, created 2026-10-26 00:51:56–00:52:06 UTC), so the
  removed eight were not recreated: the pool had only three free ranges left.
  Removed: `ork-b974e29e59930c3f`, `ork-830a1d1e2d22673e`,
  `ork-3b48ede1779a3e26`, `ork-2abb06b89c192705`, `ork-4bd4cb1fa5510280`,
  `ork-9b95783bb81bd7ab`, `ork-ce8a386c965921c8`, `ork-f842d66a53acec29`
  (each `-reach-probe-net`, bridge driver, no containers).

## Outstanding work

### Code

1. Find which test leaks them. Three more appeared at 00:58:00–08 UTC while
   a plain `mise run test` (no live Docker suites enabled) was killed by a
   host-wide agent restart, so an ordinary suite creates them, not only
   `apps/backend/tests/container-live-readiness.test.ts` (C22). The likeliest
   source is `ContainerHostReachabilityService.check("boot")`, which every
   backend runs at start (`apps/backend/src/core/index.ts`) unless
   `NODE_ENV` is `test`: a test that boots a real backend with another
   `NODE_ENV` and a temporary data directory starts a probe and is then
   killed. Several networks within seconds fits several such backends.
2. Make the leaking suite remove probe networks by its owner label in
   `afterAll`, like `container-live-replacement.test.ts` removes its
   environment networks.
3. Have `reapStaleProbes` also remove unattached probe networks of its own
   owner, so a backend that crashed mid-check recovers its one network on the
   next check rather than only on the next probe network create.

### Qualification

- After a full `mise run test` plus the live Docker suites on a Linux host,
  `docker network ls --filter label=orkestrator-resource-role=host-reachability-probe`
  lists nothing new.

## Constraints and rationale

- Removing networks whose owner is not provably dead is unsafe on a shared
  daemon; only the creating run (by its owner label) or an owner's own reaper
  may remove them.

## Open questions

- Should a sweep (for example `mise run dev:prune` or `disk:report --fix`)
  offer to remove unattached probe networks older than a day whatever their
  owner?

## Related

- [0023-environment-and-disk-cleanup.md](0023-environment-and-disk-cleanup.md) (test leaks)
- [0061-container-qualification-follow-ups.md](0061-container-qualification-follow-ups.md) (harness leaks)

## Replaces

Nothing; new observation.

# Electron spec backends still run the boot probe, and a leaked probe network cannot be traced

## Task analysis

Analysed 2026-11-06 against main at `c1724ab74`; re-analysed and both tasks
done 2026-11-09 against main at `c6de4733c`. Found while working on
[7041](../../development/container-qualification.md#exhausted-docker-pools-and-historical-probe-network-trace-2026-11-06) task 2.

### Tasks

1. **Decide whether disposable Electron spec backends skip the boot probe**: done (2026-11-09).
2. **Make a leaked probe network traceable to the run that created it**: done (2026-11-09).

### 1. Decide whether disposable Electron spec backends skip the boot probe

**Problem.** About sixteen Electron specs under `e2e/agent-testing/` launch the
app with a fresh temporary profile and leave `ORKESTRATOR_HOST_REACHABILITY_CHECK`
unset. Those that start a Local backend run its Linux boot probe, which creates
`ork-<owner>-reach-probe-net` for an owner that never runs again. If such a
backend dies without its shutdown while the probe holds the network, the
network leaks and nothing reaps it. 7041 task 2 places the 29 networks that
filled beelink's pools between 2026-10-31 and 2026-11-02 in builds that ran
these specs. On beelink, whose firewall drops Docker traffic, the probe's
"Docker containers can't reach Orkestrator" modal also opens during the
journey ([4250](../../tests/flaky-tests/design-canvas-and-artifacts/4250-design-electron-reachability-dialog-race.md)).

**Context.** The CLI tests, the CLI scenarios, `recurring-live-ab.ts` and five
Electron specs (`relayed-events-electron`, `renderer-log-boundary-electron`,
`service-preview-electron` through `service-preview-electron-launch.ts`,
`workspace-realm-electron`, and `electron-leaf-backend.ts`) already set the
variable to `off`. The testing guide's "disposable backends" paragraph gives
the reason. Agent-test backends have passed the variable through only since
#1537 (2026-11-01, `AGENT_TEST_SAFE_ENV_NAMES` in
`apps/desktop/electron/backend-process.ts`); before that it was dropped, so a
spec could not turn the probe off. Specs that leave it unset are
`application-menu`, `artifact-host`, `connection-outage`, `design-canvas`,
`design-canvas-packaged`, `electron-cleanup`, `electron-main`,
`local-gateway-transport(-cpu)`, `log-controls-packaged`,
`packaged-security`, `pull-request-pane`, `renderer-permissions`,
`service-preview-seeded`, `terminal-input-resume` and `web-annotations`, plus
the helpers `electron-display-setup.ts` and `packaged-electron-app.ts`. Some
launch fake mains and start no backend.

**Investigation.** On 2026-11-06 a headless `design-canvas-electron.spec.ts`
run with the probe on (the scoped Docker shim on PATH, so the probe network
could be created on an exhausted pool) created its probe network and destroyed
it within 6 s. It did not leak, and the spec failed at a known flake. With the
probe off it failed in cleanup instead
([1131](../../tests/flaky-tests/design-canvas-and-artifacts/1131-design-electron-graceful-quit-deadline.md)),
so this run does not show that the probe causes the spec's failures. The other
specs need a display and were not run. Failed or timed-out network creation
also remains unruled out: Docker can create the network despite a client
command failure, while `createProbeNetwork` clears the tracked network and
returns null when the service is not closed. Cleanup then lacks the network
handle, so later normal shutdown need not remove it. These reruns did not
exercise that path, and it is not established as the cause of the historical
clusters.

**Decisions.**

- **How should Electron spec backends handle the boot probe?**
  - **A shared spec environment helper that sets `ORKESTRATOR_HOST_REACHABILITY_CHECK=off` unless the spec passes its own value, used by every Electron launch (recommended).**
    - Pros: one place, as the CLI harnesses already do; no probe network per run; removes the modal from journeys that do not test it.
    - Cons: touches every Electron spec; a spec that should see the modal must ask for it explicitly; the startup-dialog handling loses its live coverage unless one spec keeps the probe on.
  - **Set it per spec, only where a spec has shown the probe in its way.**
    - Pros: small, reviewable changes.
    - Cons: new specs keep the default and repeat the leak; the list drifts.
  - **Keep the probe on and rely on the sweep (`disk:report -- --fix probe-networks`).**
    - Pros: no change; specs see the real startup.
    - Cons: networks still pile up for a day before the sweep may remove them, and only when the user runs it.

### 2. Make a leaked probe network traceable to the run that created it

**Problem.** A leaked probe network carries only its owner hash
(`dockerOwnerNamespace(dataDir)`) and role. When the data directory was
temporary, which is every disposable test backend, nothing left on the host
maps the hash back to a harness. 7041 task 2 could rule out persistent profiles
but could not name the harness.

**Context.** The probe network is created in `createProbeNetwork`
(`apps/backend/src/core/container-host-reachability.ts`) with
`probeLabels()`. Labels are readable by anyone who can reach the daemon, so
they must not carry a path, a user name or anything secret. Backend logs under
a temporary data directory are deleted with it.

**Investigation.** Done 2026-11-09. `probeLabels()` is the single place the
probe network and each probe container get their labels (`network create` and
`docker run`), so one optional dependency covers both. The backend already
knows its runtime flavor (`production`, `development`, `agent-test`) and its
data directory, which is enough to tell a temporary one (under `os.tmpdir()`
or `/tmp`) from a profile's or production's without writing a path into the
label. `docker network ls --format '{{.Label "<key>"}}'` reads the value
(checked on beelink's daemon, where unlabelled networks print an empty
string), so `disk:report` can count by it. `docker events` for a network
create carries the name but not the labels.

**Decisions.**

- **What should identify the creating run?**
  - **Add a coarse creator label: runtime flavor and whether the data directory is temporary (recommended).**
    - Pros: content-free; enough to tell a test backend from a profile or production; `disk:report` can count by it.
    - Cons: still does not name the exact spec; needs a test for `probeLabels()`.
  - **Log the owner hash with the data directory when the network is created.**
    - Pros: exact.
    - Cons: the log is deleted with a temporary data directory, so it helps only for persistent ones, which are already traceable.
  - **Do nothing.**
    - Pros: no new surface.
    - Cons: the next leak is as untraceable as this one.

## Assumptions and decisions

### Task 1: retain the failed-create leak candidate (review correction, 2026-11-06)

Chose to carry the failed or timed-out network-create path from 7041 into this
follow-up. The historical source is unproven; disabling the probe avoids its
network creation in disposable backends, but does not repair that cleanup path
for backends that still run the probe.

### Task 1: every Electron launch builds its env through one helper (2026-11-09)

Chose the recommended option. `electronSpecEnvironment(base, overrides)`
(`e2e/agent-testing/electron-spec-environment.ts`) copies `base`, applies
`overrides` (an `undefined` override removes a variable, which replaces the
specs' own `ELECTRON_RUN_AS_NODE` filters), and sets
`ORKESTRATOR_HOST_REACHABILITY_CHECK` to the override's value or `off`. A
value inherited from the runner's own environment is ignored, as the CLI
scenario helper (`provider-homes.ts`) does, so a shell that happens to carry
the variable cannot turn the probe back on. `packagedLaunchEnvironment` calls
it, so the packaged specs are covered too.

All 26 Electron launches under `e2e/agent-testing/` use it: Playwright's
`electron.launch` in every spec and helper, including the fake-main launches
that start no backend and the three that passed no `env` at all (which
inherited the runner's environment), plus the two bare
`spawn(electronExecutable, …)` launches (the local-gateway CPU spec through
`local-gateway-transport-stack.ts`, and the renderer-log-boundary lifecycle
fixture). Covering the fake mains costs nothing and keeps the guard simple.
`tests/unit/electron-spec-environment.test.ts` scans the directory and fails
on a launch whose `env` is not built by `electronSpecEnvironment(` or
`packagedLaunchEnvironment(`, so a new spec cannot repeat the leak.

No spec keeps the probe on. That gives up live coverage of the startup
dialog in Electron; the dialog is covered by
`ContainerHostReachabilityNotice.test.tsx` and the browser specs that close
it, and `dismissStartupDialogs` still closes it for a spec that passes `on`.
Keeping one Electron spec on would have kept one probe network per run of
that spec. The specs that already set `off` with a reason
(`renderer-log-boundary-electron`, `service-preview-electron-launch.ts`) keep
their explicit value and comment; the others' duplicate `off` was removed.
The testing guide's disposable-backends paragraph now describes the helper.

Evidence: on beelink, `design-canvas-electron.spec.ts` through
`playwright.electron-headless.config.ts` with
`ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1`, no display variables and the
scoped Docker shim on `PATH` (so a probe could have created its network on
the exhausted pools) passed in 48 s (1 expected, 0 unexpected). A
`docker events` watcher for network creates, running from before the launch
to after it, recorded none; a network this work then created and removed
(`todo7470-watcher-check`) did appear, so the watcher was live.

The failed or timed-out network-create path carried over from 7041 is not
changed: disabling the probe removes it for Electron spec backends, and a
backend that still runs the probe now labels what it creates (task 2), so a
leak from that path can at least be attributed. No live run reproduced it.

### Task 2: a coarse `orkestrator-creator` label (2026-11-09)

Chose the recommended option. Probe networks and probe containers carry
`orkestrator-creator=<runtime flavor>/<temporary|persistent>`
(`DOCKER_LABEL_CREATOR`; value from `probeCreator` in
`apps/backend/src/core/container-host-reachability-creator.ts`), for example
`agent-test/temporary`. The value comes from a fixed set of six, never a path,
a user name or a spec name, because anyone who can reach the daemon can read
labels. "Temporary" means the data directory resolves, by path or real path,
under `os.tmpdir()` or `/tmp`. The service leaves the label off when it is
given no creator, so test fakes and older call sites are unchanged; the
reaper and the sweep still select by owner and role, so unlabelled networks
from before this change are found exactly as before.

`disk:report`'s probe-network row now counts the stale networks by creator
(`… (by creator: agent-test/temporary 1, unlabelled 1)`); a label value that
is not one a backend writes is counted as `unlabelled` rather than echoed.
`disk-usage.md` documents the label. Tests: `probeCreator` and
`isTemporaryDataDir` (including symlinked roots and prefix-only siblings),
the label on every `network create` and `docker run` of a check, its absence
with no creator, and the report's parsing and counts.

Not done live: a backend with the probe on was not run to show the label on a
real network, because this work's constraints keep the probe off for app runs.
The unit tests assert the exact Docker arguments.

## Related

- [Exhausted-pool and probe-network evidence](../../development/container-qualification.md#exhausted-docker-pools-and-historical-probe-network-trace-2026-11-06), where this was found.
- [0241-leaked-reach-probe-networks.md](0241-leaked-reach-probe-networks.md), the earlier leak and its fixes.
- [3320-leaked-probe-networks-block-docker-fixtures-on-beelink.md](3320-leaked-probe-networks-block-docker-fixtures-on-beelink.md), clearing the current networks.

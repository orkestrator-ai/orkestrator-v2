# Manual Docker profiles fail on an exhausted address pool

## Task analysis

Analysed 2026-11-06 against `main` at `e6c3da899`. Worked 2026-11-06 against
`main` at `c1724ab74` on beelink (Docker Engine, automatic pools exhausted).

### Tasks

1. **Manual container profiles on an exhausted pool**: `mise run dev:test --fixture-environments local,container` fails outright where `test:agent:docker:isolated` falls back. Status: done (2026-11-06).
2. **Probe networks leaked again**: 29 unattached `ork-*-reach-probe-net` networks from 2026-10-31 to 2026-11-02 filled the pools on beelink after 0241 was closed. Status: closed as untraceable (2026-11-10). The teardown that leaked did not reproduce on 2026-11-06, and the networks' owners belong to temporary data directories that no longer exist, so the harness cannot be named. What was ruled out and the likeliest source are recorded below. The follow-up, [7470](7470-electron-spec-backends-run-the-boot-probe.md), is done and on `main` (#2024, `60c065c36`): Electron spec backends skip the boot probe and every probe network carries an `orkestrator-creator` label, so a new leak names its creator. [3320](3320-leaked-probe-networks-block-docker-fixtures-on-beelink.md) task 1 was the same trace and is closed as a duplicate of this task.

### 1. Manual container profiles on an exhausted pool

**Problem.** On beelink on 2026-11-05 a manual `dev:test` with a container fixture failed at startup with `ContainerLifecycleError:resource-exhausted: Docker has no free address range for another environment network`. The documented manual workflow for `mise run test:agent:docker` is therefore unusable on that host until networks are freed, which agents may not do.

**Context.** `test:agent:docker:isolated` puts `apps/desktop/scripts/dev/docker-qualification-bin` on PATH with `ORKESTRATOR_QUALIFICATION_DOCKER` (`apps/desktop/scripts/dev/isolated-browser.ts`). That shim retries only labelled `network create` calls on unrouted /29s in 172.16.240.0/22. The manual workflow in `docs/development/agent-testing.md` did not mention it.

**Investigation.** Starting the same profile with the shim on PATH (`ORKESTRATOR_QUALIFICATION_DOCKER="$(command -v docker)" PATH="$PWD/apps/desktop/scripts/dev/docker-qualification-bin:$PATH" mise run dev:test …`) succeeded, and the fixture network was created on a /29.

Done 2026-11-06: `agent-testing.md` now has a section, "Container profiles on an exhausted Docker address pool", after the manual container fixture commands, and the manual `test:agent:docker` example points at it. The documented command was then run on beelink:

- A labelled `docker network create` without a subnet failed with `all predefined address pools have been fully subnetted`, so the pools were exhausted at the time.
- `ORKESTRATOR_HOST_REACHABILITY_CHECK=off ORKESTRATOR_QUALIFICATION_DOCKER="$(command -v docker)" PATH="$PWD/apps/desktop/scripts/dev/docker-qualification-bin:$PATH" mise run dev:test --profile qa-7041-shim --fixture --fixture-environments local,container --no-agent-credentials --agent-platforms codex --headless` reached `ready`.
- The fixture container and its egress gateway were `Up`, and the environment network `ork-<owner>-<hash>-net` had subnet `172.16.240.0/29`, a range only the shim's fallback hands out.
- `dev:stop` and `dev:reset` then removed the profile's 2 containers, 2 volumes and 1 network.

The CLI container matrix fails the same way (2026-11-06, to-do [0014](../cli-and-slash-commands/0014-cli-qualification.md) task 5): `mise run test:cli:scenarios -- --environment-type container` passed 3/8, with every scenario that starts an environment failing with `resource-exhausted`. With the same two variables it passed 8/8 and left nothing behind. The invocation is now documented beside that command in `docs/development/testing-guide.md`; the manual `dev:test` workflow is documented in `agent-testing.md` as recorded above.

**Decisions.**

- **How should a manual profile get the fallback?**
  - **Document the shim invocation next to the manual `test:agent:docker` workflow (recommended, done).**
    - Pros: no code change; the same scoped behaviour the isolated task already relies on.
    - Cons: a manual step people can miss.
  - **Have `dev:test` put the shim on PATH whenever `--fixture-environments` includes `container`.**
    - Pros: automatic.
    - Cons: widens a test-only shim to every container profile; needs its own tests.

### 2. Probe networks leaked again

**Problem.** The host held 29 unattached reach-probe networks, created in clusters on 2026-10-31 (15:51–17:45 UTC), 2026-11-01 (03:40–04:33 UTC) and 2026-11-02 (04:57–05:50 UTC). 0241 task 4 recorded no new probe networks after a full run on 2026-10-31.

**Context.** [0241](0241-leaked-reach-probe-networks.md) found and fixed the earlier sources, and `mise run disk:report --fix probe-networks` removes unattached probe networks older than a day. Removing them is the user's call; this work did not. A backend removes its own probe network when the check ends and when it gets SIGTERM or SIGINT (`ContainerHostReachabilityService.dispose`). A backend that dies without its shutdown (SIGKILL, or a killed process group) while a check holds the network can leak it. Failed or timed-out network creation is another unruled-out path: Docker may create the network despite the client command failing, after which `createProbeNetwork` clears `probeNetwork` and returns null when the service is not closed. The caller then has no network to remove, and later normal shutdown may leave it behind. Neither path is proven to have caused the historical clusters. The check holds it for about 6 s on beelink, whose ufw drops Docker traffic, so each probe waits out its 5 s connect timeout. Each disposable data directory is a new owner that no reaper revisits.

**Investigation.** Not traced to one teardown. What the evidence shows:

- **The networks.** All 29 are still present, labelled `orkestrator-resource-role=host-reachability-probe`, one per owner, each on a /16 of the default pool, none attached. Within the clusters several come in runs of three, 3.9 s apart: 2026-10-31 16:18:00/04/08, 16:50:03/07/11 and 17:45:07/11/15; 2026-11-01 04:33:06/10/14; and a pair at 2026-11-02 04:57:12/16. That spacing points to one harness that starts backends one after another, each on a new data directory.
- **Owners against data directories.** No owner matches `dockerOwnerNamespace` of any of the 176 profile directories under `~/.config/orkestrator-v2-dev/profiles/` (as `<profile>` or `<profile>/data`), of the production data directory, or of the development root. Persistent `dev:test` profiles are therefore ruled out. The owners belong to temporary data directories that no longer exist, so they cannot be named.
- **Run history.** The production backend's service log has no timestamps between 2026-11-01 02:00 and 11:00 UTC, and the Kanban store keeps no comments from those windows. Pull requests opened in and just after the windows place them in concurrent pipeline builds:
  - 2026-10-31: about fifteen merges, among them #1501 (native menu qualification on Linux, its Electron spec) and #1500 (the 0241 sweep).
  - 2026-11-01: #1537 (service-preview Electron flakes, opened 04:35 UTC, right after the window), #1539 (Linux design-canvas Electron qualification) and #1542 (Electron focus checks). #1537's commit records, on beelink, that the spec's "probe network outlived each disposable profile". Until that commit (merged 11:12 UTC that day) agent-test backends dropped `ORKESTRATOR_HOST_REACHABILITY_CHECK` from their environment, so every agent-test Electron spec backend ran the boot probe even when the spec set the variable to `off`.
  - 2026-11-02: #1594 (the design journey against the packaged Linux app), #1601 (container stop drain) and #1603 (federated sidebar). The packaged and design-canvas Electron specs still do not set the variable.
- **Likeliest source.** Agent-test Electron spec backends: windows 1 and 2 fall in Electron spec qualification builds while the switch was being dropped, and window 3 in the packaged Electron journey's build, whose specs still run the probe.
- **Reruns.** Each was diffed against the probe-network list from before it, with `docker events --filter type=network` recording every create and destroy:
  - The automatic pools are exhausted, so a plain rerun cannot create a probe network at all. `design-canvas-electron.spec.ts` (headless, probe on) passed in 18.5 s and created none.
  - With the shim on PATH, a labelled probe network goes onto a /29, so the leak could happen again. Reruns with the shim and the probe on:
    - The same spec failed at a known flake ([4250](../../tests/flaky-tests/design-canvas-and-artifacts/4250-design-electron-reachability-dialog-race.md) and [1131](../../tests/flaky-tests/design-canvas-and-artifacts/1131-design-electron-graceful-quit-deadline.md)). Its probe network was created, connected, disconnected and destroyed within 6 s.
    - `apps/desktop/tests/backend-process.test.ts`, run from `apps/desktop`, passed. It created no probe network, because each backend was stopped before its check reached the network.
    - Run from the repository root it created one, which was destroyed.
    - `apps/backend/tests/standalone.test.ts` created three, 1–2 s apart, and all were destroyed. Its one failure was unrelated: `cursor-bridge` was not built in this worktree.
  - None of the reruns left a probe network behind.
- **Still unruled out.** A failed or timed-out Docker network-create command may leave a daemon-side network even when the backend later shuts down normally. The successful create/destroy pairs in these reruns do not exercise that failure path. Follow-up [7470](7470-electron-spec-backends-run-the-boot-probe.md) retains it as a candidate, without attributing the historical clusters to it.
- **Not rerun.** The Electron specs other than the design journey need a display, which this host may not use (headless only, no Xvfb), so the specs of the 2026-10-31 and 2026-11-01 builds could not be repeated here. Their timing at the time (backends stopped while host load stalled Docker commands) cannot be recreated either.

Additional inventory on 2026-11-06: On 2026-11-06 the host still held 29 unattached probe networks, created 2026-10-31 (13), 2026-11-01 (9) and 2026-11-02 (7), and none newer, so the leak has not recurred since 2026-11-02. They still fill both default pools (172.18–31/16 and 192.168.0.0/16 in /20s). The owner namespaces are one-off (one network each), which fits backends started on temporary data directories, as in 0241 task 1.

**Decisions.**

- **How to find the source?**
  - **Match the cluster times against build and test runs on beelink in those windows, then rerun the likeliest harness and diff the probe-network list (recommended, done).**
    - Pros: the method 0241 used; decisive when the leak reproduces.
    - Cons: the run history of those days is thin, the pools are full, and the likeliest harnesses need a display. It did not reproduce.
  - **Add an owner-to-data-directory log line when a probe network is created.**
    - Pros: makes the next leak traceable at once.
    - Cons: new logging surface; does not explain these. Carried into [7470](7470-electron-spec-backends-run-the-boot-probe.md) task 2.

## Current state

- Manual container profiles work on an exhausted pool with the documented shim invocation (task 1).
- Task 2 is closed as untraceable (2026-11-10); a leak after 7470 (#2024) carries its creator's label.
- The 29 networks from task 2 are still on beelink, untouched. Removing them is the user's call: [3320](3320-leaked-probe-networks-block-docker-fixtures-on-beelink.md) task 2, using `mise run disk:report -- --fix probe-networks`.
- No run in this work left a probe network behind. The `docker events` log showed a destroy for every probe network it created.

## Assumptions and decisions

### Task 1: where the shim invocation is documented (2026-11-06)

- **Chose:** a short subsection at the end of the manual fixture-environment commands in `agent-testing.md`, plus a one-line pointer in the manual `test:agent:docker` example under "Automated checks".
- **Why:** that is where a reader starting a container profile by hand looks. PR #1915 (to-do 0019) changes a line in the isolated-task paragraph near the top of the same file and changes the shim to `exec` the real CLI. This text avoids both, so the two changes do not conflict, and it does not describe how the shim runs non-`network create` calls, which #1915 changes.

### Task 1: probe off for the live proof (2026-11-06)

- **Chose:** `ORKESTRATOR_HOST_REACHABILITY_CHECK=off` for the `dev:test` proof.
- **Why:** the brief requires it unless a rerun needs the probe. Proving the fallback needs only the fixture network.

### Task 2: probe on, and the shim on PATH, for the reruns (2026-11-06)

- **Chose:** run the candidate harnesses with the probe at its default (on), and, after a first rerun created no probe network, with the shim on PATH.
- **Why:** the leak can only happen when a probe network is created. On exhausted pools that needs the shim's /29 fallback, since the probe network carries an owner label. Each harness ran on its own temporary data directories, not on a profile or the real data directory.

### Task 2: kept open rather than closed as untraceable (2026-11-06; superseded 2026-11-10, see below)

- **Chose:** leave task 2 open, depending on 7470, and re-rate the file Low.
- **Why:** its goal, naming the leaking harness, was not reached. The ruled-out record here is the evidence 3320 and 7470 rely on, and a finished file would be deleted under the to-do rules. Nothing else in this file is outstanding: the leak's risk now sits in 7470, and clearing the networks in 3320.

### Task 2: no code change (2026-11-06)

- **Chose:** record the evidence and open [7470](7470-electron-spec-backends-run-the-boot-probe.md), rather than change the Electron specs here.
- **Why:** the brief asks for a fix only once the source is found. The source is likely but not reproduced, and turning the probe off across the Electron specs touches about sixteen spec files and what they cover (the probe's dialog is part of the startup the specs see). 7470 sets out that choice with its options.

### Task 2: retain failed network creation as a candidate (review correction, 2026-11-06)

- **Chose:** qualify the shutdown claim and carry failed or timed-out network creation into 7470.
- **Why:** a daemon-side create can outlive a failed client command and escape the recorded cleanup handle. The reruns did not reproduce this path, so it remains a candidate rather than an explanation of the historical clusters.

### Task 2: closed as untraceable (2026-11-10)

- **Chose:** close task 2 as untraceable, mark the file Finished and keep it for its evidence, and mark 3320 task 1, the same trace, as a duplicate of it.
- **Why:** the earlier reason to keep it open was 7470, which is now done and on `main` (#2024, `60c065c36`, checked against `main` at `04639b12b`). Its creator label applies only to networks created after it, so the 29 networks of 2026-10-31 to 11-02 carry none and their owners' data directories are gone: nothing further can name the harness. The ruled-out record above stays, because 3320, 7470, 0014, 7040 and container qualification link to it, as 7470 and 7081 are kept for theirs. Clearing the networks stays in 3320 task 2.
- **Alternative:** keep task 2 open until the next leak. That would keep an open item that no work can advance, and a new leak, now labelled, is new work for a new to-do.

## Related

- [0241-leaked-reach-probe-networks.md](0241-leaked-reach-probe-networks.md)
- [3320-leaked-probe-networks-block-docker-fixtures-on-beelink.md](3320-leaked-probe-networks-block-docker-fixtures-on-beelink.md), the same 29 networks; its task 2 is clearing them.
- [7470-electron-spec-backends-run-the-boot-probe.md](7470-electron-spec-backends-run-the-boot-probe.md), the follow-up from task 2.
- [7040-container-cells-on-real-cursor-and-pi.md](../agent-engines/7040-container-cells-on-real-cursor-and-pi.md)
- [0014-cli-qualification.md](../cli-and-slash-commands/0014-cli-qualification.md) (task 5's container matrix ran through the shim)

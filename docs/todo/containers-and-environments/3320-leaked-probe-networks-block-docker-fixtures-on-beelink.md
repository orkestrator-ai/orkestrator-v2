# Leaked probe networks block Docker fixtures on beelink again

## Task analysis

Analysed 2026-11-03 against main at `7b48c23fb`.

### Tasks

1. **Find what leaked the probe networks created after 0241 was qualified**: closed (2026-11-10) as a duplicate of [7041](7041-manual-docker-profiles-on-exhausted-pools.md) task 2, the same trace of the same 29 networks, which is closed as untraceable.
2. **Clear the current leak on beelink**: open (the user's call; task 1's evidence is recorded in 7041, so nothing here waits on it any longer).

### 1. Find what leaked the probe networks created after 0241 was qualified

**Problem.** On beelink a `dev:test` profile with `--fixture-environments local,container` failed at startup with `ContainerLifecycleError:resource-exhausted: Docker has no free address range for another environment network`. The daemon held 29 unattached `ork-<owner>-reach-probe-net` networks (role `host-reachability-probe`), each holding a /16 or /20 of the default pools.

**Context.** [0241](0241-leaked-reach-probe-networks.md) found and fixed the earlier leakers (`cli.test.ts` and `test:cli:scenarios`) and recorded a clean full run on beelink on 2026-10-31. The probe network is created per owner (`dockerOwnerNamespace(dataDir)`), so every temporary data directory is a new owner.

**Investigation.** Creation dates of the 29 networks on 2026-11-03: 13 on 2026-10-31, 9 on 2026-11-01 and 7 on 2026-11-02 (the latest 05:50 UTC). All have no containers attached. The 2026-11-01 and 2026-11-02 networks postdate 0241's qualification, so either some harness still leaks or a `dev:test` profile was removed without `dev:reset` (which removes its own probe network). Not checked: which owners map to which data directories. Found while working on to-do 2922 task 5.

On 2026-11-06 [7041](7041-manual-docker-profiles-on-exhausted-pools.md) task 2 did the owner correlation and the reruns for these same 29 networks. No owner matches any profile directory under `~/.config/orkestrator-v2-dev/profiles/`, so they belong to temporary data directories. The reruns leaked nothing, and the likeliest source is agent-test Electron spec backends; the follow-up is [7470](7470-electron-spec-backends-run-the-boot-probe.md). The networks were left in place for task 2.

On 2026-11-10 7041 task 2 was closed as untraceable: the owners' temporary data directories are gone and the networks predate the creator label of [7470](7470-electron-spec-backends-run-the-boot-probe.md) (on `main` since #2024, `60c065c36`), so no further work can name the harness. This task, the same trace, is closed as its duplicate. A probe network leaked after #2024 carries an `orkestrator-creator` label, and would be new work for a new to-do.

**Decisions.**

- **How to find the source?**
  - **Correlate owners with data directories (recommended).** Hash candidate data directories (existing and pruned `dev:test` profiles under `~/.config/orkestrator-v2-dev/profiles/`, `mkdtemp` directories named in test logs) with `dockerOwnerNamespace` and match them to the network labels.
    - Pros: names the leaker; read-only.
    - Cons: a deleted temporary directory leaves no trace, so some owners may stay unexplained.
  - **Rerun the suites and diff the network list.**
    - Pros: decisive for whatever leaks now.
    - Cons: ten concurrent builds on the host make the diff noisy, and every leak found fills the pools further.

### 2. Clear the current leak on beelink

**Problem.** Until the networks are removed, no new Docker fixture or container environment can be created on beelink without an explicit subnet.

**Context.** `mise run disk:report -- --fix probe-networks` removes unattached probe networks older than a day, whatever their owner (rules in [disk-usage.md](../../development/disk-usage.md); its first real run is [0241](0241-leaked-reach-probe-networks.md) task 1, on omarchy-hp). Running it is the user's call, as it removes resources other runs created.

**Investigation.** Not run. For task 5 of 2922 the fixture was started with a PATH shim, kept outside the repository, that gave the profile's own networks explicit `10.229.x.0/24` subnets. With that subnet the restricted container's egress gateway failed to apply its network policy (cause not investigated), so a full-network fixture was used.

**Decisions.**

- **Who clears them?**
  - **The user runs `disk:report -- --fix probe-networks` after task 1 has looked at the owners (recommended).** Task 1 has now looked (closed 2026-11-10 with 7041 task 2), so the sweep can run whenever the user chooses.
    - Pros: uses the existing, owner-agnostic, age-bounded sweep; the evidence for task 1 survives until it has been read.
    - Cons: Docker fixtures stay blocked on beelink until then.
  - **Have the profile launcher sweep them on start.**
    - Pros: self-healing.
    - Cons: removes resources other runs own, which agents on this host must not do.

## Assumptions and decisions

### Task 1: closed as a duplicate of 7041 task 2 (2026-11-10)

Task 1 and 7041 task 2 traced the same 29 networks, and the work was done in
7041, which this file already pointed at. Chosen: close task 1 as a duplicate
of 7041 task 2, now closed as untraceable, rather than keep a second open
copy of an item no work can advance. Task 2 no longer depends on task 1;
clearing the networks stays the user's call. Checked against `main` at
`04639b12b`.

## Related

- [0241-leaked-reach-probe-networks.md](0241-leaked-reach-probe-networks.md), the original leak and its fix.
- To-do 2922 (finished and removed), task 5, where this was found.
- [4730-disposable-docker-daemon-for-live-suites.md](4730-disposable-docker-daemon-for-live-suites.md), a way to run live suites while the pools are full.
- [7041-manual-docker-profiles-on-exhausted-pools.md](7041-manual-docker-profiles-on-exhausted-pools.md), the trace of these networks and the documented shim for manual container profiles on full pools.

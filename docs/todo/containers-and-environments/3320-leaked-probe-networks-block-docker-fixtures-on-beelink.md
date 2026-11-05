# Leaked probe networks block Docker fixtures on beelink again

## Task analysis

Analysed 2026-11-03 against main at `7b48c23fb`.

### Tasks

1. **Find what leaked the probe networks created after 0241 was qualified**: open.
2. **Clear the current leak on beelink**: open (depends on 1).

### 1. Find what leaked the probe networks created after 0241 was qualified

**Problem.** On beelink a `dev:test` profile with `--fixture-environments local,container` failed at startup with `ContainerLifecycleError:resource-exhausted: Docker has no free address range for another environment network`. The daemon held 29 unattached `ork-<owner>-reach-probe-net` networks (role `host-reachability-probe`), each holding a /16 or /20 of the default pools.

**Context.** [0241](0241-leaked-reach-probe-networks.md) found and fixed the earlier leakers (`cli.test.ts` and `test:cli:scenarios`) and recorded a clean full run on beelink on 2026-10-31. The probe network is created per owner (`dockerOwnerNamespace(dataDir)`), so every temporary data directory is a new owner.

**Investigation.** Creation dates of the 29 networks on 2026-11-03: 13 on 2026-10-31, 9 on 2026-11-01 and 7 on 2026-11-02 (the latest 05:50 UTC). All have no containers attached. The 2026-11-01 and 2026-11-02 networks postdate 0241's qualification, so either some harness still leaks or a `dev:test` profile was removed without `dev:reset` (which removes its own probe network). Not checked: which owners map to which data directories. Found while working on to-do 2922 task 5.

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

**Context.** `mise run disk:report -- --fix probe-networks` removes unattached probe networks older than a day, whatever their owner (0241 task 5). Running it is the user's call, as it removes resources other runs created.

**Investigation.** Not run. For task 5 of 2922 the fixture was started with a PATH shim, kept outside the repository, that gave the profile's own networks explicit `10.229.x.0/24` subnets. With that subnet the restricted container's egress gateway failed to apply its network policy (cause not investigated), so a full-network fixture was used.

**Decisions.**

- **Who clears them?**
  - **The user runs `disk:report -- --fix probe-networks` after task 1 has looked at the owners (recommended).**
    - Pros: uses the existing, owner-agnostic, age-bounded sweep; the evidence for task 1 survives until it has been read.
    - Cons: Docker fixtures stay blocked on beelink until then.
  - **Have the profile launcher sweep them on start.**
    - Pros: self-healing.
    - Cons: removes resources other runs own, which agents on this host must not do.

## Related

- [0241-leaked-reach-probe-networks.md](0241-leaked-reach-probe-networks.md), the original leak and its fix.
- To-do 2922 (finished and removed), task 5, where this was found.
- [4730-disposable-docker-daemon-for-live-suites.md](4730-disposable-docker-daemon-for-live-suites.md), a way to run live suites while the pools are full.

# Manual Docker profiles fail on an exhausted address pool

## Task analysis

Analysed 2026-11-06 against `main` at `e6c3da899`.

### Tasks

1. **Manual container profiles on an exhausted pool**: `mise run dev:test --fixture-environments local,container` fails outright where `test:agent:docker:isolated` falls back. Status: open.
2. **Probe networks leaked again**: 29 unattached `ork-*-reach-probe-net` networks from 2026-10-31 to 2026-11-02 filled the pools on beelink after 0241 was closed. Status: open.

### 1. Manual container profiles on an exhausted pool

**Problem.** On beelink on 2026-11-05 a manual `dev:test` with a container fixture failed at startup with `ContainerLifecycleError:resource-exhausted: Docker has no free address range for another environment network`. The documented manual workflow for `mise run test:agent:docker` is therefore unusable on that host until networks are freed, which agents may not do.

**Context.** `test:agent:docker:isolated` puts `apps/desktop/scripts/dev/docker-qualification-bin` on PATH with `ORKESTRATOR_QUALIFICATION_DOCKER` (`apps/desktop/scripts/dev/isolated-browser.ts`). That shim retries only labelled `network create` calls on unrouted /29s in 172.16.240.0/22. The manual workflow in `docs/development/agent-testing.md` does not mention it.

**Investigation.** Starting the same profile with the shim on PATH (`ORKESTRATOR_QUALIFICATION_DOCKER="$(command -v docker)" PATH="$PWD/apps/desktop/scripts/dev/docker-qualification-bin:$PATH" mise run dev:test …`) succeeded, and the fixture network was created on a /29.

**Decisions.**

- **How should a manual profile get the fallback?**
  - **Document the shim invocation next to the manual `test:agent:docker` workflow (recommended).**
    - Pros: no code change; the same scoped behaviour the isolated task already relies on.
    - Cons: a manual step people can miss.
  - **Have `dev:test` put the shim on PATH whenever `--fixture-environments` includes `container`.**
    - Pros: automatic.
    - Cons: widens a test-only shim to every container profile; needs its own tests.

### 2. Probe networks leaked again

**Problem.** The host held 29 unattached reach-probe networks, created in clusters on 2026-10-31 (15:51–17:45 UTC), 2026-11-01 (03:40–04:33 UTC) and 2026-11-02 (04:57–05:50 UTC). 0241 task 4 recorded no new probe networks after a full run on 2026-10-31.

**Context.** [0241](0241-leaked-reach-probe-networks.md) found and fixed the earlier sources, and `mise run disk:report --fix probe-networks` removes unattached probe networks older than a day. Removing them is the user's call; this work did not.

**Investigation.** Not traced. The owner namespaces are one-off (one network each), which fits backends started on temporary data directories, as in 0241 task 1.

**Decisions.**

- **How to find the source?**
  - **Match the cluster times against build and test runs on beelink in those windows, then rerun the likeliest harness and diff the probe-network list (recommended).**
    - Pros: the method 0241 used; decisive.
    - Cons: needs the run history of those days.
  - **Add an owner-to-data-directory log line when a probe network is created.**
    - Pros: makes the next leak traceable at once.
    - Cons: new logging surface; does not explain these.

## Related

- [0241-leaked-reach-probe-networks.md](0241-leaked-reach-probe-networks.md)
- [7040-container-cells-on-real-cursor-and-pi.md](../agent-engines/7040-container-cells-on-real-cursor-and-pi.md)

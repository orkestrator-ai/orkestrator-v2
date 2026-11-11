# Two live Docker suite failures that predate S-0100

Found on 2026-11-05 while qualifying the egress gateway's name checks (S-0100) on Docker Desktop. Both fail the same way with an image from before that work, so neither comes from it.

## Task analysis

Analysed 2026-11-05 against `main` at `704809a20`. Task 2 acted on 2026-11-06
against `main` at `e6c3da899`.

### Tasks

1. **C22 fails on Docker Desktop before it creates anything**: the host reachability check answers `not-applicable`. Status: open.
2. **DNS rotation cannot start its resolver in the gateway**: `node` is not on the gateway's root PATH. Status: done (2026-11-06; a second defect behind it fixed too).

### 1. C22 fails on Docker Desktop before it creates anything

**Problem.** `container-live-network.test.ts`, "a restricted runtime reaches only the backend service port and not its siblings", expects `reachability.check("manual")` to be `reachable` and gets `not-applicable` on Docker Desktop, so the case never runs there.

**Context.** The check is Linux-only by design (`container-host-reachability.ts`); the test asserts its result unconditionally (`container-live-network.test.ts:150`).

**Investigation.** Failed in 10 ms with both `orkestrator-s0100:filter` (this work's image) and `orkestrator-v2:dev-01c4621f8529` (an image from before it), on Docker Desktop 29.9.2, macOS, arm64. The other three cases of the file passed with the new image.

**Decisions.**

- **How to fix the test?**
  - **Accept `not-applicable` on Docker Desktop and go on without the RootlessKit address (recommended).**
    - Pros: the case runs on Desktop again; Linux keeps the strict assertion.
    - Cons: the Desktop run does not exercise the reachability service.
  - **Skip the case off Linux.**
    - Pros: one line.
    - Cons: Desktop loses C22's sibling and host-port checks.

### 2. DNS rotation cannot start its resolver in the gateway

**Problem.** `container-live-egress-conditions.test.ts`, "rotated addresses are added…", runs `docker exec -u root <gateway> node -e …` and fails with `exec: "node": executable file not found in $PATH`.

**Context.** The gateway is created with `CONTAINER_ROOT_USER_ARGS` (`--env PATH=/usr/sbin:/usr/bin:/sbin:/bin`, security H2), and `node` is in `/usr/local/bin`.

**Investigation.** Failed the same way with both images above. CI's container workflow runs this case on every pull request that changes its paths, so it may already be red there.

It was: CI run 42128741746 (S-0100's PR, 2026-11-05) failed it with this
error on `ubuntu-24.04` and `ubuntu-24.04-arm`. On 2026-11-06, on a
disposable rootful Linux Engine on beelink, fixing only the PATH exposed a
second defect. The case's TCP probes sent a bare word (`probe`, `first`) as
their first write, and on an `egress-filter=1` gateway the name checks hold a
newline-less printable write, which could still become an HTTP request line,
so the first probe got no echo (`:464`). The firewall suite's policy 3 tuple
case had the same probe and failed in that CI run too (`:555`).

**Decisions.**

- **How to fix the test?**
  - **Run the resolver by absolute path, `/usr/local/bin/node` (recommended).**
    - Pros: one change; keeps the gateway's root PATH as H2 requires.
    - Cons: `/usr/local/bin/node` is root-owned in the image, but the test should keep to root-owned binaries, which it does.
  - **Pass a PATH with `/usr/local/bin` to that exec.**
    - Pros: the script stays unchanged.
    - Cons: reintroduces the pattern H2 removed, even if only in a test.

## Assumptions and decisions

### Task 2: absolute path, and whole-line probes

Took the recommended option: the resolver runs as `/usr/local/bin/node`, so
the gateway keeps H2's fixed root PATH. The probes' first writes in this case
and in the firewall tuple case now end in `\n`. The alternative was to change
the daemon to relay a bare word sooner, which would loosen a security
check for a test's sake; that question was to-do 7000 (retired 2026-11-11),
which kept the hold and documented it in
[container lifecycle](../../architecture/container-lifecycle.md#name-checks-egress-filter1). Result: DNS rotation
passed (with the IPv6 and daemon-restart cases, 3/3), and the tuple case
passed where its unfixed copy failed. Task 1 (C22 on Docker Desktop) was not
touched.

## Related

- [6101](6101-egress-name-checks-platform-coverage.md)
- 7000 (retired 2026-11-11): the newline-less first write the name checks hold, documented in [container lifecycle](../../architecture/container-lifecycle.md#name-checks-egress-filter1)
- [Container qualification](../../development/container-qualification.md#egress-name-checks-on-docker-desktop-2026-11-05)

# Two live Docker suite failures that predate S-0100

Found on 2026-11-05 while qualifying the egress gateway's name checks (S-0100) on Docker Desktop. Both fail the same way with an image from before that work, so neither comes from it.

## Task analysis

Analysed 2026-11-05 against `main` at `704809a20`. Task 2 acted on 2026-11-06
against `main` at `e6c3da899`. Task 1 re-checked and acted on 2026-11-11
against `main` at `498b68766`: the assertion was unchanged and the check still
answers `not-applicable` (`not-linux`) off Linux.

### Tasks

1. **C22 fails on Docker Desktop before it creates anything**: the host reachability check answers `not-applicable`. Status: open (the test is fixed and C22 passes on Linux, 2026-11-11; only the confirming C22 run on Docker Desktop is left, which needs a macOS node with Docker Desktop, not this Linux host).
2. **DNS rotation cannot start its resolver in the gateway**: `node` is not on the gateway's root PATH. Status: done (2026-11-06; a second defect behind it fixed too).

### 1. C22 fails on Docker Desktop before it creates anything

**Problem.** `container-live-network.test.ts`, "a restricted runtime reaches only the backend service port and not its siblings", expects `reachability.check("manual")` to be `reachable` and gets `not-applicable` on Docker Desktop, so the case never runs there.

**Context.** The check is Linux-only by design (`container-host-reachability.ts`); the test asserts its result unconditionally (`container-live-network.test.ts:150`).

**Investigation.** Failed in 10 ms with both `orkestrator-s0100:filter` (this work's image) and `orkestrator-v2:dev-01c4621f8529` (an image from before it), on Docker Desktop 29.9.2, macOS, arm64. The other three cases of the file passed with the new image.

Still true at `498b68766` (2026-11-11): the case asserted `reachable`
unconditionally, and `ContainerHostReachabilityService` returns
`not-applicable` with reason `not-linux` before any Docker work when the
platform is not Linux. Nothing later in the case depends on the check off
Linux: the check is only how a rootless Linux daemon learns RootlessKit's
host address, and `createDockerContainer` asks for it only for a rootless
topology, keeping `host-gateway` otherwise.

Fixed on 2026-11-11: C22 now expects `reachable` on Linux and
`not-applicable`/`not-linux` elsewhere (`expectedHostReachability`). A new
Docker-free case in the same file builds the real service with
`platform: "darwin"` and `"win32"` and a runner that throws if Docker is
called, and checks its answer matches that expectation and leaves no host
address, so a change to the check's off-Linux answer breaks the default suite
rather than the next Desktop run. Not run: C22 itself on Docker Desktop; this
host is Linux. On Linux the expectation is the old one, unchanged.

Linux run, 2026-11-11, on beelink against a disposable rootless daemon
(`mise run docker:disposable -- start --name q2150 --host-loopback`, Engine
29.9.2) with `orkestrator-v2:dev-a8114303dc70`, built from `main` at
`498b68766`. The whole network file passed 4/5 in 45.6 s: the new Docker-free
case, C24 and C26 passed. C22 passed its reachability assertion (`reachable`),
then failed starting its egress gateway with `port-conflict` after three
automatic-port retries (32778–32780). That is the rootless collision already
recorded in
[Container qualification](../../development/container-qualification.md#rootless-re-run-on-a-freshly-built-image-2026-11-09):
RootlessKit binds the inner daemon's port choice on the host, where something
else held it. Run again on its own (`-t C22`), C22's block passed in 19.4 s.
Without the qualification image the file runs 1 pass and 4 skips in the
default suite.

**Decisions.**

- **How to fix the test?**
  - **Accept `not-applicable` on Docker Desktop and go on without the RootlessKit address (recommended, taken 2026-11-11).**
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
check for a test's sake; that question is recorded as
[7000](7000-name-checks-hold-newline-less-first-writes.md). Result: DNS rotation
passed (with the IPv6 and daemon-restart cases, 3/3), and the tuple case
passed where its unfixed copy failed. Task 1 (C22 on Docker Desktop) was not
touched.

### Task 1: accept the check's off-Linux answer, keep Linux strict

Took the recommended option. The expectation keys on `process.platform`, the
same input the service uses, and names the reason (`not-linux`) as well as the
status, so a Desktop run still fails if the check ever answers
`not-applicable` for another reason (`docker-remote`) or stops answering
`not-applicable` off Linux. Docker Desktop for Linux reports platform `linux`,
so it keeps the strict assertion, as it should: the check runs there.

### Task 1: the remaining Desktop run stays here

The confirming C22 run needs a macOS node with Docker Desktop. That is a fleet
node an agent can use, not human-only work, so it stays in this file rather
than moving to the manual-test checklist. Run it as in
[Container qualification](../../development/container-qualification.md#egress-name-checks-on-docker-desktop-2026-11-05):
`RUN_LIVE_DOCKER_TESTS=1 ORKESTRATOR_QUALIFICATION_IMAGE=<image> bun test
./tests/container-live-network.test.ts` from `apps/backend`, and record the
date, Docker Desktop version and pass count in task 1.

## Related

- [6101](6101-egress-name-checks-platform-coverage.md)
- [7000](7000-name-checks-hold-newline-less-first-writes.md)
- [Container qualification](../../development/container-qualification.md#egress-name-checks-on-docker-desktop-2026-11-05)

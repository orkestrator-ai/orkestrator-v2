# Bridge credential fixture automatic-port collision on rootless Docker

- **ID:** 9804
- **Status:** resolved
- **Observed:** 2026-11-14 on beelink (kernel 7.1.8-arch1-3, x86_64), a
  `mise run docker:disposable` rootless daemon (Engine 29.9.2, RootlessKit
  3.3.0, slirp4netns 1.3.3, builtin port driver), base `dc90609bf`.
- **Test:** every case of the file; the failure is in its `beforeAll`
  (`startFixture`), reported by Bun as `(unnamed)`.
- **File:** `apps/backend/tests/bridge-credential-docker.test.ts`

The first whole-file run on the daemon passed (12 passed, 1 skipped, 39.9 s).
The second, a minute later with the same image and
`ORKESTRATOR_QUALIFICATION_OLDER_IMAGE` added, failed after 534 ms before any
case ran: the fixture's bare `docker run` published six ports as
`127.0.0.1::<port>` and the daemon answered `RootlessKit
PortManager.AddPort(): listen tcp4 127.0.0.1:32776: bind: address already in
use` (exit 125). The daemon held no container, network or volume afterwards.
Evidence: `/tmp/orkestrator-test-run.DLamTn`.

Command, through `mise run test:logged` with the daemon's `env` variables,
the `docker-qualification-bin` shim first on `PATH`,
`ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, `RUN_LIVE_DOCKER_TESTS=1` and
`ORKESTRATOR_QUALIFICATION_IMAGE=orkestrator-v2:dev-d4b4afafd7e4`:

```bash
bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
  ./tests/bridge-credential-docker.test.ts --parallel=1
```

**Cause.** The one recorded in [container-host-ports.ts](../../../../apps/backend/src/core/container-host-ports.ts)
and to-do 7549 task 4: a rootless dockerd draws automatic ports in sequence
from a range in RootlessKit's namespace and cannot see host sockets, so
RootlessKit's host bind collides with whatever host socket holds the port.
The backend's own create stopped using Docker's automatic ports on rootless
daemons on 2026-11-11; this fixture runs `docker run` itself and still did.

**Fix.** On a rootless daemon the fixture now gives every published port a
host port chosen with `chooseBackendHostPorts`, the backend's own choice.
No assertion or budget changed. Afterwards the fixture started on the first
attempt in all nine runs of the file on the same daemon: three in which only
a then-new case of the same change failed on its own assertion (13 passed,
1 failed; corrected), then six in a row with 14 passed (43.0 s to 91.4 s).

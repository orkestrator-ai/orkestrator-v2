# Claude's Linux sandbox fails every command under Ubuntu's AppArmor bwrap profile

Found on 2026-10-25 by todo 0030's CI probes on GitHub's `ubuntu-latest`
runner, which is now Ubuntu 26.04 (kernel 7.0). Checked against `main` at
`20f6de91`.

On that host, with `bwrap` and `socat` installed, the pinned Claude CLI
(2.1.309) starts its command sandbox, but every sandboxed command fails before
it runs:

```text
Exit code 1
apply-seccomp: write /proc/self/setgroups (nested userns is capability-restricted; caller must provide CAP_SYS_ADMIN): Permission denied
```

Orkestrator still reports such a host as able to sandbox Claude, so a Claude
coordinator shows `enforced` and then cannot run a single reading command, and
an interactive session with the provider sandbox fails every Bash call.

## Current state

- **Cause, confirmed on CI.** The CLI runs each command under bubblewrap and
  then its `apply-seccomp` helper, which creates a user namespace nested inside
  bubblewrap's. Ubuntu's AppArmor package ships a `bwrap-userns-restrict`
  profile (`/etc/apparmor.d/bwrap-userns-restrict`, with `unpriv_bwrap`) that
  lets bubblewrap create its namespace but strips capabilities from anything
  nested in it. Probe run 40195484352 (2026-10-25):
  - `kernel.apparmor_restrict_unprivileged_userns=0`: still fails (that sysctl
    only covers the first namespace).
  - Also `kernel.apparmor_restrict_unprivileged_unconfined=0`: still fails.
  - Also unloading `bwrap-userns-restrict` and `unprivileged_userns` with
    `apparmor_parser --remove`: a nested `unshare --user --map-root-user`
    inside bubblewrap works, and all 8 cases of
    `bridges/claude-bridge/src/conformance-coordinator-sandbox-live.test.ts`
    pass.
- **CI is fixed, not the product.** `.github/workflows/ci.yml` now applies the
  three changes above and checks a nested user namespace before the tests
  (todo 0030). A user's Ubuntu host is unchanged.
- **The host probe misses it.** `defaultCoordinatorHostCapabilities`
  (`apps/backend/src/core/coordinator-providers.ts`) reports
  `claudeSandbox: true` on Linux whenever `bwrap` and `socat` are on `PATH`
  (`CLAUDE_LINUX_SANDBOX_PROGRAMS`). The CLI agrees, since it checks only for
  the programs, so `failIfUnavailable` does not trip either.
- **Not verified:** whether Ubuntu 24.04 behaves the same (its AppArmor 4
  package also restricts unprivileged user namespaces), other distributions
  with AppArmor, and Docker containers (where nested namespaces depend on the
  container's seccomp profile and capabilities).

## Outstanding work

### Code

1. **Probe the nested namespace, not only the programs.** On Linux, decide
   `claudeSandbox` by running what the CLI needs: bubblewrap creating a user
   namespace with a nested one inside it (for example
   `bwrap --unshare-user --ro-bind / / --dev /dev --proc /proc -- unshare --user --map-root-user true`),
   bounded and cached per process. A host that fails it is reported as
   `provider-configured` with a reason naming the AppArmor profile, the same
   way a host missing `bwrap` or `socat` is today. Unit-test both outcomes
   with an injected runner.
2. **Tell the user what to do.** The reason text and
   `docs/architecture/coordinator.md` should say how to allow it (an AppArmor
   profile that permits nested namespaces for the CLI's helper, or unloading
   `bwrap-userns-restrict` on a dedicated host) and what each choice costs.
   Decide whether Orkestrator should ship such a profile; it should not change
   a user's AppArmor policy itself.
3. **Interactive provider sandbox.** The same failure hits a Claude session
   whose execution policy asks for the provider sandbox
   (`claudeExecutionSandbox`, `bridges/claude-bridge/src/services/claude-execution-sandbox.ts`).
   Decide whether the backend should refuse that policy up front on such a
   host, with the same reason, instead of letting every Bash call fail.

### Qualification

- Run the coordinator sandbox qualification on a stock Ubuntu 24.04 host and a
  stock 26.04 desktop, with and without the profile change, and record the
  tier Agent Info shows. Batch with
  [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md).

## Constraints and rationale

- Do not weaken the coordinator's sandbox to make it start: a coordinator at
  `enforced` must have containment that works, and one that cannot get it
  must say so (`provider-configured`), as todo 0026 decided for hosts missing
  `bwrap` or `socat`.
- The CI change is acceptable on a disposable runner only; it is not advice
  for a shared host.

## Open questions

- Does a newer Claude CLI drop the nested namespace, or offer a setting that
  avoids it, which would make the probe unnecessary?

## Needs verification

- Ubuntu 24.04, Debian with AppArmor, Fedora (SELinux) and Docker containers.

## Related

- [0026-coordinator-read-only-adapters.md](../coordinator-and-multi-review/0026-coordinator-read-only-adapters.md):
  the Claude coordinator tier and its Linux item.
- [0030-test-suite-and-ci-health.md](../cross-cutting/0030-test-suite-and-ci-health.md):
  where this was found, the CI probe runs and the workflow change.

## Replaces

Nothing.

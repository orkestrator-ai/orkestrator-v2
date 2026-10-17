# 05 — Own component-browser fixture servers

Status: Not started. Depends on: none. Finding: T4.

[Plan index](00-index.md) · [Previous](04-runner-consistency-and-scope.md) ·
[Next](06-ci-failure-evidence.md)

## Outcome and implementation choice

Make it impossible for a component-browser run to silently use the fixture
server from another worktree. The first implementation should disable implicit
reuse everywhere and fail clearly on the occupied fixed port. This is sufficient
to close T4 with a small, reviewable change.

Dynamic per-run ports are a later throughput improvement if measured contention
justifies the extra lifecycle code. Do not make them a prerequisite or implement
a check-free-port-then-bind sequence that introduces a new race.

## Owners

- `e2e/playwright.config.ts`: fixture URL, server command, reuse, output paths.
- `e2e/fixture/`: synthetic component fixture and possible identity endpoint.
- `apps/web/vite.config.ts`: fixture server behavior.
- `.orkestrator-test-scheduler.json`: exact command/resource profiles.
- `mise.toml`: component-browser task.
- `docs/development/testing-guide.md`: local and in-app use.

## Implementation tasks

- [ ] Disable reuse for local as well as CI component tests. Preserve strict
      port binding so a conflict cannot silently choose an unexpected port.
- [ ] Make startup failure identify the owned test fixture/port and explain
      that an existing server is not accepted. Never stop the existing process
      automatically: it may belong to another worktree or a manual session.
- [ ] Keep Playwright responsible for the server it starts and ensure cleanup
      follows normal completion, assertion failure, startup timeout, and signal
      cancellation. No detached fixture subprocess should remain.
- [ ] Preserve the current `host:tcp:1422` scheduler resource while the port is
      fixed. Keep workspace-local output resources distinct from host resources.
- [ ] Ensure direct task execution and the logged wrapper share the same
      configuration; neither may enable implicit reuse as a convenience.
- [ ] Give concurrent attempts distinct report/artifact locations where needed
      so a rejected attempt cannot overwrite the running attempt's diagnostics.
      Bound/sanitize run IDs and keep all output in approved artifact roots.
- [ ] Update operator guidance: stop an owned prior fixture normally, or wait
      for the resource, rather than disabling the ownership guard.

## Required reproduction

Create two temporary worktrees or equivalent isolated fixture roots with an
obvious fixture difference. Start A's fixture server. Launch B's component
command and prove it rejects the occupied server before running assertions.
Stop A through its owner, then launch B and prove it exercises B's fixture.

Repeat with an unrelated HTTP server on the same port. Its healthy HTTP response
must not be accepted as proof that B's app is ready. Assert A/unrelated process
is still alive after B fails.

## Lifecycle matrix

| Event | Required result |
| --- | --- |
| Normal completion | Fixture process exits; report belongs to this run |
| Test assertion fails | Fixture exits; failure trace/report survives |
| Port already occupied | Explicit startup failure; no test execution against existing server |
| Startup timeout | Only owned startup processes are terminated |
| User cancels logged run | Wrapper and fixture process tree drain |
| Two in-app validations | Shared port reservation serializes them |
| Manual run conflicts with scheduled run | Binding conflict remains explicit; no unsafe cleanup |

Prefer a small process-level regression for ownership rather than asserting
only that a configuration property is false. Reuse the repository's bounded
command/process helpers for any new harness.

## Optional later design: unique ports

If serial port contention is material, add an owner launcher that binds once
to an OS-assigned loopback port and publishes its actual URL plus opaque run
identity through a private bounded channel. Playwright receives that URL and
checks identity. The launcher owns termination and readiness; it does not probe
and release a port before the server claims it.

Only then remove the fixed host-port profile. Keep per-workspace report resource
exclusion unless outputs are also isolated. Validate worktree identity without
exposing absolute source paths in general logs. This enhancement is not required
for this step's completion.

## Verification and acceptance

Run the ownership regression and the existing component-browser suite using
`mise run test:logged -- --name browser -- mise run test:browser`.
Check desktop/mobile projects, retained failure evidence, and surviving PIDs.
Run the appropriate task/config tests and handoff checks from the index.

Acceptance: two worktrees cannot silently test each other's frontend; failures
remain diagnosable and cleanup never reaches an unowned server.

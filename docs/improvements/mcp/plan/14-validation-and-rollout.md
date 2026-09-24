# 14 — Verify behavior, migrate safely and release in stages

Status: partly done — automated coverage listed in
[mcp-management.md](../../../architecture/mcp-management.md#verification-status); the rollout switch and kill switch
(`global.mcpManagement`) exist with everything enabled by default. The provider completion matrix, live-provider
evidence and container QA are outstanding. Depends on: 01–13. [Plan index](00-index.md).

## Source of truth for test execution

Read [testing-guide.md](../../../development/testing-guide.md) before selecting
commands and [agent-testing.md](../../../development/agent-testing.md) before
real-stack QA. Use mise for repository workflows, Bun for explicit focused files,
and `test:logged` for agent-operated checks. A docs-only investigation does not
constitute passing any of the implementation gates below.

If implementation changes Bun tests, apply the repository's Bun testing skill and
isolation guidance. Do not add broad module mocks that pollute sibling suites.
Use real parsers and temporary files for persistence, plus narrow fake provider
clients for deterministic runtime scheduling.

## Layered test coverage

| Layer | Required evidence |
| --- | --- |
| Protocol | Valid/invalid DTOs, capability gating, exact byte/count bounds, secret-free serializers |
| Target resolver | Custom homes/XDG, remote backend, two worktrees, container incarnation, policy restrictions |
| Native writers | JSON/JSONC/TOML preservation, CRUD/rename, stale revisions, no data loss, filesystem failures |
| Management service | Request idempotency, partial success, queue bounds, crash recovery, supersession and cancel semantics |
| Provider adapters | Pinned API shapes, saved versus runtime behavior, actual tool disappearance after removal |
| Transport | Authentication, old bridge response, bounded bodies/errors, revision-gap reconciliation |
| UI | Complete flows, errors/conflicts, secret controls, stale target races and accessibility |
| Real stack | Browser reload, inactive environment, background turns, protected internal tools |
| Containers | Copy/materialization, private overlays, host isolation, restart/recreation and external divergence |
| Remote browser | Correct backend paths, operation recovery, OAuth capability/callback behavior |

## Shared persistence fixtures

Every writer should run the same semantic cases, with provider-native fixtures:

1. Empty/missing file; first definition; edit one field; rename; last definition
   removed; unrelated root settings and other definitions unchanged.
2. Unknown advanced fields, comments where supported, Unicode names/values,
   executable paths with spaces and argument arrays containing shell characters.
3. Name collisions within a source and across scopes; shadowing and revealed
   fallback; disabled inherited definitions; plugin/managed/protected origins.
4. Existing secret kept, replaced, cleared, moved to another header/env key and
   preserved during a non-secret edit; literal secret rejected in basic project
   editing; URL/argument sentinels redacted.
5. Malformed/oversized source; permission denied; read-only mount; parent/source
   symlinks; changed inode; disk full; interruption before/after rename.
6. Concurrent edits from two UI clients and an external editor; stale revision;
   repeated request id; lost success response; crash before the operation record
   is marked saved; recovery without duplicate mutation.

Use adversarial synthetic names/values. Verify **absence** of sentinels from public
responses, logs, event frames, operation summaries, browser state and diagnostics.
Never use real provider credentials as test assertions or snapshots.

## Provider completion matrix

Fill a result for each advertised writable scope; leave unsupported cells marked
with an explicit reason, not a fabricated pass.

| Provider | Add/edit/rename/remove durable | Actual tools after apply | Two-session/busy behavior | Restart/restore | Auth limitation verified |
| --- | --- | --- | --- | --- | --- |
| Claude | Pending | Pending | Pending | Pending | Pending |
| Codex | Pending | Pending | Pending | Pending | Pending |
| OpenCode | Pending | Pending | Pending | Pending | Pending |
| Cursor | Pending | Pending | Pending | Pending | Pending |
| Grok | Pending | Pending | Pending | Pending | Pending |
| Pi | Pending | Pending | Pending | Pending | Pending |

For removal, prove a subsequent harmless tool call cannot invoke the removed
fixture's tool. Where a lower-priority definition becomes effective, verify that
specific fallback's identity instead. Status-only assertions are insufficient.
No provider may silently substitute a fresh conversation when resume fails.

## Mandatory inactive-environment scenario

1. In isolated fixture environment A, run a bounded task long enough to keep its
   provider busy; record provider/session identity without prompt contents.
2. Save and apply an MCP edit while that runtime is busy. Confirm saved plus
   pending state and uninterrupted work.
3. Switch to environment B so A's initiating React tree unmounts.
4. Let A finish and the backend apply at its provider-specific safe boundary.
   Include an auth-required or failed-server variant where useful.
5. Return to A. Verify source revision, apply outcome, actual current tools,
   connection status, pending interaction and available controls.
6. Reload the browser and verify the same state from snapshots.
7. Repeat with a dropped event connection and with a bridge generation change.

Run a shared-user variant affecting two environments and a process-wide variant
affecting two Codex/OpenCode sessions. A single idle tab is not evidence that a
shared process is safe to restart. Check that configuration discovery does not
defeat idle detachment or hydrate entire transcripts.

## Focused and aggregate commands

Use exact test files introduced by the implementation. These examples describe
the command shape; replace placeholder paths with real owning files:

```bash
mise run test:logged -- --name mcp-protocol -- \
  bun test ./packages/protocol/src/mcp-management.test.ts \
  --parallel=1 --only-failures

mise run test:logged -- --name mcp-backend -- \
  bun test --cwd apps/backend --preload ../../tests/setup-node.ts \
  ./src/core/mcp-management/source-store.test.ts --parallel=1 --only-failures

mise run test:logged -- --name mcp-pi -- \
  bun test ./bridges/pi-bridge/src/mcp.test.ts --parallel=1 --only-failures

mise run test:logged -- --name mcp-check -- mise run check

mise run test
```

Run commands separately, inspect their exit status and read bounded failure
artifacts from `test:logged`. `test:changed` is useful while iterating but does not
replace final `mise run test`. Add the real OpenCode cancellation regression and
existing bridge/Control MCP regressions when their owners change.

If package metadata or dependencies change, regenerate every tracked lockfile
with the pinned Bun version, verify frozen installs and run version-drift coverage
as required by `AGENTS.md`. Do not update generated Codex protocol casually.

## Real browser and environment QA

Use a unique profile such as `agent-mcp-management`:

```bash
mise run dev:test --profile agent-mcp-management --fixture
mise run dev:status --profile agent-mcp-management --json
mise run dev:login --profile agent-mcp-management
```

Start the supervisor in a long-lived session. Discover the exact `browserUrl` and
fixture from status; use the single-use login URL and never expose the gateway
token. Do not add this source checkout as a test project. For container tests,
start the profile with `--fixture-environments local,container` using the current
guide's options and fixture ownership rules.

Run browser smoke, the primary add/edit/remove flow, desktop and narrow viewport,
keyboard focus, conflict recovery, secret replacement and the inactive scenario.
Use credential-free runs for passive config and fake-MCP cases; use the guide's
authorized provider credentials only for the isolated live adapter verification
that requires them. Bound real agent work and record no prompt/file contents.

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=agent-mcp-management \
ORKESTRATOR_AGENT_TEST_RUN_ID=agent-mcp-management \
mise run test:logged -- --name mcp-agent-browser -- mise run test:agent:browser

ORKESTRATOR_AGENT_TEST_PROFILE=agent-mcp-management \
mise run test:logged -- --name mcp-agent-docker -- mise run test:agent:docker
```

Use Electron-specific tests only when native main/preload/clipboard/navigation
behavior changes. For ordinary editor interactions, the real browser is the
default. The aggregate suite does not substitute for browser/container coverage.

Finish with exact-owner cleanup, even after a failure:

```bash
mise run dev:stop --profile agent-mcp-management
mise run dev:reset --profile agent-mcp-management
```

## Migration and rollout

1. Ship passive discovery and provenance behind the management capability gate.
   Opening settings must cause no native-file migration or server execution.
2. Enable backend-user/project writes per adapter after its writer and apply
   evidence passes. Older bridges remain readable with clear management limits.
3. Enable environment-private container writes only after durable overlay and
   recreation tests pass. Do not use an ephemeral file-write MVP under the same
   permanent-looking UI label.
4. Keep existing native configs in place. For duplicate/invalid/unknown fields,
   provide inspection and repair guidance; never import them automatically into
   a replacement universal registry.
5. Version only new operation/overlay storage. Make migrations bounded and
   recoverable; preserve native definitions if the feature is disabled again.
6. Before removing a rollout gate, complete the six-provider matrix and confirm
   protected internal MCP behavior, terminal limitations and remote scope labels.

Rollback disables management mutations and stops scheduling new applies. Native
config already saved remains usable by providers. Queued jobs can be retired with
an explicit state; in-flight work reconciles. Do not restore stale native backups
or erase overlays simply because a UI feature is rolled back. Document how an
older application handles newer overlay schema without overwriting it.

## Documentation and handoff evidence

Update the living documentation catalog and agent-engine/operator docs when the
feature ships. Mark this plan's steps with actual completion evidence rather than
percentages inferred from code presence. Update the old SDK inventory plan to
link to the new configuration-management documentation without rewriting its
historical scope.

Record tested commit, provider pins, platform/scope matrix, exact commands and
counts, profile and viewport, failure artifact paths, known limitations and
skips. Report an unavailable Docker or live-provider test concretely; do not call
an untested provider complete. Follow the existing flaky-test registry procedure
for aggregate-only failures instead of deleting or loosening coverage.

## Final release criteria

- [ ] Each advertised provider/scope supports durable CRUD with correct provenance.
- [ ] Shared-user and container lifecycles preserve ownership and conflict safety.
- [ ] Actual tools match the reported applied revision after changes and restart.
- [ ] Background turns and approvals remain correct across navigation and failures.
- [ ] Secret/public-boundary assertions and protected-server tests pass.
- [ ] Required focused, static, aggregate, browser and container checks pass.
- [ ] Unsupported transports/auth/terminal paths have honest user-facing behavior.
- [ ] No test profiles, owned containers or temporary credential-bearing artifacts
  remain unintentionally live at handoff.

# Isolated Development Mode and Agent Testing

## Status

Implemented. The operational runbook is
[`development/agent-testing.md`](development/agent-testing.md); test output and
retention details are in [`test-logs.md`](test-logs.md).

This document records the delivered architecture and its invariants. It replaces
the original proposal, whose “current state” and phased implementation list had
become misleading after the profile launcher and real-stack suites shipped.

## Delivered workflow

An isolated profile can be started, inspected, tested, stopped, and reset with:

```bash
bun run dev:test -- --profile agent-123 --fixture
bun run dev:status -- --profile agent-123 --json
bun run dev:stop -- --profile agent-123
bun run dev:reset -- --profile agent-123
```

The launcher selects free loopback ports, compiles and starts Vite/Electron and
the standalone backend, optionally seeds a disposable Git fixture, and writes an
atomic readiness manifest. Repeating `dev:test` for a live profile is
idempotent. `dev:status --json` is the authoritative source for the browser URL,
window title, fixture path, logs, authentication-file path, and owned PIDs.

The browser, Electron, and optional Docker agent suites exercise the real stack:

```bash
ORKESTRATOR_AGENT_TEST_PROFILE=agent-123 \
ORKESTRATOR_AGENT_TEST_RUN_ID=agent-123 \
bun run test:logged -- --name agent-browser -- bun run test:agent:browser

bun run test:logged -- --name agent-electron -- bun run test:agent:electron

# Profile must have been seeded with local,container environments.
ORKESTRATOR_AGENT_TEST_PROFILE=agent-container \
bun run test:logged -- --name agent-docker -- bun run test:agent:docker
```

## Isolation model

Each normalized runtime profile owns separate mutable state:

```text
<development-root>/profiles/<profile-id>/
├── profile.json
├── .orkestrator-dev-profile
├── data/
├── runtime/status.json
├── logs/
├── worktrees/
└── fixtures/
```

The resolved profile carries its flavor, identity, data/runtime/worktree/log
paths, Docker owner and image, loopback renderer/gateway addresses, and visible
Electron identity through every process boundary. Production data paths, image
tags, containers, projects, sessions, prompts, and settings are not shared.

Agent-test profiles may inherit the host login for explicitly supported agent
providers. `--credential-source <provider>` narrows this and
`--no-agent-credentials` disables it. Credential material is referenced through
owner-only files; it is never placed in the status manifest, URL, logs, traces,
or reports. On macOS, startup brokers only the named records belonging to an
authorized Keychain-backed provider; the complete host Keychain is never linked
into the isolated `HOME` — see
[`credentials-and-models.md`](credentials-and-models.md). Bounded model-catalog caches are seeded only when missing so signed-
out picker testing remains representative without copying user state.

## Safety invariants

1. Production and development never share a mutable data directory.
2. Two profiles never share mutable data, worktrees, ports, Docker ownership, or
   Electron `userData`.
3. Development binds only to loopback and never configures machine-wide
   Tailscale Serve state.
4. Development Docker operations require the exact profile owner label, ignore
   ownerless or foreign resources, and never overwrite the production image tag.
5. The fixture copy is the only project used for destructive/manual workflows;
   the live Orkestrator checkout is never registered as the test project.
6. Reset validates the profile sentinel and resolved target, refuses broad or
   production paths, and removes only exact-owner resources.
7. Stop validates PID identity/start time and signals the owned process tree; it
   never kills by executable name or port.
8. Long-running state remains backend-owned. UI events are incremental hints;
   reload and inactive-environment tests must prove snapshot rehydration.
9. Status, logs, metrics, screenshots, traces, and reports contain no gateway
   tokens, credentials, prompts, terminal contents, attachment data, or file
   contents.

## Bounded evidence and logs

The profile log directory contains launcher, Vite, Electron, backend, build, and
optional Docker-build diagnostics. Streaming Vite/Electron writers are
serialized and rotate at 4 MiB, retaining at most one previous segment. Rotation
renames the file; it never reads the accumulated log into memory.

Playwright artifacts are redacted after the run. Sanitization has explicit
limits of 16 MiB per regular file, 5,000 files, and 256 MiB per artifact tree;
trace archives are checked again after extraction. Evidence that exceeds a bound
or cannot be redacted is deleted and fails the suite.

Unit, integration, typecheck, build, and smoke output uses `test:logged`. The
aggregate runner streams independent groups concurrently, limits total worker
pressure, deletes raw passing logs, compresses bounded failing logs, and prunes
completed runner-owned directories after seven days. See
[`test-logs.md`](test-logs.md) for exact limits.

## Verification contract

For a frontend or gateway change, establish focused typecheck/test health before
real-stack QA. Then verify the primary path, reachable empty/loading/success/error
states, reload rehydration, and accessible behavior. Layout changes require both
normal and narrow viewports. Background behavior additionally requires:

1. Start work in one environment or tab.
2. Switch away so its React tree may unmount.
3. Let backend-owned work progress or finish.
4. Return and verify status, output, interactions, and controls.
5. Reload and verify the same result from an authoritative snapshot.

Electron-only behavior uses the exact window title from status. Normal UI and
agent-chat paths use the authenticated loopback browser. Docker QA remains
opt-in because it builds and starts the workspace-specific development image.

For every failure, record the profile, commit/worktree, exact command, worker
configuration, exit status and counts, concise reproduction, expected/actual
result, and the bounded artifact path. State concrete reasons for skipped flows.

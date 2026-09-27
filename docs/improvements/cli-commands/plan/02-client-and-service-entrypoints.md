# 02 — Separate client commands from service startup

Status: Verified — see record.
Index: [CLI commands plan](00-cli-commands-index.md).

## Target behavior

`orkestrator serve` and the existing no-subcommand/server-flag forms run the
foreground backend. Help, version, and client commands never initialize a
backend, create its data directory, or start bridge/listener processes.

## Owners and starting points

- [Executable shim](../../../../packages/cli/bin/orkestrator.js).
- [CLI build](../../../../packages/cli/scripts/build.ts) and
  [package tests](../../../../packages/cli/tests/cli.test.ts).
- [Backend main](../../../../apps/backend/src/main.ts) and
  [options](../../../../apps/backend/src/options.ts).
- Proposed `packages/cli/src/` parser, client entrypoint, and output modules.

## Work

1. Inventory accepted legacy server arguments from `parseOptions`, README,
   packaged tests, and launchers. Build a compatibility fixture for them before
   changing the shim. Preserve environment/resource-root defaults for service
   startup and forward caller-provided values unchanged.
2. Parse the mode before importing the backend. Add a separately bundled client
   entrypoint, with shared pure parser helpers if needed. Do not import backend
   `main.ts`, storage, desktop startup, or provider packages in the client path.
3. Preserve zero-argument foreground startup; recognize explicit `serve` and
   legacy server-only flags. Unknown commands/flags fail rather than falling
   through to service mode. Reject client/server flag mixtures and conflicting
   selectors with an actionable message.
4. Implement help and version entirely locally, including nested help. Give
   script users stable option spelling, operand parsing, `--` handling, duration
   parsing, duplicate-option policy, and mutually exclusive output options.
5. Implement the step-01 stdout/stderr contract once for every command. Honor
   requested JSON even for validation errors when the output option can be
   recognized. Disable terminal decoration in machine modes.
6. Keep credentials and payloads out of parser diagnostics. Parse prompt/patch
   file paths here but perform bounded reads in the relevant command owner.
7. Route SIGINT/SIGTERM deliberately: service mode keeps existing shutdown;
   client mode releases transport resources and preserves any mutation receipt.
   Client shutdown must not call backend shutdown or stop an environment.
8. Update build inputs/outputs and the packed-file manifest as needed. Avoid a
   dependency upgrade for a small parser. If a parser dependency is chosen,
   justify it and follow the repository's lockfile rules.

## Verification

Run subprocess tests for no args, explicit serve, representative legacy flags,
nested help, version, invalid commands, mixed flags, missing values, `--`, and
JSON errors. In help/client cases use a disposable candidate data directory
and assert no creation, listener, readiness message, or backend child occurs.
Assert prompt-like argument strings are not echoed on failure.

Keep real packaged service readiness and graceful-shutdown coverage. Add a
packed client smoke to step 15 immediately; source-entrypoint tests alone do
not prove the distributed executable takes the correct branch.

## Acceptance and handoff

- [x] Existing launcher invocations still serve and stop cleanly.
- [x] `serve` reaches the same backend lifecycle as legacy startup.
- [x] Help/version run without a backend or backend credentials.
- [x] Client invocations do not import service initialization.
- [x] Output and parser behavior match step 01 in subprocess tests.

Keep the service/client split independently revertible. Do not remove the
legacy startup form as part of this feature; any later deprecation is a
separate compatibility decision.

## Implementation record

Revision: working tree on `a9337716`, 2026-09-26.

- Launcher [`packages/cli/bin/orkestrator.js`](../../../../packages/cli/bin/orkestrator.js)
  imports `dist/client.js` first; [`src/client.ts`](../../../../packages/cli/src/client.ts)
  classifies argv (historical service forms and `serve` → service; groups,
  `help`, `version` → client; typos refused, values never echoed).
- `serve` and legacy forms reach the same `main.ts`; server flags have one
  inventory (`apps/backend/src/server-flags.ts`, scan-based test in
  `options.test.ts`).
- Tests: `client-parsing.test.ts` (13), `cli-client.test.ts` (help/version/errors
  never initialise a backend; descriptor lifecycle), `cli.test.ts` artifact
  list includes `dist/client.js`; `mise run smoke:cli` against the installed
  tarball.

# Claude bridge persisted-token cases rejected under aggregate load

- **ID:** 0775
- **Status:** open
- **Date observed:** 2026-10-24
- **Tests:**
  - `Electron backend command registry > authenticates the persisted Claude token when a bridge arrives between health checks`
  - `Electron backend command registry > replaces a healthy Claude bridge when its persisted token does not authenticate`
- **Owning file:** `apps/backend/tests/commands-registry-servers.test.ts`
- **Original command:** `mise run test:logged -- --name full-suite-2 -- mise run test` on node mbp3, branch `todo-0041-control-mcp-voice-4a2c0ccc548b` rebased onto `main` at `a5d78cfc`.
- **Worker configuration:** the default aggregate host-capacity plan (workspace, root, bridge and protocol groups concurrently).
- **Failure:** `start_claude_server` rejected instead of resolving (`expect(received).resolves.toEqual(expected)`, line 1875, after 3,415.90 ms); the log beside it shows `[agent-accounts] Failed to sync the Claude login into the container: failed to connect to the docker API at unix:///tmp/orkestrator-no-docker-<pid>.sock`.
- **Suite counts:** backend: 10,866 tests across 639 files, 10,734 passed, 115 skipped, 17 failed (these two, case 0244, and 14 OpenCode execution-policy conformance cases that fail on `main` because #1198 moved the pin to 1.19.4 while the test expects 1.19.0) in 626.64 s.
- **Failure evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.NcXAI6/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `bun test ./tests/commands-registry-servers.test.ts` from `apps/backend` passed unchanged: 26 pass, 0 fail.
- **Hypothesis:** the container Claude-login sync that `main` added for agent accounts (#1210, #1213) runs against the fake Docker socket and, under aggregate load, its failure path or timing reaches `start_claude_server`'s promise. The change being validated (Control MCP credentials and gateway) does not touch bridge start, agent accounts or Docker. Unconfirmed.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** the rejection reason from `start_claude_server` was not recorded. The container login sync catches and logs its own failure and returns false (`agent-accounts-containers.ts:771`), so that log line alone should not reject the start; the hypothesis is weaker than it reads. No later commit changes the two cases.
- **Next step:** on recurrence, record the rejection message. Check whether these two cases inject container runners, so the sync never reaches the fake Docker socket. Related: [0750](../environments-and-containers/0750-container-server-startup-aggregate-timeout.md) (same file).

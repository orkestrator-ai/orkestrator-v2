# Test suites that depend on the host

Status: Active — found 2026-10-14, not fixed.

**Severity: medium.** These failures are not product regressions, but they
make the validation suites fail on an ordinary developer machine. That hides
real failures and makes every branch's evidence harder to read. Each one below
fails identically on the base commit `d4dfa11d`.

## Real-stack browser suite (`e2e/agent-testing/`)

Context: `mise run test:agent:browser:isolated` cannot start on this host
because of the startup dialog (`03-startup-claude-login-dialog.md`). With
OpenCode provisioned to avoid the dialog
(`dev:test --fixture --no-agent-credentials --agent-platforms codex,opencode,cursor,grok`
plus `mise run test:agent:browser`), the suite ran 17 passed, 12 skipped and 5
failed. Four of those fail the same way on base:

| Spec | Failure | Likely cause |
| --- | --- | --- |
| `browser-gateway.spec.ts:477` "real browser gateway exercises an authoritative local environment" | `expect(hydrated.worktreePath!.includes("/worktrees/")).toBe(true)` received `false`; the path was `/Volumes/Lexar/workspaces-dev/<profile>/…` | New dev profiles take their worktree root from the user's configured dev worktree folder (`apps/desktop/scripts/dev/lifecycle.ts:154-161`, `configuredDevWorktreeRoot`). The spec assumes the profile-local default. |
| `browser-gateway.spec.ts:1706` "local environment move survives inactive navigation and reload" | Expected the moved path under `fixtures/move-qa-*/first/…`; received `/Volumes/Lexar/workspaces-dev/<profile>/…` | Same configured worktree root. |
| `browser-gateway.spec.ts:1553` "review validation queues across worktrees and runs while its environment is inactive" | Expected `"queued"`, received `"passed"` | The queueing case relies on the simulated two-slot host that only the one-shot runner sets (`ORKESTRATOR_TEST_SCHEDULER_DIR`, `ORKESTRATOR_TEST_HOST_WORKERS=2`, `ORKESTRATOR_TEST_HOST_MEMORY_MIB=2048` in `apps/desktop/scripts/dev/isolated-browser.ts:101-114`). A manually started profile on a large host runs it immediately. |
| `design-canvas.spec.ts:9` "real gateway saves a design and rehydrates another client's edits" | `locator.boundingBox` timed out waiting for the "Export design to repository" dialog after resizing to 390×844 (line 127) | Not investigated. It also failed in the blocked isolated run. |

The fifth failure, `design-canvas.spec.ts:230`, passes when run alone. It is
recorded as flake 0208.

Fixes:

1. Make the specs independent of the configured worktree root. Assert against
   the profile's resolved worktree root from `dev:status --json`, or have
   `dev:test` ignore the user's dev worktree folder for `agent-test` profiles
   unless asked to use it.
2. Have `mise run test:agent:browser` (the manual-profile variant) export the
   same simulated-host variables as the one-shot runner, or make the queueing
   spec skip with a clear reason when the scheduler is not simulated.
3. Investigate the narrow-viewport export dialog failure in
   `design-canvas.spec.ts:9`.
4. Let the one-shot runner pass profile flags through (credential sources,
   platforms), so a host-specific problem like the startup dialog can be
   worked around without hand-assembling a profile.

## Root suite (`tests/`)

Five failures, identical on base:

| Test | Failure |
| --- | --- |
| `verified copy helper` ×3 (`tests/unit/migrate-copy.test.ts`) | `result` was `{ ok: false, reason: "extract-failed" }` where `{ ok: true, files: 3 }` was expected. The fixture streams a `tar -cf -` archive. Likely the host `tar` is bsdtar while the helper expects GNU tar semantics, or the reverse. Not confirmed. |
| `container firewall policy > GitHub ranges come from a fresh backend seed, else live, else this container's cache` (`tests/unit/firewall-policy.test.ts`) | The fake shell's call log contained `curl … https://api.github.com/meta`; the seed path should have avoided the live fetch. Related open flake: 0192. |
| `firewall allowlist refresh and edits > a domain that does not resolve keeps its addresses only until they expire` (`tests/unit/firewall-refresh.test.ts`) | Exit code 1 instead of 0. Related open flake: 0199. |

Fix: decide whether these are host-tool dependencies (pin or detect GNU
tools in the fixtures, as the firewall cases already partly do) or real bugs,
and record them in the flake index or fix them. Today they fail on every run
on this machine.

## Codex bridge (`bridges/codex-bridge`)

`session-titles.test.ts:251-254` fails in a fresh worktree with
`Pinned Codex CLI not found at <worktree>/binaries/codex. Run \`bun install\` at the repo root.`.
`bun install` does not create `binaries/`. The binaries come from
`mise run download:binaries` or `mise run toolchain:install`
(`scripts/download-agent.ts`). Fix the message to name the right command, or
skip with that reason when the pinned binary is absent.

## Backend

`environment-move.test.ts` fails 22 of 34 cases on tmux 3.8 hosts. That is a
product bug, not a test problem; see `02-tmux-3-8-no-server-detection.md`.

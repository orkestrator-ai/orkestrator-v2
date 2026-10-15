# Test suites that depend on the host

Status: Resolved 2026-10-15, except the environment move case, which waits on doc 02. The findings below are the original 2026-10-14 report; see "Resolution (2026-10-15)" at the end.

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

## Resolution (2026-10-15)

Each item was rechecked on `523eb0da` on the same host (macOS, bsdtar 3.5.3,
tmux 3.8, a dev worktree folder set to `/Volumes/Lexar/workspaces-dev`, and an
unauthenticated `claude`).

| Item | Still failing on 2026-10-15? | Outcome |
| --- | --- | --- |
| `browser-gateway.spec.ts` worktree assertion ("authoritative local environment") | Yes, from the configured root | Fixed. A new `dev:test` profile ignores the dev worktree folder unless `--use-dev-worktree-folder` is passed (`apps/desktop/scripts/dev/lifecycle.ts` `profileWorktreeLocation`, `arguments.ts`). `mise run dev` still uses the folder. |
| Environment move worktree path | Path cause fixed; the move itself still fails | The source worktree is now under `<profile>/worktrees/`, but the move never happens. The backend logs `claude-tmux cleanup incomplete`, the tmux 3.8 bug in doc 02. Left to that fix. |
| Review validation queueing | Yes on a manual profile | The spec skips with a reason unless `ORKESTRATOR_TEST_SCHEDULER_DIR` is set and `ORKESTRATOR_TEST_HOST_WORKERS=2`. Exporting the variables from `test:agent:browser` cannot work: the backend reads them when `dev:test` starts. It passes under the one-shot runner. |
| `design-canvas.spec.ts:9` export dialog at 390px | Yes (`TypeError: Cannot read properties of null (reading 'x')`) | Fixed in the spec. Root cause: below 768px `AppShell` swaps to `MobileAppShellLayout` and remounts every pane, which drops the dialog's state, so measuring after the resize was a race. The spec now reopens the dialog in the phone layout. Flake 0209 resolved. |
| One-shot runner profile flags | Not supported | Fixed. `mise run test:agent:browser:isolated` and `test:agent:design:isolated` accept `--credential-source`, `--agent-platforms`, `--no-agent-credentials` and `--use-dev-worktree-folder`. A credential or platform flag replaces the matching default, and unknown flags fail before a profile is created. |
| `verified copy helper` ×3 | Yes | Host tools, not a product bug. bsdtar has no `--no-wildcards-match-slash` and lists archives in a different format; the helper runs on GNU tar inside the image. |
| Firewall "GitHub ranges…" and "domain that does not resolve…" | Yes | Host tools, not a product bug. `docker/firewall-domains.sh` uses GNU `date -d` (`ork_iso`, `ork_ranges_fresh_within`). On macOS `date` the seed always looked stale, so the script fetched live, and `ork_iso` failed. |
| Codex bridge `session-titles.test.ts` message | No on this host (the pinned toolchain copy exists); reproduced with `HOME` pointed elsewhere | Fixed. The message now names `mise run toolchain:install --tool codex`, `mise run download:codex` and `CODEX_PROTOCOL_BINARY`. It still fails loudly, as the test's comment intends. |

Root-suite fixtures: `tests/unit/gnu-shell-tools.ts` puts Homebrew's GNU tool
directories ahead of the inherited PATH for the shell fixtures in
`migrate-copy.test.ts`, `firewall-policy.test.ts` and
`firewall-refresh.test.ts`. On Linux nothing changes. When GNU `tar` or `date`
is missing, the dependent cases skip, and the install command appears in the
test name. Flakes 0192 and 0199 stay open: they are aggregate-load timeouts
with the GNU PATH already set, which is a different failure.

The browser runs turned up two more host problems, and both are fixed:

- `cli-ui.spec.ts:169` failed in a fresh worktree with "orkestrator project
  list printed no envelope (1)" because `packages/cli/dist` had not been built.
  `test:agent:browser` and `test:agent:browser:isolated` now depend on
  `build:cli`.
- `browser-gateway.spec.ts:386` (project Home) used an `isVisible()` probe
  that raced the same mobile-shell swap. The drawer stayed open and blocked
  "Open tools". Recorded and resolved as flake 0212.

Product note, not changed here: any open dialog or pane-local state is lost
whenever a window crosses the 768px breakpoint, for example when a phone
rotates. Keeping `children` mounted across the `AppShell` swap would fix it.

The startup dialog (doc 03) still blocks a Codex-only profile on this host: a
manual `--agent-platforms codex` run had 9 failures behind "Claude Code Login
Required". The suite was validated with the new pass-through instead:

- `mise run test:agent:browser:isolated --agent-platforms codex,opencode,cursor,grok`:
  **21 passed, 12 skipped, 1 failed**. The failure is the environment move
  (doc 02).
- The doc's original run had 17 passed, 12 skipped and 5 failed.

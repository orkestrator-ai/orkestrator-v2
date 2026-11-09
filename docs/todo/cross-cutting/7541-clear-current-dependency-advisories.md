# Clear the dependency advisories `bun audit` reports

## Task analysis

Analysed 2026-11-09 against main at `64a5b4cfb`; task 2 updated in this grouped build.
Tasks 1 and 3–5 retain their analysis against `a49fd28157e23bc27496e0c078be0b4162c110e3`.
Original advisory inventory: 2026-11-07 at `413bd6219`; refreshed below.

This replaces the security report's file `0110-l18-dependency-advisories.md`
(finding L18), deleted with the rest of `docs/reports/` on 2026-11-07. Read it
with `git show 413bd6219:docs/reports/security/0110-l18-dependency-advisories.md`.
That file treated the advisories as accepted until upstream moved. Upstream has
now moved for the worst of them, and `bun audit` reports more than L18 named.

### Tasks

1. **Move Pi to 1.5.0**: clears all four high and four moderate `undici` advisories, and the `minimatch` one on Pi's side. Status: done (already upgraded on the build baseline; re-verified 2026-11-09).
2. **Take Electron 45.2.3**: the lockfile now resolves the latest 45.x patch, with manifests unchanged. Status: done (lockfile implementation and mini Electron/unsigned packaged qualification completed 2026-11-09).
3. **Refresh the in-range MCP transitive pins**: `@hono/node-server` 1.19.17 and 2.1.1, and `qs` 6.16.0. Status: done (2026-11-09).
4. **`minimatch` under electron-builder**: build-time only. Status: open (deferred to 0032 task 2; 26.18.1 still requires affected minimatch).
5. **`postcss-selector-parser` 6.0.10**: dev only, through `@tailwindcss/typography`. Status: open (accepted until upstream moves; 0.5.20 still pins 6.0.10 exactly, confirmed 2026-11-09).

### 1. Move Pi to 1.5.0

**Problem.** `bun audit` reports `undici` 8.10.2 with four high advisories
(cache poisoning and cross-user disclosure on cross-origin redirects, TLS
certificate validation bypass via dropped `tls` options in `Agent`, DoS on
excessive content-encodings, DoS on TLS 1.2 renegotiation) and four moderate
ones, all fixed in 8.12.2. It reaches the Pi bridge through
`@earendil-works/pi-coding-agent` 1.4.0 (`bun.lock:441`, `undici` at
`bun.lock:2389`). `minimatch` 10.2.6 (moderate, globparts DoS, fixed in 11.0.1)
comes the same way.

**Context.** The Pi bridge talks to the model providers the user chose, with the
user's credentials, so the redirect and TLS advisories are on a path that
carries those credentials. To-do
[0032](0032-dependency-upgrades.md) task 6 accepted the pin while Pi 1.4.0 was
the latest release. On 2026-11-07 npm's `latest` for
`@earendil-works/pi-coding-agent` is 1.5.0, which depends on `undici` 8.12.3,
`minimatch` 11.0.3 and `@earendil-works/pi-ai` 1.5.0.

**Investigation.** Pi is pinned in three places that must move together (the
SDK, `@earendil-works/pi-ai` and the `pi` binary), in `bridges/pi-bridge/package.json`,
`packages/cli/bridge-runtimes/pi-bridge/package.json`, the toolchain manifest
and `PI_CLI_VERSION` in `docker/Dockerfile`. `tests/unit/version-drift.test.ts`
enforces the SDK and binary pairing. The procedure is
[upgrade-agents.md](../../development/upgrade-agents.md). Pi 1.5.0 was already pinned throughout the build baseline, including both
bridge manifests, toolchain artifact records and Docker. Read the installed
1.5.0 changelog (also available [upstream](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/CHANGELOG.md)).
It replaces TypeBox argument validation with pi-schema, adds Terra, changes the
OpenAI default to Sol, fixes session writes and resumes using the recorded cwd.
The existing compatibility changes and runbook already cover these changes.
Re-ran `models.test.ts` against the real 1.5.0 SDK: ChatGPT subscriptions use
`gpt-6.1-sol`, matching Pi's internal default, although Terra is newer;
`openai` starts on `chat-latest` and covers every backend catalogue model.
The complete Pi bridge suite and a new real loopback HTTP session pass without
provider credentials; SDK persistence and MCP parity tests also pass.

**Decisions.**

- **How to clear the `undici` advisories?**
  - **Bump Pi to 1.5.0 through `upgrade-agents.md` (recommended).**
    - Pros: clears every `undici` 8.x advisory and Pi's `minimatch` with the versions Pi itself was built and tested against; keeps the SDK and binary paired.
    - Cons: an agent upgrade, with its live checks and a new container image; Pi's behaviour may change.
  - **A root `overrides.undici` at 8.12.x, keeping Pi 1.4.0.**
    - Pros: smallest change.
    - Cons: runs the Pi SDK on an `undici` it was not built against, and the `pi` binary in containers keeps its own bundled copy, so a Pi terminal tab stays affected.

### 2. Take Electron 45.2.3

**Problem.** The lockfile resolves `electron@45.0.0` (`bun.lock:1583`). 45.1.0,
45.2.0, 45.2.1, 45.2.2 and 45.2.3 have been published since, and 45.2.3 is
npm's `latest`. L18 asked to take any later 45.x security release.

**Context.** `package.json` and `apps/desktop/package.json` already declare
`^45.0.0`, so this is a lockfile refresh with no manifest change.
[0032](0032-dependency-upgrades.md) task 1 tracks the move to 46, which is a
separate, later change.

**Investigation.** Refreshed the root lockfile to 45.2.3 on mini using Bun
1.4.4, with both `^45.0.0` manifests unchanged. Regenerated every tracked Bun
lockfile from its owning directory and repeated every install frozen; the
unrelated locks had no diff. The standalone Cursor runtime needed a temporary
link to the repository's existing patch directory during install; removed it
immediately afterward. The version-drift test passed.

Read the official release notes for
[45.1.0](https://releases.electronjs.org/release/v45.1.0),
[45.2.0](https://releases.electronjs.org/release/v45.2.0),
[45.2.1](https://releases.electronjs.org/release/v45.2.1),
[45.2.2](https://releases.electronjs.org/release/v45.2.2), and
[45.2.3](https://releases.electronjs.org/release/v45.2.3) on 2026-11-09.
45.2.3 ships Chromium 156.0.8078.80 and Node 24.22.2, with upstream security
backports. App-relevant fixes include macOS popup menus, asar parsing/path
consistency, utility-process quit/exit reporting, disconnected Linux D-Bus and
hidden Wayland parents. New preload filtering options are additive; the 45.0
sandboxed-preload removals were already handled by the application. No patch
migration was identified. Context7's indexed tree lacked per-release notes, so
the official release pages supplied this check.

Address-findings qualification completed on mini on 2026-11-09:

- `ORKESTRATOR_HOST_REACHABILITY_CHECK=off mise run test:logged -- --name address-package-security -- mise run test:package:security` passed (81.0 s): the unsigned local shipping package reached its renderer, all 3 packaged security cases passed, and all 9 fuse/layout checks passed. The shipped framework records `CFBundleVersion` 45.2.3. Evidence: `output/package-security/darwin-arm64.json` and `output/agent-testing/electron-packaged/electron-packaged/results.json`. No Developer ID signing, notarization, installation, provider turn or production data directory was used.
- `ORKESTRATOR_AGENT_TEST_RUN_ID=address-electron-final mise run test:logged -- --name address-electron-final -- mise run test:agent:electron` passed (611.7 s): 69 passed, 5 platform/opt-in skips, no failures. Evidence: `output/agent-testing/address-electron-final/electron/results.json`. The specs own and clean their temporary profiles; all ports are dynamically allocated.
- The first native run reproduced mini Vim's `noruler` startup under the clean fixture. `54aead6ff` explicitly enables the ruler while keeping the readiness, saved-file and same-PTY assertions. The owner and final full suite pass. A later native run hit a separate adjacent-port reservation setup failure; its unchanged owner passed all 6 tests and the final full suite passed. Evidence and the unconfirmed cause remain in [flake 9901](../../tests/flaky-tests/previews-annotations-and-gateway/9901-seeded-preview-adjacent-port-reservation.md).

Task 2 is complete. Grouped validation still has the undetermined OpenCode
empty-database assertion and Docker Files-panel result recorded in the pipeline;
this task's runtime qualification does not resolve those separate failures.

**Decisions.**

- **When to take it?**
  - **Now, as its own change with the Electron suite (recommended).**
    - Pros: picks up Chromium security fixes in the shipped app; no API change inside a major.
    - Cons: needs the Electron suite under a display and a packaged smoke run.
  - **With the move to 46.**
    - Pros: one Electron change instead of two.
    - Cons: 46 is not stable until 2027-01-05, so users run an unpatched 45.0.0 until then.

### 3. Refresh the in-range MCP transitive pins

**Problem.** `@hono/node-server` 1.19.17 (through `@modelcontextprotocol/node`
2.1.1 in the backend) and 2.1.1 (through `@modelcontextprotocol/sdk` 1.32.1 in
the root lockfile) are in the range of a moderate advisory (`serveStatic`
decodes the path twice and bypasses middleware, fixed in 2.1.3). `qs` 6.16.0,
the root lockfile's top-level copy, is in the range of a moderate DoS in
`qs.stringify` (fixed after 6.16.0).

**Context.** The gateway's own `serveStatic` (`apps/backend/src/gateway-proxy.ts`)
is not Hono's middleware, so the advisory's path is not known to be reached; it
was not traced through the MCP packages. `@modelcontextprotocol/node` 2.1.2
accepts `@hono/node-server` `^1.19.9 || ^2.1.3`, and `@modelcontextprotocol/sdk`
1.32.2 accepts `^1.19.9 || ^2.0.5`. The bridges' own `@hono/node-server` is
already 2.1.5, and the Claude bridge's standalone lockfile already has `qs`
6.16.1.

**Investigation.** Updated node to 2.1.2 and SDK to 1.32.2. Node now peers on
server `^2.4.0`, so the backend server pin also moves to 2.4.0. Root resolution
uses node-server 2.1.5 and qs 6.17.1; the standalone Claude lock uses
node-server 2.1.6 and qs 6.16.1. All are outside the advisory ranges.
Regenerated all five tracked Bun lockfiles with Bun 1.4.4 and verified frozen
installs. Claude's standalone manifest is staged without the workspace-only
protocol dependency; Cursor's runtime install is staged with its declared patch,
as the packaging process does. No lockfiles were edited by hand.

**Decisions.**

- **How to move them?**
  - **Bump `@modelcontextprotocol/node` to 2.1.2 and re-resolve, checking `bun audit` afterwards (recommended).**
    - Pros: fixes through the declared ranges; no override.
    - Cons: a lockfile churn that touches MCP, which the backend and bridges both serve.
  - **`bun audit fix`.**
    - Pros: one command.
    - Cons: upgrades everything it can in range, which is a wider change than the advisories need and harder to review.

### 4. `minimatch` under electron-builder

**Problem.** `minimatch` 9.0.9 under
`electron-builder > dmg-builder > app-builder-lib > @electron/universal`
(`bun.lock:2515`) is in the advisory's range (`>=7.0.0 <11.0.1`). The 3.1.5
and 5.1.9 copies the audit lists beside it are below that range.

**Context.** These run only when packaging the app, on input this repository
controls. electron-builder 27 is [0032](0032-dependency-upgrades.md) task 2,
blocked on its stable release.

**Investigation.** npm registry checked 2026-11-09: latest is 26.18.0,
v26 is 26.18.1. The 26.18.1 app-builder-lib manifest still requires minimatch
`^10.2.5` and universal 2.0.3, which still requires minimatch `^9.0.3`.
Neither reaches the fixed 11.x range. Keep 26.18.0 and defer to 0032 task 2.

**Decisions.**

- **What to do?**
  - **Take an in-range electron-builder patch if one moves it, otherwise leave it to 0032 task 2 (recommended).**
    - Pros: no override on the release toolchain.
    - Cons: the advisory stays listed until then.
  - **Override `minimatch` for the build chain.**
    - Pros: clears the listing now.
    - Cons: a major-version override on packaging code for a build-time-only DoS.

### 5. `postcss-selector-parser` 6.0.10

**Problem.** A moderate quadratic-complexity advisory (fixed in 6.1.5) through
`@tailwindcss/typography` 0.5.20 (`bun.lock:1015`, `bun.lock:2117`).

**Context.** Dev and build only, on CSS this repository writes. This is the
same item as [0032](0032-dependency-upgrades.md) task 6's first half.

**Investigation.** Reconfirmed from npm on 2026-11-09: `@tailwindcss/typography` `latest` is still
0.5.20 and still depends on `postcss-selector-parser` `6.0.10` exactly.

**Decisions.**

- **Keep accepting it?**
  - **Yes, until `@tailwindcss/typography` moves (recommended).**
    - Pros: no override of a plugin's exact pin; the input is our own CSS.
    - Cons: stays listed by `bun audit`.
  - **Override to 6.1.5.**
    - Pros: clears the listing.
    - Cons: runs the plugin on a parser version it does not declare.

## Current state

`bun audit` on 2026-11-09 after this change: **2 moderate, 0 high** (exit 1,
expected for the accepted advisories). Only packaging minimatch 9.0.9/10.2.6
and typography's postcss-selector-parser 6.0.10 remain. Audit prints Pi's
unaffected minimatch 11.0.3 alongside affected copies; Pi's dependency is fixed.
No undici, node-server or qs advisories remain. The historical inventory was
12 advisories (4 high, 8 moderate); the build baseline already had Pi 1.5.0
and started at 4 moderate advisories. Electron now resolves 45.2.3; mini
Electron and unsigned packaged qualification passed on 2026-11-09 (task 2).

Earlier Pi/MCP checks: version drift, complete Pi bridge suite (including the new
loopback provider session), Pi bridge typecheck, and backend MCP tests.
The grouped default-suite rerun fixed CLI packing but still fails on the
unchanged OpenCode empty-database assertion; verification retains that limitation.
That Pi/MCP stage used no app profile, real login, billed turn, Docker/network
mutation or toolchain installation. The subsequent grouped build refreshed
Electron's lock, checked release notes and frozen installs, and separately used
a disposable Docker terminal fixture for 7521; it made no app run or provider call. Docker image/binary download qualification and native
interactive/terminal UI smoke were not repeated for the already-landed Pi bump.

## Assumptions and decisions

### Task 1: retain the existing complete Pi upgrade

The baseline already contains the 1.5.0 pins and compatibility work described
in upgrade-agents.md. Retain them and recheck the real SDK/model premise,
rather than duplicate an upgrade. Add HTTP loopback coverage to prove a real
Pi session runs without a provider login; no undici override is needed.

### Task 3: update MCP through declared dependency ranges

Use node 2.1.2, SDK 1.32.2 and node's required server peer 2.4.0. Re-resolve qs
within its existing range. This clears the advisories without overriding
transitives or running audit fix. Regenerate the standalone runtime locks too.

### Tasks 4 and 5: retain the accepted build-only advisories

Defer minimatch to 0032 task 2: even 26.18.1 still excludes the fixed major.
Keep typography's exact parser pin until upstream moves. Overrides would
clear the listing but run packaging/plugin code on undeclared major or parser
versions; controlled repository inputs justify accepting these two advisories.

### Task 2: take 45.2.3 within the existing range

Chose the recommended in-range patch refresh, retaining both manifests and
leaving Electron 46 to 0032. This ships current Chromium fixes without a major
API migration. The release notes were checked and the pinned-Bun locks pass
frozen installs. Mini qualification now passes the full native suite and unsigned
shipping-package smoke. The native fixture explicitly enables Vim’s ruler so
its readiness check works with mini’s clean Vim defaults; no product behavior
or assertion was weakened. The separate port-allocation flake is recorded
with its failed full run and passing unchanged owner, without claiming a cause.

## Constraints and rationale

- Pi's SDK and binary move together; a bump follows
  [upgrade-agents.md](../../development/upgrade-agents.md).
- Regenerate every tracked lockfile with the Bun version `mise.toml` pins, then
  prove both in frozen mode and run `tests/unit/version-drift.test.ts`.

## Related

- [0032 Dependency upgrades](0032-dependency-upgrades.md), tasks 1, 2 and 6.
- Security report, §5 Low severity (L18):
  `git show 413bd6219:docs/reports/2-26-10-27-security.md`.

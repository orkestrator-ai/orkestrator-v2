# Dependency upgrades

Checked against `main` at `ba7cc8d4` (2026-10-25); upstream versions checked
with `npm view`, `bun audit` and Electron's release schedule the same day.

Third-party dependencies, runtimes and image tools should stay on supported
lines, with every fixable advisory cleared. Agent SDKs and CLIs are out of
scope here; they follow [`upgrade-agents.md`](../../development/upgrade-agents.md).
The October 2026 audit's in-range batch, the low-effort majors and Vite 8 /
oxlint 1.88 landed in #964. The 2026-10-25 pass moved Electron to 45, cleared
the React Compiler lint backlog, removed `tsx` and cleared the new in-range
advisories. Everything left waits on an upstream release or a date.

## Current state

- **Landed.** Bun 1.4.4, Electron 45.0.0, electron-builder 26.18.0,
  electron-updater 6.8.11, Vite 8.3.4 with `@vitejs/plugin-react` 6.1.2,
  lucide-react 1.56, `@hono/node-server` 2, happy-dom 21.0.4, `@types/node` 26
  (24 in `apps/desktop`, matching Electron 45's `^24.9.0`), oxlint 1.88,
  Playwright 1.64, Monaco 0.57, `sharp` 0.35.5 and the MCP SDK security bumps.
  Root `overrides.dompurify` is 3.4.17. Formatting moved from oxfmt to
  `bun fmt` (configured by `[fmt]` in `bunfig.toml`) and typechecking from
  `tsc --noEmit` to `bun check`. `typescript` stays so editors run the same
  TypeScript (7.0.2) that `bun check` matches.
- **Lint.** The seven React Compiler rules are errors again (see
  [`linting.md`](../../development/linting.md#severity-policy)).
  `no-unused-vars` is the only warning.
- **Held on purpose.** `marked` 17.0.6 (`apps/web`), because
  `@tiptap/markdown` 3.32.0 (still latest) depends on `marked ^17.0.1`
  (`marked` latest is 18.1.1). `test-fixtures/preview-vite` stays on Vite 7.3.6
  as a stand-in user app.
- **Docker.** `NODE_VERSION=24.21.0`. Node 24.22.1 (2026-10-20) is the newest
  24 LTS; the container's Node runs npm-installed agent CLIs and users'
  projects, not Orkestrator code, and the drift test only asserts ≥22, so the
  patch bump rides with item 9 or the next image change.
- **Pre-release upstream (2026-10-25).** Electron `alpha` is 46.0.0-alpha.1
  (stable due 2027-01-05); electron-builder `next` is 27.0.0-alpha.12
  (`latest`/`v26` 26.18.0); electron-updater `next` is 7.0.0-alpha.11; hono
  `next` is 5.0.0-rc.1 (`latest` 4.13.13); `@dnd-kit/react` is 0.5.1.
- **Accepted advisories** (`bun audit`, 2026-10-25: 4 left, all below).
  `postcss-selector-parser` 6.0.10 (moderate DoS, build time only) through the
  exact pin in `@tailwindcss/typography` 0.5.20. `undici` 8.10.2 (one high,
  two moderate DoS/SRI advisories) through the exact pin in
  `@earendil-works/pi-coding-agent` 1.4.0; it is an agent SDK, so it moves
  with the Pi bump in [`upgrade-agents.md`](../../development/upgrade-agents.md).
  `sprintf-js` 1.1.3 is still in the tree (electron-builder 26's
  `@electron/get@3` → `global-agent` → `roarr`), but `bun audit` no longer
  reports an advisory for it; electron-builder 27's `@electron/get@5` drops it.

## Outstanding work

### Code

1. **Electron 45 → 46 before 45's end of support (2027-04-27).**
   - [x] Leave Electron 44 before its end of support (2027-03-02). **Done
     2026-10-25:** Electron 45.0.0 (stable 2026-10-21). Its breaking changes
     do not reach the app: the main window, workspace views and
     toolchain-bootstrap preloads run with `sandbox: false`, and the sandboxed
     preview and artifact views have no preload, so the removed
     sandboxed-preload shims do not apply; every `setWindowOpenHandler` denies,
     so the new `window.open()` process split never happens; preview and artifact sessions deny every permission except
     `clipboard-sanitized-write`, so `display-capture` being reported
     separately changes nothing (the artifact host denies all of them);
     `connection-manager.ts` already uses the
     async `safeStorage` API (the sync one is deprecated in 45 and removed in
     46). Electron 45 still supports macOS 13 (Ventura), so the floor in
     [`releasing.md`](../../development/releasing.md#minimum-macos-version)
     stays. Desktop typecheck and desktop tests pass; build and Electron
     scenario evidence is under [Evidence](#evidence-2026-10-25).
   - [ ] **Adopt Electron 46 once stable** (blocked upstream: 46.0.0-alpha.1,
     stable due 2027-01-05). 46 reports `capturePage` image sizes in DIPs and
     makes `crop`/`resize` take DIPs. `maskCaptureImage`
     (`apps/desktop/electron/browser-preview-capture-image.ts`) already reads
     the scale from `getScaleFactors()`, sizes the bitmap as DIPs × scale and
     fails closed on a size mismatch, and
     `apps/desktop/tests/browser-preview-capture-flow.test.ts` covers DIP-sized
     images at native scales 0.75, 1.25 and 2. What is left is a live re-test
     of masking on a HiDPI display (`browser-preview-capture.ts`,
     `browser-preview-capture-responsive.ts`) on 46. This machine's only
     display is 1920×1080 at 1x, so that run needs a Retina Mac. Re-check
     46's macOS floor and `releasing.md` at the same time.
2. **Burn down the React Compiler lint warnings.** **Done 2026-10-25.** All
   317 findings in 114 files went to zero (145 `refs`, 112
   `set-state-in-effect`, 27 `immutability`, 18
   `preserve-manual-memoization`, 7 `globals`, 5 `purity`, 3 `use-memo`), and
   all seven rules are `error` in `.oxlintrc.json`. Eleven new
   `react/set-state-in-effect` directives carry their reason (two directives
   existed before). Fix patterns are in
   [`linting.md`](../../development/linting.md#severity-policy). The browser
   suite caught one regression from the first pass: restoring the design
   canvas's saved view during render stopped small canvases auto-expanding
   their live frames on narrow layouts
   (`e2e/DesignCanvasAccessibility.spec.ts`, mobile). The restore went back
   into its effect; the spec passes on both projects.
3. **Drop `tsx` from claude-bridge and codex-bridge.** **Done 2026-10-25.**
   Both `dev` scripts are `bun --watch src/index.ts`; both bridges started
   under it and answered `/health` with 401 (auth required) on a spare port.
   `tsx` and its `esbuild` tree left both lockfiles.

### Blocked upstream

4. **electron-builder 27 / electron-updater 7** once 27 is stable (27.0.0-alpha.12
   on 2026-10-25). The signing decision is made (see
   [Assumptions and decisions](#assumptions-and-decisions)); what remains is
   the migration:
   - Requires Node ≥22.12 and is ESM. Run `electron-builder migrate-schema`.
   - Mac signing moves under `mac.sign`, implicit `--publish` goes, toolsets
     default to `latest`, pacman default dependencies change.
   - `apps/desktop/electron/auto-update.ts`: `autoInstallOnAppQuit` →
     `autoInstallEvent` (`"onQuit"` matches today's "Later installs on the
     next quit"), `quitAndInstall(options)`. 7.0.0-alpha.11 still ships
     `autoInstallOnAppQuit` as a deprecated shim.
   - Generate the update keys, wire `ELECTRON_BUILDER_UPDATE_SIGN_KEY_FILE`
     into `release:desktop` on both release machines, and embed
     `updateManifest.publicKey: [current, next]`.
   - `scripts/mac-update-feed.ts` adds `minimumSystemVersion` to the macOS
     feeds **after** electron-builder writes them, which would invalidate the
     signature. 27.0.0-alpha.12 signs `minimumSystemVersion` if it is present
     but never sets it, so either set it before signing or re-sign the edited
     feed with `createUpdateManifestSignatures` from `builder-util`. Then
     `release:publish` must verify the signatures as well as the floor.
   - Update [`releasing.md`](../../development/releasing.md) with the key
     procedure.
5. **`marked` 18** once `@tiptap/markdown` accepts it. 18 stops keeping
   trailing blank lines in block tokens' `raw`, which is exactly what
   `apps/web/src/components/markdown/tiptap-extensions.ts` compares;
   `components/chat/native-message-search.ts` subclasses `Renderer`.
6. **hono 5** once stable (claude-bridge, codex-bridge).
7. **`@dnd-kit/react` 1.0.** The classic `@dnd-kit/*` packages have had no
   release since December 2024 but are not deprecated. Migration is a rewrite
   of the 24 `apps/web` files that use them (sidebar, pane layout, Kanban,
   GitHub issues). Drop the duplicate `@dnd-kit/core` and `/sortable` entries
   from root `devDependencies` when touched.
8. **`postcss-selector-parser` advisory** clears when
   `@tailwindcss/typography` moves off 6.0.10. An override to 7.x is a major
   jump for a build-time-only DoS; accept until then.

### Deferred

9. **Node 26 in Docker** after Node 26 LTS (2026-10-28) has settled; not
   before December 2026. Take Node 24.22.1 or later in the same image change
   if this slips.

## Constraints and rationale

- Agent SDKs, agent CLIs and their patches are excluded; they follow
  [`upgrade-agents.md`](../../development/upgrade-agents.md).
- How to run an upgrade (Bun alone, pins that move together, intentional
  holds, validation per area) is in
  [`upgrade-agents.md` → Other dependencies](../../development/upgrade-agents.md#other-dependencies).
- electron-builder 27 only once stable.
- A release signed with an update key makes installs reject unsigned
  manifests; that is a one-way door.
- The standalone `bridges/claude-bridge/bun.lock` is not rewritten by
  `bun install --cwd bridges/claude-bridge` inside the workspace (Bun resolves
  the workspace root and reports "no changes"). On 2026-10-25 it was
  regenerated by installing a copy of the bridge's `package.json` (workspace
  dependencies removed) with its `bun.lock` in a scratch directory, then
  copying the lockfile back; `version-drift.test.ts` ("every nested lockfile
  agrees with its own package.json") catches a stale one.

## Open questions

None. The update-manifest key question is decided below.

## Evidence (2026-10-25)

- `bun install --frozen-lockfile` at the root, `version-drift.test.ts` (65
  pass), `mise run format:check`, `mise run lint` (0 errors; only
  `no-unused-vars` warnings) and `mise run typecheck` pass.
- `bun audit`: 16 advisories before, 4 after `bun audit fix` (body-parser
  2.4.0, fast-uri 3.1.9, happy-dom 21.0.4, ip-address 10.7.4, undici 6.29.1 /
  7.30.1). The claude-bridge lockfile audits clean on its own.
- Lint burn-down: area tests run by the five fixers (design 312, browser 197,
  terminal and files-panel 515, remaining components 1846, settings/chat/
  native-agent/markdown 2264) all passed, and the full `apps/web` suite passed
  9,553 / 0.
- `mise run test`: every group passed except backend, with 11010 pass and five
  five-second timeouts in files this change does not touch; each owner passed
  alone. `mise run test:browser`: 673 passed, 7 failed; four specs also fail
  on the base commit or pass alone, and one was the design-canvas regression
  above. Both are recorded in flake case
  [0825](../../tests/flaky-tests/aggregate-validation-runs/0825-dependency-upgrades-0032-validation.md).
- On Electron 45: `mise run build:electron` passed and
  `mise run test:agent:electron` passed 31, skipped 1 (Linux-only), failed 0.
  `package:mac` was not run: it replaces the app in `/Applications` on this
  shared machine, which the user runs.

## Assumptions and decisions

1. **Take Electron 45 now rather than wait for 46.**
   - Options: (a) stay on 44 and jump to 46 in January; (b) move to 45 now
     and to 46 when it is stable.
   - Choice: (b).
   - Why: 45 is stable and supported until 2027-04-27; 46 is alpha until
     2027-01-05, which would leave under two months before 44's end of
     support for a change that still needs a HiDPI live run.
   - Pros: removes the 2027-03-02 deadline today; 46 becomes a one-major step
     with its only known risk (DIP capture sizes) already covered by tests.
   - Cons: two Electron majors in one quarter; 45's own end of support
     (2027-04-27) is the new deadline.
2. **Fix the React Compiler findings rather than suppress them, all in one
   change.**
   - Options: (a) one reviewed change per rule as `linting.md` suggested;
     (b) all seven rules at once, split by area across parallel fixers, with
     directives only where the rule is wrong; (c) blanket directives.
   - Choice: (b).
   - Why: the task was to finish the file on one branch, and the areas do
     not overlap; every area's tests and the full `apps/web` suite ran
     afterwards. (c) would hide real React 19 issues.
   - Pros: the rules are errors again, so no new findings can land.
   - Cons: a large diff (114 files) to review at once. Small timing changes
     are deliberate: resets now happen before paint, so several loaders show
     their loading state on the first frame instead of one frame later;
     latest-value refs update at commit instead of render; `BuildChatTab`
     runs its component function once more when its transcript changes while
     Tests is not selected.
3. **Sign update manifests with an Ed25519 key (decides the open question).**
   - Options: (a) publish with `updateManifest: false`; (b) sign with a key
     kept on the release machines; (c) sign in CI with a GitHub secret.
   - Choice: (b), adopted with electron-builder 27:
     - Generate two keys with `electron-builder create-update-key`: the
       current key and a next key.
     - The current private key lives in the maintainer's password manager and,
       for releases, in a mode-600 file outside the repository on the Mac
       and on the Linux release machine, passed through
       `ELECTRON_BUILDER_UPDATE_SIGN_KEY_FILE`. Only maintainers who run
       `release:desktop` can sign.
     - The next private key stays offline in the password manager only.
       Every release embeds both public keys (`updateManifest.publicKey`).
     - Rotation follows electron-builder's key-rotation runbook (dual-sign,
       then drop the old key).
     - If the current key is lost or leaks, switch to the next key with no
       bridge release. If both are lost, installs stop updating and users
       must reinstall from the download page.
   - Why: releases are built on two maintainer machines, not in CI, so (c)
     would add a new place for the key without moving the build. macOS
     updates are already checked against the app's code signature by
     Squirrel.Mac, but Linux AppImage updates are trusted on the feed's
     SHA-512 alone, so a compromised GitHub release could push code to Linux
     users; (a) leaves that open and warns on every build.
   - Pros: tampered or unsigned feeds are rejected before download on every
     platform; the next key makes loss of the current key recoverable.
   - Cons: a one-way door (installs then refuse unsigned feeds); the key must
     exist on two machines; `scripts/mac-update-feed.ts` must change (item
     4).
4. **Clear the new advisories in range now; leave the agent-SDK pin.**
   - Options: (a) leave them for a later batch; (b) `bun audit fix` within
     ranges, leaving exact upstream pins; (c) add overrides for the pinned
     ones too.
   - Choice: (b).
   - Why: in-range fixes are patch or minor bumps with no API change; the
     `undici` 8.10.2 pin belongs to the Pi SDK, which this file excludes.
   - Pros: 12 of 16 advisories gone without manifest changes.
   - Cons: an `undici` high-severity DoS stays until the next Pi SDK bump.
5. **Rate the file Low.** Everything left is blocked upstream or deferred.
   Electron 46 is the most serious item; once it is stable (2027-01-05),
   re-rate to Medium because of 45's 2027-04-27 end of support.

## Related

- [`releasing.md`](../../development/releasing.md): macOS floor and update feeds.
- [`linting.md`](../../development/linting.md): severity policy for the
  React Compiler rules.
- [0030-test-suite-and-ci-health.md](0030-test-suite-and-ci-health.md): CI that every
  upgrade relies on.

## Replaces

- `docs/development/dependency-upgrade-schedule-2026-10-13.md`

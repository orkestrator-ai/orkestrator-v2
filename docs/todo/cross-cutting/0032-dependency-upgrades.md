# Dependency upgrades

Checked against `main` at `9fb4e6a8` (2026-10-15); upstream versions checked
with `npm view` the same day.

Third-party dependencies, runtimes and image tools should stay on supported
lines, with every fixable advisory cleared. Agent SDKs and CLIs are out of
scope here; they follow [`upgrade-agents.md`](../../development/upgrade-agents.md).
The October 2026 audit's in-range batch, the low-effort majors and Vite 8 /
oxlint 1.88 all landed (#964). What is left is waiting on upstream releases,
a support deadline, or a decision.

## Current state

- **Landed.** Bun 1.4.3, Electron 44.7.0, electron-builder 26.17.0, Vite 8.3.4
  with `@vitejs/plugin-react` 6.1.2, lucide-react 1.56, `@hono/node-server` 2,
  happy-dom 21, `@types/node` 26 (24 in `apps/desktop`), oxlint 1.88, oxfmt
  0.73, Playwright 1.64, Monaco 0.57, `sharp` 0.35.5 and the MCP SDK security
  bumps. Root `overrides.dompurify` is 3.4.17.
- **Held on purpose.** `marked` 17.0.6 (`apps/web`), because
  `@tiptap/markdown` 3.32.0 (still latest) depends on `marked ^17.0.1`.
  `test-fixtures/preview-vite` stays on Vite 7.3.6 as a stand-in user app.
- **Docker.** `NODE_VERSION=24.21.0` (latest 24 LTS). The container's Node runs
  npm-installed agent CLIs and users' projects, not Orkestrator code; the drift
  test only asserts ≥22.
- **Pre-release upstream.** electron-builder `next` is 27.0.0-alpha.10
  (`latest` 26.15.3, `v26` 26.17.0); hono `next` is 5.0.0-rc.1;
  `@dnd-kit/react` is 0.5.1.
- **Accepted advisories.** `postcss-selector-parser` 6.0.10 (moderate DoS,
  build time only) through the exact pin in `@tailwindcss/typography` 0.5.20.
  `sprintf-js` 1.1.3 (moderate, build time only) through electron-builder 26's
  `@electron/get@3`; electron-builder 27 uses `@electron/get@5` without it.
- **Lint backlog.** The seven React Compiler rules are warnings since oxlint
  1.88 (337 findings in 129 files on 2026-10-13, almost all `apps/web`); see
  [`linting.md`](../../development/linting.md).

## Outstanding work

### Code

1. **Electron 44 → 46 before 44's end of support (2027-03-02).** Electron 45
   ships 2026-10-20; its announced changes (denied popups, permission
   handlers, sandboxed views without preload, async `safeStorage`) do not
   affect the app. Electron 46 reports `capturePage` image sizes in
   device-independent pixels. `maskCaptureImage`
   (`apps/desktop/electron/browser-preview-capture-image.ts`) already selects
   one scale representation for size and bitmap and its callers fail closed
   (an unmaskable capture keeps text evidence only), so a mismatch drops
   screenshots rather than leaking sensitive fields. Re-test masking on a HiDPI
   display (`browser-preview-capture.ts`, `browser-preview-capture-responsive.ts`)
   before adopting 46, and raise the macOS floor in
   [`releasing.md`](../../development/releasing.md) if 46 raises it.
2. **Burn down the React Compiler lint warnings.** Fix `react/refs`,
   `react/set-state-in-effect` and the other five rules in `apps/web` in their
   own reviewed changes (hot paths such as the chat transcript first), and
   raise each rule back to `error` in `.oxlintrc.json` once its count is zero.
3. **Drop `tsx` from claude-bridge and codex-bridge.** It backs only the
   unwired `dev` scripts (`tsx watch src/index.ts`); `bun --watch
   src/index.ts` replaces it.

### Blocked upstream

4. **electron-builder 27 / electron-updater 7** once 27 is stable (needs the
   decision below first). Requires Node ≥22.12 and is ESM. Signed update
   manifests become mandatory for publishing, so `release:desktop` breaks
   until an update key exists (or `updateManifest: false`). Updater API changes
   reach `apps/desktop/electron/auto-update.ts` (`autoInstallOnAppQuit` →
   `autoInstallEvent`, `quitAndInstall(options)`). Mac signing moves under
   `mac.sign`, implicit `--publish` goes, toolsets default to `latest`, pacman
   default dependencies change. Run `electron-builder migrate-schema` and
   update [`releasing.md`](../../development/releasing.md). Removes the
   `sprintf-js` advisory.
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
   before December 2026.

## Constraints and rationale

- Agent SDKs, agent CLIs and their patches are excluded; they follow
  [`upgrade-agents.md`](../../development/upgrade-agents.md).
- How to run an upgrade (Bun alone, pins that move together, intentional
  holds, validation per area) is in
  [`upgrade-agents.md` → Other dependencies](../../development/upgrade-agents.md#other-dependencies).
- electron-builder 27 only after Electron 44 (done) and only once stable.
- A release signed with an update key makes installs reject unsigned
  manifests; that is a one-way door.

## Open questions

- **Update-manifest key management** for electron-builder 27: where the key
  lives, who can sign, rotation and loss recovery, or whether to publish with
  `updateManifest: false`. Needed before item 4.

## Related

- [`releasing.md`](../../development/releasing.md): macOS floor and update feeds.
- [`linting.md`](../../development/linting.md): severity policy for the
  React Compiler rules.
- [0030-test-suite-and-ci-health.md](0030-test-suite-and-ci-health.md): CI that every
  upgrade relies on.

## Replaces

- `docs/development/dependency-upgrade-schedule-2026-10-13.md`

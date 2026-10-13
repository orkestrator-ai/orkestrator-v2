# Dependency upgrade schedule — 2026-10-13

Status: Active — phases 1–3 applied on branch `deps/upgrade-2026-10`
(2026-10-13); phase 4 and `marked` 18 remain. "Current" below is what commit
`ba59d06e` (2.19.15) pinned when the audit ran.

## Progress

Applied on `deps/upgrade-2026-10`, one commit per unit:

| Unit | State |
| --- | --- |
| 1c Bun 1.4.3 | Done, with two follow-ups it exposed: `signalCode` may now be a number, and a reused keep-alive connection whose body was refused with 413 kept `server.close()` waiting, so every 413 now sends `Connection: close` |
| 1a / 1b in-range batch | Done. `dompurify` override raised to 3.4.17 rather than deleted: monaco 0.57 still declares 3.4.15 exactly. turbo 2.11 sets `agentGuidance: false` so it stops rewriting AGENTS.md |
| 1c Playwright 1.64, mise 2026.10.9, git-delta 0.20.1 | Done |
| 2a Electron 44.7.0 | Done. Clipboard moved to `apps/desktop/electron/clipboard.ts`; `mac.minimumSystemVersion` is 13.0, but electron-builder 26 still offers the update to macOS 12 (see releasing.md) |
| 2b lucide-react 1.56.0 | Done. Local `GithubIcon`, plus `aria-label`s for 15 icon-only buttons that had no accessible name |
| 2c–2f | Done. The one iframe test enables happy-dom page loading for its own iframe |
| 3a Vite 8.3.4 + plugin-react 6.1.2 | Done. `server.hmr` → `server.ws`; `test-fixtures/preview-vite` stays on 7 |
| 3b oxlint 1.88.0 | Done as option A: the seven React Compiler rules are warnings (337 findings), see linting.md |
| 3c marked 18 | Still blocked on `@tiptap/markdown` |
| Phase 4 | Not started: Electron 45 ships 2026-10-20; electron-builder 27 and hono 5 are pre-release; Node 26 in Docker waits for its LTS (2026-10-28) |

Remaining audit findings: `postcss-selector-parser` (build-time, waits for
`@tailwindcss/typography`) and `sprintf-js` (goes away with
electron-builder 27).

This plan covers every third-party dependency, runtime and build tool except
the agent SDKs and agent CLIs, which have their own runbook
([upgrade-agents.md](upgrade-agents.md)) and were being bumped in parallel when
this audit ran. Excluded: `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`,
`@opencode-ai/sdk` (and its patch), `@cursor/sdk` (and its patch), the four
`@earendil-works/pi-*` packages, and the Claude, Codex, OpenCode, Grok and Pi
CLIs in `packages/toolchain/src/manifest.ts` and `docker/Dockerfile`.

## How this was gathered

- Every `package.json` outside `node_modules` (root, `apps/*`, `bridges/*`,
  `packages/*`, `test-fixtures/*`), root `overrides` and `patchedDependencies`,
  `mise.toml`, `docker/Dockerfile`, `config/mise-version.json` and
  `.github/workflows/*.yml`. There is no `e2e/`, `tests/`, `docker/` or
  `scripts/` `package.json`; those directories use the root's dependencies.
- `mise exec -- bun outdated --filter='*'` (read-only), `npm view <pkg>
  dist-tags`, GitHub releases, `endoflife.date`, and `mise exec -- bun audit`.
- Breaking changes from upstream changelogs and migration guides, then a grep of
  this tree for each affected API. Context7 was not authorized in this session,
  so upstream docs were read from GitHub directly.

`patches/` holds only the two agent-SDK patches (`@cursor/sdk` and
`@opencode-ai/sdk`, rebased with the agent bump to 1.0.37 and 1.19.0). No dependency in this plan carries a patch, so no
upgrade here needs a patch rebased. The only other install-time mutation is the
root `overrides.dompurify` pin, covered in Phase 1b.

## Security findings (act first)

`bun audit` reports nine advisories (five high). All but one are fixable inside
current major lines.

| Advisory | Package (resolved) | Reached through | Reachable at runtime? | Fix |
| --- | --- | --- | --- | --- |
| GHSA-wq5f-xc86-pv6w (high, librsvg CVE-2026-96889) | `sharp` 0.35.4 | `apps/backend`, `packages/cli` | **Yes.** `resizeKanbanImage` in `apps/backend/src/core/storage-shared-core.ts` decodes user-attached Kanban images | `sharp` 0.35.5 (Phase 1a) |
| GHSA-6qxp-vccf-f47h (high, OAuth credentials sent to an MCP-chosen auth server) | `@modelcontextprotocol/client` 2.0.0, `@modelcontextprotocol/sdk` 1.30.0 | backend, cursor-bridge, pi-bridge; claude-bridge (direct, and via the Claude Agent SDK and Pi's `@google/genai`) | Not exploitable today: no `authProvider`/OAuth client anywhere; bridges send static headers. Still bump — user-configured MCP servers are untrusted input | client/server 2.3.1, node 2.1.1, sdk 1.32.1 (Phase 1a) |
| GHSA-p98j-92pf-mc4p, GHSA-6688-9rhm-gjv2 (low, DOM XSS in `IN_PLACE` mode) | `dompurify` 3.4.15 (npm); 3.4.8 vendored inside monaco | `monaco-editor` declares it, forced by root `overrides` | No. Monaco bundles its own copy at `esm/vs/base/browser/dompurify/dompurify.js` and never uses `IN_PLACE`; nothing imports the npm package | `monaco-editor` 0.57.0 (vendors 3.4.15); set the override to 3.4.17 or drop it (Phase 1b) |
| GHSA-ch52-4w7c-c8xp (high) | `http-cache-semantics` 4.2.0 | `electron-builder` → `app-builder-lib` → `@electron/get@3` → `got@11` | Build time only (Electron download cache) | Lockfile refresh to 4.3.0 (in range) |
| GHSA-68fv-2mgg-jv7q (high, DoS) | `source-map-js` 1.2.1 | `vite` → `postcss`; `@tailwindcss/node` | Build/dev only | Lockfile refresh to 1.2.2 (in range) |
| GHSA-rj75-hqrm-r3gf (moderate, DoS) | `postcss-selector-parser` 6.0.10 | `@tailwindcss/typography` 0.5.20 (exact pin) | Build only, on our own CSS | No in-range fix; accept, or add an override to 7.1.6 after verifying typography output |
| GHSA-hp3w-g68c-fv3c (moderate, DoS) | `sprintf-js` 1.1.3 | `app-builder-lib` → `@electron/get@3` → `global-agent` → `roarr` | Build time only | No fixed release. Goes away with electron-builder 27, which uses `@electron/get@5` (Phase 4) |

`bun audit` attributes the `got` chain to `electron` as well; the lockfile shows
`electron` itself resolves `@electron/get@5.1.0`, which has neither `got` nor
`global-agent`. Only `electron-builder` pulls them in.

**Electron 42 reaches end of support on 2026-10-20** (when Electron 45 ships).
After that date Chromium security fixes stop landing on the 42 line. This is
why the Electron upgrade is scheduled as Phase 2 rather than with the other
strategic majors.

## Summary table

Type: **patch/minor** = inside the current major (or a 0.x minor with no listed
breaking change); **major** = crosses a semver major or a breaking 0.x minor.
Risk: L/M/H.

| Package | Workspace(s) | Current | Latest | Type | Phase | Risk | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `sharp` | backend, cli | 0.35.4 | 0.35.5 | patch | 1a | L | **Security** (librsvg). Backend uses `^`, CLI pins exact; bump both to 0.35.5 |
| `@modelcontextprotocol/client` | backend (dev), cursor-bridge, pi-bridge | 2.0.0 | 2.3.1 | minor | 1a | L–M | **Security**. Keep the three exact pins identical |
| `@modelcontextprotocol/server` | backend | 2.0.0 | 2.3.1 | minor | 1a | L–M | Move with client |
| `@modelcontextprotocol/node` | backend | 2.0.0 | 2.1.1 | minor | 1a | L–M | Move with server |
| `@modelcontextprotocol/sdk` (v1) | claude-bridge | 1.30.0 | 1.32.1 | minor | 1a | L | **Security**. Standalone `bridges/claude-bridge/bun.lock` too |
| `dompurify` (override) | root | 3.4.15 | 3.4.17 | patch | 1b | L | Advisory hit is cosmetic: monaco vendors its own copy. Bump to 3.4.17 or delete the override with monaco 0.57 |
| `zod` | backend, claude-bridge | 4.6.5 | 4.6.7 | patch | 1a | L | Exact pins |
| `ws` / `@types/ws` | backend | 8.21.3 / 8.18.1 | 8.22.0 / 8.18.2 | minor | 1a | L | |
| `hono` | claude-bridge, codex-bridge | 4.13.8 | 4.13.13 | patch | 1a | L | Root lockfile resolves 4.13.8; `bridges/claude-bridge/bun.lock` already has 4.13.13 |
| `tsx` | claude-bridge, codex-bridge | 4.23.13 | 4.23.15 | patch | 1a | L | Only used by unwired `dev` scripts; candidate for removal (`bun --watch`) |
| `tar-stream` / `@types/tar-stream` | root, toolchain | 3.2.1 / 3.1.4 | 3.2.2 / 3.1.5 | patch | 1a | L | Exact pins |
| `@tiptap/*` (9 packages) | web | 3.31.3 | 3.32.0 | minor | 1a | L | Exact pins; move all nine together. Markdown `!`-before-link escaping changes serialization |
| `react-virtuoso` | root, web | 4.18.13 | 4.18.19 | patch | 1a | L | |
| `react-resizable-panels` | web | 4.12.4 | 4.14.5 | minor | 1a | L | 2 importing files |
| `@radix-ui/react-*` (16 packages) | web | various | various | minor | 1b | M | Dialog/dismissable-layer focus changes; see [Phase 1b](#pr-1b--renderer-minors) |
| `@happy-dom/global-registrator`, `happy-dom` | root | 20.14.5 | 20.14.6 / 21.0.1 | patch / major | 1a / 2 | L / M | 20.14.6 fixes a cookie issue. 21 disables iframe page loading by default (one test) |
| `@playwright/test`, `playwright`, `playwright-core` | root, backend, cli, Docker | 1.63.0 | 1.64.0 | minor | 1c | M | Four pins plus `PLAYWRIGHT_VERSION` in the Dockerfile move together (drift-tested) |
| `turbo` | root | 2.10.13 | 2.11.7 | minor | 1a | L | Update `turbo.json` `$schema` URL |
| `@types/bun` | root, toolchain, acp/cursor/pi bridges | 1.4.2 | 1.4.3 | patch | 1c | L | Moves with the Bun runtime |
| Bun runtime | `mise.toml`, `packageManager`, `scripts/download-bun.sh`, Dockerfile base image, CLI `engines` | 1.4.2 | 1.4.3 | patch | 1c | M | Drift-tested in six places; see below |
| `electron-builder` | root | 26.15.3 | 26.17.0 (`v26` tag) | minor | 1a | L | npm `latest` tag still says 26.15.3, so `bun outdated` misses it |
| `electron-updater` | desktop | 6.8.10 | 6.8.10 | — | — | — | Current (matches the `v26` tag) |
| `oxlint` | root | 1.78.0 | 1.88.0 | minor | 3 | M | Pinned `~`. 1.79+ splits the React Compiler checks into `correctness` rules: **337 errors in 129 files** |
| `oxfmt` | root | 0.68.0 | 0.73.0 | 0.x minor | 2 | L | `--check` passes on all 3,072 files with 0.73 — no churn |
| `oxc-parser` | root | 0.153.0 | 0.154.0 | 0.x minor | 2 | L | Pinned `~` |
| `@agentclientprotocol/sdk` | acp-bridge | 1.5.1 | 1.8.0 | minor | Agent runbook | L | No breaking change; `PROTOCOL_VERSION` still 1. **Done** in the agent bump (Grok's drift-tested SDK pin) |
| `monaco-editor` | web | 0.56.0 | 0.57.0 | 0.x minor | 1b | L | Features only; vendors DOMPurify 3.4.15 |
| `marked` | web | 17.0.6 | 18.1.1 | major | Blocked | M | `@tiptap/markdown` 3.32.0 still requires `marked ^17`; wait so lexer and tiptap share one copy |
| `lucide-react` | web, web-public | 0.562.0 | 1.56.0 | major | 2 | L | 194 importing files, 205 names; only `Github` (5 files) was removed |
| `@hono/node-server` | claude-bridge, codex-bridge | 1.19.17 | 2.1.5 | major | 2 | L | Only `serve({ fetch, port, hostname })` is used; v2 drops Node <20 and `/vercel` |
| `vite` | web, web-public | 7.3.6 | 8.3.4 | major | 3 | M | Rolldown/Oxc; configs unaffected |
| `@vitejs/plugin-react` | web, web-public | 4.7.0 | 6.1.2 | major | 3 | L | Must move with vite (6.x requires vite 8) |
| `vite` (fixture) | test-fixtures/preview-vite | 7.3.6 | 8.3.4 | — | Hold | — | Intentionally stands in for a user's app; do not bump |
| `electron` | root, desktop | 42.11.5 | 44.7.0 | major | 2 | H | **EOL 2026-10-20**. Clipboard API rewrite in 44 |
| `@types/node` | root, toolchain | 25.9.7 | 26.6.5 | major | 2 | L | Node 25 is EOL. These run under Bun (`process.version` v26.3.0): use `^26` |
| `@types/node` | desktop | 25.9.7 | 24.x | — (realign) | 2 | L | Electron main runs Node 24: use `^24` (Electron 44 already depends on `@types/node ^24.9.0`) |
| `@types/node` | 4 bridges | 22.20.3 | 26.6.5 | major | 2 | L–M | Bridges run under Bun in every mode; use `^26` |
| Node (Docker) | Dockerfile `NODE_VERSION` | 24.21.0 | 24.21.0 (LTS); 26.11.1 (Current, LTS 2026-10-28) | — | 4 | M | Container Node runs agent CLIs and users' projects; move after Node 26 LTS settles |
| git-delta (Docker) | Dockerfile | 0.19.2 | 0.20.1 | minor | 1c | L | New SHA-256 pair |
| mise (Docker) | `config/mise-version.json`, Dockerfile | 2026.9.11 | 2026.10.9 | calver | 1c | L | Drift-tested; new SHA-256 pair |
| starship (Docker) | Dockerfile | 1.26.0 | 1.26.0 | — | — | — | Current |
| `actions/upload-artifact`, `actions/download-artifact` | `publish-container.yml` | v7.0.1 / v8.0.1 | v7.0.2 / v8.0.2 | patch | 1a | L | SHA-pinned |
| `jdx/mise-action` | `lint.yml` | v4.3.0 | v5.1.2 | major | 2 | L | `minimum_release_age` now defaults to 24h; harmless with a pinned mise |
| Other actions (`checkout`, `attest`, `docker/*`) | workflows | — | — | — | — | — | Current |
| `@dnd-kit/core`, `/sortable`, `/utilities` | root, web | 6.3.1 / 10.0.0 / 3.2.2 | same | — | 4 (watch) | — | No release since Dec 2024; see [Watch list](#watch-list-and-replacements) |
| `electron-builder` 27 / `electron-updater` 7 | root, desktop | 26 / 6 | 27.0.0-alpha.10 / 7.0.0-alpha | major (pre-release) | 4 | H | Signed update manifests, ESM, updater API changes |
| `hono` 5 | bridges | 4.13 | 5.0.0-rc.1 | major (pre-release) | 4 | — | Wait for stable |

Already current, no action: `react`/`react-dom` 19.3.0, `@types/react`/
`@types/react-dom` 19.3.0, `typescript` 7.0.2, `tailwindcss`/`@tailwindcss/vite`
4.3.3, `@tailwindcss/typography` 0.5.20, `@xterm/*` (xterm/headless 6.0.0,
fit 0.11.0, serialize 0.14.0, web-links 0.12.0), `@monaco-editor/react` 4.7.0,
`react-markdown` 10.1.0, `remark-gfm` 4.0.1, `remark-breaks` 4.0.0, `unified`
11.0.5, `zustand` 5.0.15, `sonner` 2.0.8, `tailwind-merge` 3.7.0, `clsx` 2.1.1,
`class-variance-authority` 0.7.1, `@testing-library/dom` 10.4.2,
`@testing-library/react` 16.3.3, `yauzl`/`@types/yauzl` 3.4.0, starship 1.26.0,
`actions/checkout` v7.0.1, `actions/attest` v4.2.2, the four `docker/*` actions.

## Schedule at a glance

| Phase | Target | PRs | Effort | Risk | Why now |
| --- | --- | --- | --- | --- | --- |
| 1 — security and in-range batch | Week of 2026-10-13 | 1a backend/bridge/tooling minors, 1b renderer minors, 1c runtime and image toolchain | ~1 day total | L–M | Clears every fixable advisory; nothing crosses a major |
| 2 — low-effort majors, Electron first | 2026-10-14 → 2026-10-24 | 2a Electron 44, 2b lucide, 2c hono node-server, 2d happy-dom 21, 2e `@types/node`, 2f oxfmt/oxc-parser/mise-action | ~2 days | H for 2a, L otherwise | Electron 42 support ends 2026-10-20 |
| 3 — medium-effort majors | Late Oct → mid Nov 2026 | 3a Vite 8 + plugin-react 6, 3b oxlint 1.88 and React Compiler rule policy, 3c marked 18 (blocked) | ~2–4 days | M | Real behaviour/bundle changes; 3b needs a policy decision |
| 4 — strategic / watch | Nov 2026 → Q1 2027 | electron-builder 27, Electron 45/46, Node 26 in Docker, hono 5, dnd-kit successor | Varies | H | Pre-release today, or tied to release infrastructure |

Ordering constraints that cut across phases:

1. **Land after the concurrent agent-SDK bump.** It edits `docker/Dockerfile`,
   `packages/toolchain/src/manifest.ts`, both `bun.lock` files and several
   bridge `package.json`s. Rebase each PR here onto it rather than resolving
   lockfile conflicts by hand — regenerate instead (AGENTS.md, *Updating Bun and
   lockfiles*). `@agentclientprotocol/sdk` 1.8.0 was taken in that bump (it is
   Grok's drift-tested SDK pin).
2. **Bun (1c) before or after a batch, never inside one.** Every later PR
   regenerates lockfiles with whatever Bun `mise.toml` pins, so mixing a Bun
   bump with dependency bumps makes the lockfile diff unreviewable.
3. **Two lockfiles.** Anything in `bridges/claude-bridge/package.json` (`hono`,
   `@hono/node-server`, `@modelcontextprotocol/sdk`, `zod`, `tsx`,
   `@types/node`) also needs `mise exec -- bun install --cwd
   bridges/claude-bridge`, then both frozen installs and
   `tests/unit/version-drift.test.ts`.
4. **Pins that must move as a set:** the nine `@tiptap/*` exact pins; the three
   `@modelcontextprotocol/client` pins (backend, cursor-bridge, pi-bridge);
   `@modelcontextprotocol/node` 2.1.1 has a peer dependency on `server
   ^2.3.0`; the four Playwright pins plus Dockerfile `PLAYWRIGHT_VERSION`
   (drift-tested); `sharp` in backend and CLI; all 16 `@radix-ui/react-*`
   (they share internal layers such as `react-dismissable-layer` and
   `react-focus-scope`, which must dedupe to one copy).
5. **`@vitejs/plugin-react` 6 requires Vite 8**; 5.2.0 is the only release that
   accepts both. `@tailwindcss/vite` 4.3.3 already accepts Vite 8.
6. **`marked` 18 waits for `@tiptap/markdown`** to accept it.
7. **electron-builder 27 after Electron 44**, and only once 27 is stable.

## Phase 1 — security and in-range batch

Every change here stays inside the current major line (or a 0.x minor with no
listed breaking change). Three PRs, because their validation differs.

### PR 1a — backend, bridges and tooling

Packages: `sharp` 0.35.5 (backend and CLI), `@modelcontextprotocol/client`
2.3.1 ×3, `@modelcontextprotocol/server` 2.3.1, `@modelcontextprotocol/node`
2.1.1, `@modelcontextprotocol/sdk` 1.32.1, `zod` 4.6.7, `ws` 8.22.0, `@types/ws`
8.18.2, `hono` 4.13.13, `tsx` 4.23.15, `tar-stream` 3.2.2, `@types/tar-stream`
3.1.5, `@tiptap/*` 3.32.0, `react-virtuoso` 4.18.19, `react-resizable-panels`
4.14.5, `happy-dom`/`@happy-dom/global-registrator` 20.14.6, `turbo` 2.11.7
(and the `turbo.json` `$schema` URL, currently `v2-10-12`), `electron-builder`
26.17.0, `actions/upload-artifact` v7.0.2 and `actions/download-artifact`
v8.0.2 (SHA pins). The lockfile refresh also lifts `http-cache-semantics` to
4.3.0 and `source-map-js` to 1.2.2, both in range.

Behaviour changes to call out in the PR:

<a id="mcp-sdks"></a>
- **MCP SDKs.** The OAuth advisory does not reach us — no `authProvider` is
  configured anywhere; cursor-bridge and pi-bridge send static headers
  (`bridges/cursor-bridge/src/mcp.ts`, `bridges/pi-bridge/src/mcp.ts`). The
  real changes are: HTTP redirects are now followed **only within the same
  origin** (a user-configured remote MCP server that redirects across origins
  will stop connecting; `redirectPolicy: 'follow'` restores the old
  behaviour, but should be a deliberate choice), `listTools()` now follows
  pagination, and `createMcpHandler`/`toNodeHandler` enforce a 4 MiB request
  body limit (`apps/backend/src/core/agent-tools.ts`,
  `control-mcp-server.ts`). claude-bridge imports nothing from
  `@modelcontextprotocol/sdk`; the pin only satisfies the Claude Agent SDK's
  peer dependency (`^1.29.0`). `@modelcontextprotocol/node` 2.1.1 still
  depends on `@hono/node-server ^1.19.9`, so a 1.x copy remains after PR 2c.
- **Tiptap 3.32.0.** A literal `!` directly before a link is now escaped when
  serializing Markdown. Any test that snapshots serialized Markdown with `![`
  next to a link may change.
- **react-resizable-panels 4.14.5** only renders an explicit `id` as
  `data-testid`. Two files use it (`components/ui/resizable.tsx`,
  `pane-layout/PaneSplitContainer.tsx`); check selectors in browser specs.
- **electron-builder 26.17.0** is published under the `v26` dist-tag while
  `latest` still points at 26.15.3, which is why `bun outdated` does not list
  it. Its changes are backports (updater cache and differential download fixes,
  workspace dependency bundling). Request it explicitly (`26.17.0`).

Validation: `format:check`, `lint`, `typecheck`, `test`; `verify:packaged-backend`
(sharp is a native module copied into `apps/backend/dist/node_modules`);
`smoke:cli` and `test:cli:scenarios` (CLI pins `sharp` and `playwright-core`);
`test:browser` for the Tiptap editor. Effort: ~2 hours. Risk: low.

### PR 1b — renderer minors

Packages: all 16 `@radix-ui/react-*` to their current `latest` (dialog 1.3.1,
alert-dialog 1.2.1, checkbox 1.4.1, collapsible 1.2.1, context-menu 2.4.1,
dropdown-menu 2.2.1, label 2.1.17, progress 1.2.1, scroll-area 1.4.0, select
2.4.1, separator 1.2.0, slider 1.6.1, slot 1.5.0, switch 1.4.1, tabs 1.2.1,
tooltip 1.4.1); `monaco-editor` 0.57.0; root `overrides.dompurify`.

- **Radix.** These are minors, but they change focus and layering behaviour:
  dialog 1.2.0 fixed nested portalled layers (popover/select/dropdown inside a
  modal dialog) by changing how the modal `FocusScope` and `RemoveScroll`
  treat them; slider 1.6.0 changed when `onValueChange`/`input` events fire
  inside a `<form>`; scroll-area 1.3.0 added `ScrollArea.Content` and
  announced that the implicit content wrapper goes away in the next major (no
  action yet, but new code should use `disableImplicitContentElement`); 1.3.x
  allows explicit `undefined` for optional props. The 1.3.x line was published
  2026-10-12/13 and `*.2` release candidates are already tagged — wait about a
  week for the follow-up patch before merging. 16 files import Radix, almost
  all through `apps/web/src/components/ui/`.
- **Monaco 0.57.0** adds features only; the 0.56 module reshuffle is already
  handled in `apps/web/src/lib/monaco-loader.ts`. It vendors DOMPurify 3.4.15
  inside `esm/vs/base/browser/dompurify/`. Because nothing imports the npm
  `dompurify` package, the root override has no runtime effect; either bump it
  to 3.4.17 (silences `bun audit`) or delete it. Recommend deleting it in this
  PR and recording why — an override that does nothing invites false
  confidence.

Validation: `format:check`, `lint`, `typecheck`, `test`, `test:browser`, then
`test:agent:browser:isolated` with manual checks of dialogs containing
selects/dropdowns, the slider settings, the Monaco file editor and diff viewer.
Effort: ~half a day including QA. Risk: medium (behavioural, not compile-time).

### PR 1c — runtime and image toolchain

Packages: Bun 1.4.3 and `@types/bun` 1.4.3; mise 2026.10.9 in the image;
git-delta 0.20.1; Playwright 1.64.0.

- **Bun 1.4.3** is pinned in `mise.toml`, root `packageManager`,
  `packages/cli` `engines` (`>=`), `scripts/download-bun.sh` (version plus four
  SHA-256s; this is the Bun shipped to end users inside the desktop app), both
  `FROM oven/bun:…-debian@sha256:…` lines and the literal version checks in
  `docker/Dockerfile`, and five `@types/bun` ranges. `version-drift.test.ts`
  enforces all of them; `mise run docker:check-base` resolves the new digest.
  Regenerate both lockfiles with the new Bun. Because Bun is the runtime for the
  backend and every bridge, treat this as a runtime upgrade:
  `.github/workflows/validate-bun-runtime.yml` runs on it.
- **mise** is pinned in `config/mise-version.json` and duplicated in the
  Dockerfile with two SHA-256s (drift-tested). **git-delta** needs its two
  SHA-256s updated; 0.20 adds OSC-1717 metadata and takes width from
  `$COLUMNS`, both inert for us.
- **Playwright 1.64.0** moves `@playwright/test`, `playwright`, both
  `playwright-core` pins and Dockerfile `PLAYWRIGHT_VERSION` together (the
  drift test requires the Docker pin to equal the lockfile's resolved
  `playwright`). Breaking changes: device descriptors now forward `screen`
  (we use none), JSX in test files follows `tsconfig.json` (no `.spec.tsx`
  files), and **elements inside hidden iframes are now hidden** to actions and
  `toBeVisible()` — check `e2e/BrowserTab.spec.ts`, `e2e/DesignCanvas.spec.ts`,
  `e2e/agent-testing/design-canvas.spec.ts` and
  `e2e/agent-testing/web-annotations-electron.spec.ts`. Browsers move to
  Chromium 156, Firefox 157, WebKit 27.2; the backend's `playwright-core`
  drives browser previews, so preview capture is in scope.

Validation: `format:check`, `lint`, `typecheck`, `test` (includes the drift
test), `test:browser`, `test:agent:electron`, `docker:check-base`,
`docker:build`, `test:agent:docker`, `verify:packaged-backend`,
`test:cli:scenarios`. Effort: ~half a day. Risk: medium. Land it alone and
after the agent-SDK bump, which edits the same Dockerfile.

## Phase 2 — low-effort majors, Electron first

### PR 2a — Electron 42.11.5 → 44.7.0 (do first; deadline 2026-10-20)

Electron 42's last release is 42.11.12 and it leaves support when 45 ships on
2026-10-20. Go straight to 44 (supported until 2027-03-02); 43 adds nothing to
stage and ends support 2027-01-05. Both 43 and 44 still embed Node 24
(24.21.0 in 44.7.0), so nothing else in the toolchain has to move with it.

What affects us:

- **Electron 44 rebuilt `clipboard`.** `readImage`/`writeImage` are removed and
  `readText`/`writeText` return Promises. Affected: the four clipboard IPC
  handlers in `apps/desktop/electron/ipc.ts` (image read/write move to
  `clipboard.read()` / `clipboard.write([new ClipboardItem(…)])`), the
  `ClipboardLike` type in the same file, and `writeClipboardText` in
  `apps/desktop/electron/main.ts`, whose returned Promise is not awaited —
  typecheck will catch `ipc.ts` but **not** the un-awaited calls. Update the
  mocks in `tests/unit/electron/main-ipc.test.ts`. Renderers already go through
  IPC (`preload-api.ts`), so the removal of `clipboard` from renderers does not
  affect us.
- **Electron 44 drops macOS 12.** A Monterey user would auto-update to a build
  that does not launch. Decide before release: accept it (and say so in the
  release notes), or set `mac.minimumSystemVersion` so the updater stops
  offering it. The repo declares no minimum today.
- **Electron 43 `NativeImage.toBitmap()` converts to sRGB.**
  `browser-preview-capture-image.ts` masks screenshots through `toBitmap` →
  `createFromBitmap`; Display P3 captures may shift colour slightly.
- **`select-client-certificate` now fires for `net` requests.** `main.ts` uses
  `net.fetch` with no handler, so it now auto-selects a matching certificate
  instead of failing. Low risk.
- Not affected: Linux frameless-window changes (we use the normal frame),
  dialog default folder (no `dialog` open/save calls), ANGLE, `net.request`,
  32-bit targets, login items.

Validation: `typecheck`, `test`, `build:electron`, `test:agent:electron`
(`e2e/agent-testing/electron-main.spec.ts` has a clipboard smoke test;
`web-annotations-electron.spec.ts` covers capture and masking),
`package:linux`, `package:mac` (note: it installs the packaged app locally),
`verify:packaged-backend`. Manually paste an image into the composer and check
annotation masking on a Retina display. Effort: ~1 day. Risk: high only because
it is the shell of the whole app; the code change is small.

### PR 2b — lucide-react 0.562.0 → 1.56.0

1.x removed brand icons, removed the UMD build and sets `aria-hidden` by
default. Of the 205 names imported across 194 files, only **`Github`** is gone
(used in `SortableProjectGroup.tsx`, `GlobalSettings.sections.tsx`,
`ActionBar.view.tsx`, `AddProjectDialog.tsx`, `GitHubIssuesView.tsx`). Replace
it with a local SVG component. Old aliases (`AlertCircle`, `Loader2`, …) still
export. Bump `apps/web` and `apps/web-public` together. Validation: `typecheck`,
`test`, `test:browser`; spot-check that icon-only buttons still have an
accessible name, since `aria-hidden` is now the default. Effort: S.

### PR 2c — @hono/node-server 1.19.17 → 2.1.5

v2 requires Node ≥20 and removes the `/vercel` adapter. Both bridges only call
`serve({ fetch, port, hostname })` (`bridges/claude-bridge/src/index.ts`,
`bridges/codex-bridge/src/index.ts`) and run under Bun. Update both lockfiles.
Validation: `typecheck`, `test`, `build:claude-bridge`, `build:codex-bridge`,
then one real Claude and Codex turn in an isolated profile. Effort: S.

### PR 2d — happy-dom 21

21 turns off CSS file loading and iframe page loading by default
(`enableCSSFileLoading`, `enableIframePageLoading`). `tests/register-dom.ts`
calls `GlobalRegistrator.register()` with no settings and is preloaded from
`bunfig.toml` and `apps/web/bunfig.toml`. Expect
`apps/web/src/components/chat/AgentChatFind.test.tsx` to fail where it reads
`iframe.contentDocument` from an iframe without `src`; prefer fixing the test
(use `srcdoc`) over enabling page loading globally. Validation: `test`, then
rerun the full suite twice to rule out order-dependent DOM state. Effort: S.

### PR 2e — @types/node realignment

Today root, desktop and toolchain use `^25.9.7` (Node 25 has been EOL since
2026-06-01) and the four bridges use `^22.20.3`. Neither matches a runtime:

- Bridges, backend, toolchain and root tests run under Bun, which reports
  `process.version` v26.3.0, and `@types/bun` already pulls in
  `@types/node` 26 — use `^26.6.5`.
- `apps/desktop` (Electron main, Node 24) — use `^24`, matching the
  `@types/node ^24.9.0` Electron itself depends on.

The 22 → 26 jump in the bridges may surface type errors (stream and
`Buffer` generics). Update both lockfiles. Validation: `typecheck`, `test`.
Effort: S–M.

### PR 2f — formatter, parser and CI action

- `oxfmt` 0.73.0: `--check` passes on all 3,072 files, so no reformat. Its
  breaking changes are in the Markdown and TOML formatters; Markdown is
  ignored and the six `.toml` files pass.
- `oxc-parser` 0.154.0: breaking changes are on the Rust AST; our JS use
  (`parseSync`, `visitorKeys` in `tests/dom-assertion-safety.ts`) is
  unaffected.
- `jdx/mise-action` v5.1.2 (SHA pin): `minimum_release_age` now defaults to
  24h for the mise binary. Harmless while CI relies on `mise.toml` for tools.
- Optional: delete `tsx` from claude-bridge and codex-bridge; it only backs
  `dev` scripts no task runs. Replace with `bun --watch src/index.ts`.

Validation: `format:check`, `lint`, `test` (the parser feeds
`tests/unit/test-diagnostic-bounds.test.ts`). Effort: S.

## Phase 3 — medium-effort majors

### PR 3a — Vite 7.3.6 → 8.3.4 with @vitejs/plugin-react 4.7.0 → 6.1.2

Vite 8 replaces esbuild/Rollup with Oxc/Rolldown, minifies CSS with Lightning
CSS and raises the default browser target (Chrome 111 / Safari 16.4 /
Firefox 114 — already Tailwind v4's floor). plugin-react 6 removed its Babel
options; neither config uses them. Neither `apps/web/vite.config.ts` nor
`apps/web-public/vite.config.ts` uses a removed option (`rollupOptions`,
`manualChunks`, `esbuild`, `optimizeDeps`, `worker.*`, `define`). What to
watch:

- `server.hmr` in `apps/web/vite.config.ts` is deprecated in favour of
  `server.ws` (8.1); still synced automatically. Rename and re-test
  `dev:test`, which sets `VITE_DEV_HOST`.
- The five Monaco `?worker` imports in `apps/web/src/lib/monaco-loader.ts` are
  now bundled by Rolldown — the most likely runtime difference.
- Stricter CommonJS default-import interop can break bundled CJS dependencies
  at runtime only (`legacy.inconsistentCjsInterop` is the escape hatch).
- The `// @ts-expect-error process is a nodejs global` in
  `apps/web/vite.config.ts` may become an unused directive.
- plugin-react 5+ no longer adds React to `resolve.dedupe`; safe with Bun's
  isolated linker and a single `react@19.3.0`.
- **Keep `test-fixtures/preview-vite` on 7.3.6.** It stands in for a user's
  app (see its README); optionally add a Vite 8 copy to exercise preview
  proxying and HMR.

Validation: `typecheck`, `build:renderer`, `build:web-public`, `test`,
`test:browser` (its fixture server runs on the new Vite),
`test:agent:browser:isolated`, `test:agent:design:isolated`, `preview`, and a
manual pass over the Monaco editor, diff viewer and light/dark styles in a
packaged build. Effort: ~1 day including QA. Risk: medium (runtime-only
failures).

### PR 3b — oxlint 1.78 → 1.88 and the React Compiler rules

oxlint 1.79 split its React Compiler checks into individual rules in the
`correctness` category, which `.oxlintrc.json` enables as errors. On this tree
1.88 reports **337 new errors in 129 files** (326 in `apps/web`): refs (149),
set-state-in-effect (125), immutability (27), preserve-manual-memoization
(20) and others. This needs a decision, not just a bump:

- Option A (S): bump, set those rules to `warn` in `.oxlintrc.json`, and treat
  them as backlog the way `no-unused-vars` is treated.
- Option B (L): fix them. Several (`set-state-in-effect`, refs during render)
  are real React 19 correctness issues, but the fixes touch hot rendering
  paths such as the chat transcript.

Recommendation: A now, then burn down `apps/web` hot spots in separate PRs.
Update `docs/development/linting.md` and the AGENTS.md lint rules in the same
PR. Validation: `lint`, `format:check`. Effort: S (A) / L (B).

### PR 3c — marked 17.0.6 → 18.1.1 (blocked)

18 stops keeping trailing blank lines in block tokens' `raw` and targets
TypeScript 6 types. We use it in `components/chat/native-message-search.ts`
(a `Renderer` subclass, synchronous `marked.parse`) and
`components/markdown/tiptap-extensions.ts` (`marked.lexer` and token `raw`
checks — exactly what changed). `@tiptap/markdown` 3.32.0 still requires
`marked ^17.0.1`, so bumping now would leave our pre-check lexer and Tiptap's
parser on different versions. Re-check when Tiptap moves. Effort: S once
unblocked; risk medium because `raw` comparisons drive Markdown round-trips.

## Phase 4 — strategic and watch list

<a id="watch-list-and-replacements"></a>

| Item | Trigger | Notes |
| --- | --- | --- |
| electron-builder 27 / electron-updater 7 | Stable release | Requires Node ≥22.12 and is ESM. **Signed update manifests become mandatory for publishing builds**: `release:desktop` breaks until an update key exists (or `updateManifest: false`), and once a release ships with a key, installs reject unsigned manifests — a one-way door that needs a key-management decision first. `autoInstallOnAppQuit` → `autoInstallEvent` and `quitAndInstall(options)` affect `apps/desktop/electron/auto-update.ts`. Mac signing moves under `mac.sign`, implicit `--publish` goes, toolsets default to `latest`, pacman default dependencies change. Run `electron-builder migrate-schema`. Also removes the `sprintf-js` advisory (uses `@electron/get@5`). Update `docs/development/releasing.md`. Effort L, risk H. |
| Electron 45 | Ships 2026-10-20 | Announced changes do not affect us: popups are denied, permission handlers only allow clipboard-write, sandboxed views have no preload, `safeStorage` is already async. |
| Electron 46 | Before adopting | `capturePage` images report size in device-independent pixels. `maskCaptureImage` in `browser-preview-capture-image.ts` compares `getSize()` with the `toBitmap()` byte length, so on HiDPI screens it would **silently skip masking sensitive regions**. Also used in `browser-preview-capture-responsive.ts` and `browser-preview-capture.ts`. Fix and test this before 46. Plan the 44 → 46 move before 44's end of support on 2027-03-02. |
| Node 26 in Docker | Node 26 LTS (2026-10-28) plus a settling period | `NODE_VERSION=24.21.0` is the latest 24 LTS. The container's Node runs npm-installed agent CLIs and users' projects, not our code; keep 24 until at least Dec 2026. Drift test only asserts ≥22. |
| hono 5 | Stable release | 5.0.0-rc.1 published 2026-10-10. |
| `@dnd-kit/*` | `@dnd-kit/react` 1.0 | Classic packages have had no release since Dec 2024 (utilities since Nov 2023) but are not deprecated. The successor is 0.5.0. 23 files in `apps/web` (sidebar, pane layout, Kanban, GitHub issues); migration is a rewrite (L). Also drop the duplicate `@dnd-kit/core`/`sortable` entries from root `devDependencies` when touched. |
| `postcss-selector-parser` advisory | `@tailwindcss/typography` release | Typography 0.5.20 pins 6.0.10 exactly; an override to 7.x is a major jump for a build-time-only DoS. Accept until upstream moves. |
| TypeScript 7.1 | Stable release | Current 7.0.2 is latest; `next` is a 7.1 nightly. |

## Validation reference

| Change touches | Run |
| --- | --- |
| Any dependency or lockfile | `format:check`, `lint`, `typecheck`, `test` (AGENTS.md treats these as wide-reaching) |
| Lockfiles | Both frozen installs and `bun test tests/unit/version-drift.test.ts` |
| Renderer behaviour (Radix, Monaco, Tiptap, lucide, Vite) | `test:browser`, `test:agent:browser:isolated`; design canvas: `test:agent:design:isolated` |
| Electron, electron-builder | `build:electron`, `test:agent:electron`, `package:linux` / `package:mac`, `verify:packaged-backend` |
| Native or bundled backend deps (`sharp`, `playwright-core`) | `verify:packaged-backend`, `smoke:cli`, `test:cli:scenarios` |
| Dockerfile (Bun, mise, delta, Playwright) | `docker:check-base`, `docker:build`, `test:agent:docker` |

Run suites through `test:logged`, one suite per command, as AGENTS.md
requires.

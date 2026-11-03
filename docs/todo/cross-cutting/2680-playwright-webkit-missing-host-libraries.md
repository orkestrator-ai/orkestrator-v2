# Playwright WebKit cannot launch on an Arch Linux host

## Task analysis

Analysed 2026-11-02 against `main` at `38d55ee14`.

### Tasks

1. **Make the WebKit project of `test:preview:browser` launch on unsupported Linux hosts**: give WebKit its missing libraries without root. Status: done.
2. **Say so in the testing guide**: name the missing libraries and the workaround next to the engine install line. Status: done.

### 1. Make the WebKit project of `test:preview:browser` launch on unsupported Linux hosts

**Problem.** On beelink (Omarchy, an Arch Linux derivative) every WebKit test in `mise run test:preview:browser` fails at browser launch, so the suite exits non-zero even when every Chromium and Firefox case passes. Validation stages then report the required preview command as failed. Found during 1202 task 11 (GW-8 and GW-9).

**Context.** Playwright has no Arch build, so it installs its Ubuntu 24.04 WebKit bundle (`~/.cache/ms-playwright/webkit-2370`, Playwright 1.64). The bundle carries some libraries in `minibrowser-wpe/sys/lib`. Its `MiniBrowser` wrapper overwrites `LD_LIBRARY_PATH` with the bundle's own `lib` and `sys/lib`, so a caller cannot add a directory through the environment. `playwright install-deps` uses `apt` and does not apply to Arch.

**Investigation.** `ldd` on the bundle's binaries and libraries, with the bundle's own directories on the path, reports these libraries as not found: `libicudata.so.74`, `libicui18n.so.74`, `libicuuc.so.74`, `libxml2.so.2` and thirteen `libflite*.so.1` libraries. Arch ships newer sonames (ICU 76+, libxml2 2.14), so the system packages cannot satisfy them. Everything else resolves.

Workaround verified on 2026-11-02, with no root and no change to the shared browser cache:

1. Download the Ubuntu 24.04 packages `libicu74_74.2-1ubuntu3.1`, `libxml2_2.9.14+dfsg-1.3ubuntu3.10` and `libflite1_2.2-6build3` (amd64) from `archive.ubuntu.com` into an empty directory, and check their SHA-256 against the `noble-updates`/`noble` `Packages` indexes.
2. Unpack them with `bsdtar` into a private directory.
3. Build a private `PLAYWRIGHT_BROWSERS_PATH`: symlinks to the shared Chromium, headless shell, FFmpeg and Firefox directories, and a copy of `webkit-2370` (293 MB) with the unpacked `.so` files added to `minibrowser-wpe/sys/lib`. Keep it outside the worktree: `mise run format:check` scans untracked files under `output/` and fails on the bundle's `protocol.json`.
4. Run `PLAYWRIGHT_BROWSERS_PATH=<private dir> mise run test:preview:browser`.

With that, `ldd` reports nothing missing and the full suite with the Vite fixture passed twice: 58 passed, 2 skipped (the Chromium-only `vite-page-load.spec.ts`), WebKit included.

**Decisions.**

- **How should a host like this run WebKit?**
  - **A repository script that prepares a private browsers directory with the Ubuntu libraries, opted into with `PLAYWRIGHT_BROWSERS_PATH` (recommended).**
    - Pros: no root, no change to the shared cache, reproducible, and checksummed against Ubuntu's indexes.
    - Cons: downloads third-party binaries; must be refreshed when Playwright moves to a new WebKit revision or Ubuntu base; a validation stage still has to set the variable.
  - **Add the libraries to the shared `~/.cache/ms-playwright/webkit-*/minibrowser-wpe/sys/lib`.**
    - Pros: the plain command passes for every worktree on the host.
    - Cons: changes shared host state behind every concurrent build; lost on reinstall; unowned by the repository.
  - **Run the WebKit project in Playwright's Docker image and connect over `PW_TEST_CONNECT_WS_ENDPOINT`.**
    - Pros: the exact environment Playwright supports.
    - Cons: a large image pull; the browser must reach the harness's loopback servers (host networking); more moving parts than the gap is worth.
  - **Skip the WebKit project when it cannot launch.**
    - Pros: the suite goes green.
    - Cons: hides lost engine coverage; ruled out by the repository's rule against loosening tests.

### 2. Say so in the testing guide

**Problem.** The testing guide's preview section says to install the engines once, but not that WebKit needs Ubuntu 24.04 libraries on an unsupported distribution.

**Context.** `docs/development/testing-guide.md`, the `test:preview:browser` block.

**Investigation.** Nothing in `docs/` mentions the missing libraries.

**Decisions.**

- **Where to document it?**
  - **One sentence beside the install line, pointing at task 1's script (recommended).**
    - Pros: found where the failure is met.
    - Cons: waits for task 1.
  - **Only this todo.**
    - Pros: no guide churn.
    - Cons: the next agent meets the failure without the fix.

## Assumptions and decisions

### Task 1: one host-wide private directory, not one per worktree

`scripts/playwright-webkit-host-libs.ts` (run as `mise run test:preview:webkit-libs`) builds `${XDG_CACHE_HOME:-~/.cache}/orkestrator/playwright-browsers-ubuntu24.04-libs` by default (`--dir` overrides). A per-worktree copy would cost about 360 MB for every concurrent build; one directory outside the shared Playwright cache is still private to the repository's tooling, survives worktree deletion, and is published by an atomic rename so concurrent runs cannot see a half-built copy. The script refuses a directory inside the repository (the `format:check` problem above) or one overlapping the shared cache. A run with the same pins and WebKit revision reuses the copy; `--force` rebuilds it.

### Task 1: checksums pinned in the script, mirrors as fallbacks

The three packages are pinned by size and SHA-256 copied from the `noble-updates/main` and `noble/universe` `Packages` indexes on 2026-11-03 (the downloaded files matched them). Each is fetched over HTTPS from `archive.ubuntu.com`, falling back to Launchpad's permanent `+files` URL once an update supersedes the pool copy; both must match the same pin, the download is cut off past the pinned size, and nothing unverified is unpacked. The indexes' `InRelease` signature is not checked, because Arch has no Ubuntu keyring; the pin in the reviewed script is the trust anchor instead.

### Task 1: the `.deb` is read in-process

The script reads the `ar` and `tar` formats itself (`Bun.zstdDecompressSync` for the payload) and keeps only `lib*.so*` regular files and same-directory symlinks from `usr/lib/x86_64-linux-gnu/`, so no external extractor runs over the download and no entry can write outside `minibrowser-wpe/sys/lib`. It never replaces a library the bundle already ships.

### Task 1: the result is checked twice before the path is printed

After building, it runs Playwright's own dependency check (`ldd` over the eight `minibrowser-gtk`/`minibrowser-wpe` directories with those directories on `LD_LIBRARY_PATH`) and fails naming any library still missing, then launches headless WebKit from the private path and renders a page (`--no-launch-check` skips the launch). It warns, but proceeds, when Playwright's WebKit revision is not the verified `2370`; the two checks decide.

### Task 1: evidence on beelink, 2026-11-03

Without the private path, `bunx playwright test --config e2e/preview/playwright.preview.config.ts --project=webkit` failed at launch ("Host system is missing dependencies"; 3 failed, 16 did not run). With `PLAYWRIGHT_BROWSERS_PATH` from the script, the same WebKit project passed (19 passed, 1 skipped), the full suite with the Vite fixture passed (58 passed, 2 skipped: the Chromium-only `vite-page-load.spec.ts` under Firefox and WebKit), and `mise run test:logged -- --name preview-browser -- mise run test:preview:browser` without the fixture exited 0. The shared `~/.cache/ms-playwright/webkit-2370` was unchanged and no system package was installed.

### Task 1: upkeep is tied to the Ubuntu release, not the WebKit revision

The script does not warn when Playwright's WebKit revision differs from the verified `2370`; that fires on most Playwright bumps although the libraries depend only on the Ubuntu release (`UBUNTU_BASE`, currently the `ubuntu24.04` fallback; Playwright 1.64 already ships an `ubuntu26.04` build). A stale pin fails loudly instead: the library check names what is still missing and the script exits non-zero, and Launchpad keeps superseded package files so the current pins stay downloadable. Replacing the pins is needed only when a Playwright upgrade changes the fallback release.

### Task 2: three comment lines beside the install line

The guide's `test:preview:browser` block names the missing libraries and points at `mise run test:preview:webkit-libs` and the `PLAYWRIGHT_BROWSERS_PATH` it prints. Validation stages on such a host still have to set the variable themselves; the plain command is unchanged.

## Related

- [1202](1202-efficiency-review-follow-ups.md) task 11, where the failure blocked the recorded `test:preview:browser` check.

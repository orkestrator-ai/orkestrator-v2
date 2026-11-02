# Playwright WebKit cannot launch on an Arch Linux host

## Task analysis

Analysed 2026-11-02 against `main` at `38d55ee14`.

### Tasks

1. **Make the WebKit project of `test:preview:browser` launch on unsupported Linux hosts**: give WebKit its missing libraries without root. Status: open.
2. **Say so in the testing guide**: name the missing libraries and the workaround next to the engine install line. Status: open (depends on 1).

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

## Related

- [1202](1202-efficiency-review-follow-ups.md) task 11, where the failure blocked the recorded `test:preview:browser` check.

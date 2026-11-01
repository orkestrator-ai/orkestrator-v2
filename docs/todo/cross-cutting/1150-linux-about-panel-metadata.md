# Linux About panel shows the executable name, no version and no icon

## Task analysis

Analysed 2026-10-31 against `main` at `931e5541`. Re-checked and implemented 2026-11-01 against `main` at `93b99bfb`: nothing had changed, and still nothing called `app.setAboutPanelOptions`.

### Tasks

1. **Give the Windows/Linux About panel the product's name, version and icon**: Help › About shows "Orkestrator AI", the app version and the app icon. Status: done (2026-11-01) on Linux, checked on a packaged build and an unpackaged run on Xvfb (see Current state). Windows was not run (see Needs verification).

### 1. Give the Windows/Linux About panel the product's name, version and icon

**Problem.** On a packaged Linux build, Help › About opens a GTK dialog titled **About orkestrator-v2**. It shows the executable name, a missing-image icon, Credits, License and Close. It has no product name and no version, so a user cannot read which build they run from the menu.

**Context.** Found while qualifying [0325](0325-keyboard-shortcuts-desktop-gaps.md) task 5 on 2026-10-31: packaged commit `931e5541` (2.34.4-beta, Electron 45.0.0), built with `bunx electron-builder --linux --dir` and run on an isolated Xvfb display. The Windows/Linux Help menu uses the plain `about` role (`apps/desktop/electron/application-menu.ts:210`). Nothing in `apps/desktop/electron` calls `app.setAboutPanelOptions`, so Electron's Linux panel falls back to GTK's program name (the executable, `orkestrator-v2`). The agent-test runtime profile renames the app (`app.setName`, `apps/desktop/electron/main.ts:199`), but the panel ignored that name too, so the result is the same without a profile. The 2026-10-28 menu fixture showed the same thing ("About electron"). Windows has not been looked at; Electron's Windows panel is different code.

**Investigation.** Not started beyond the observation. Electron documents `applicationName`, `applicationVersion`, `copyright`, `website` and `iconPath` as honoured on Linux. The product name is `PRODUCT_NAME` (`apps/desktop/electron/app-constants.ts`) and the version is `desktopApplicationVersion(app)` (`apps/desktop/electron/app-version.ts`, passed to the backend at `apps/desktop/electron/main.ts:1387`). The packaged icons come from `icons/` (`package.json` `build.linux.icon`).

**Decisions.**

- **How to fill the panel?**
  - **Call `app.setAboutPanelOptions` once at startup with the product name, the desktop version and the packaged icon path, on every platform (recommended).**
    - Pros: one call; Linux, Windows and macOS all show the same name and version; a development profile can pass its own title.
    - Cons: the icon path differs between packaged and development layouts; macOS already shows the bundle's name and version, so it gains nothing there.
  - **Replace the Windows/Linux `about` role with a custom About window.**
    - Pros: full control over the content, including the build commit.
    - Cons: a new window to build, style and test, for a dialog users rarely open.
  - **Leave it.**
    - Pros: no work.
    - Cons: the panel stays wrong on Linux.
- **What counts as done?** A packaged Linux run shows "Orkestrator AI", the version and the icon in Help › About, with a screenshot, and a unit test pins the options passed to `setAboutPanelOptions`.

## Current state

### Implementation (2026-11-01)

`apps/desktop/electron/about-panel.ts` builds the options and finds the icon;
`main.ts` calls `app.setAboutPanelOptions` once, straight after
`app.setName`, before `ready`. The options are `applicationName` (the
product name, or the runtime profile's title), `applicationVersion` and
`version` (both `desktopApplicationVersion(app)`), and `iconPath`. A packaged
app reads `<resources>/icon.png`, which a new root `package.json`
`build.extraResources` entry copies from
`apps/desktop/electron/resources/icon.png`; an unpackaged run reads that
source file, resolved from the emitted `apps/desktop/dist/electron` bundle.
`apps/desktop/tests/about-panel.test.ts` pins the options, both icon paths,
that the unpackaged path exists, and that packaging copies the same file to
the name the app reads. `main-startup-switches.test.ts` checks the call is
made during module loading with the profile's title and the package version,
and `tests/unit/release/package-config.test.ts` pins the resource entry.

### Packaged Linux check (2026-11-01)

**Setup.** Arch Linux (Omarchy), kernel 7.1.8, x86_64. Packaged commit
`f102ed9c` (2.34.5-beta, Electron 45.0.0), built with `mise run download:bun`,
`mise run build:all` and `bunx electron-builder --linux --dir` into a
temporary directory; the install step was not run. `resources/icon.png` was in
the unpacked app. The app ran on a private Xvfb display (X11, no window
manager, 1440x900) with a disposable `HOME` and XDG directories, a private
runtime directory, a private D-Bus session with no service files,
`DOCKER_HOST` pointing at a socket that does not exist, `--password-store=basic`
and an `agent-test` runtime profile on its own loopback gateway port (never
34121 or 34122). Xvfb and xdotool were unpacked from Arch's packages into
`/tmp`, checked against the SHA-256 sums in pacman's sync database; nothing
was installed. Help and About were clicked with XTEST through xdotool, and
the panel was closed with Escape. The scripts and screenshots are under the
git-ignored `output/agent-testing/packaged-linux-1150/`; they are not
committed.

A packaged app with no profile would bind the live gateway port 34121, so
the "Orkestrator AI" row used a profile whose `electronTitle` was set to
"Orkestrator AI". `main.ts` uses the profile's title in place of
`PRODUCT_NAME` and nothing else, so this is what an unprofiled install shows.

| Run | Panel window title | Panel contents |
| --- | --- | --- |
| Packaged, profile titled "Orkestrator AI" | About Orkestrator AI | The app icon, **Orkestrator AI**, **2.34.5-beta**, Credits, License, Close |
| Packaged, standard `agent-test` profile | About Orkestrator AI — DEV [about-1150] | The app icon, **Orkestrator AI — DEV [about-1150]**, **2.34.5-beta** |
| Unpackaged `apps/desktop/dist/electron/main.js` with `ELECTRON_DEV=1`, as the dev launcher starts it | About Orkestrator AI — DEV [about-1150] | The app icon, **Orkestrator AI — DEV [about-1150]**, **2.34.5-beta** (the package version, not Electron's 45.0.0) |

The unpackaged run used Electron 45.0.0 from the shared download cache
(checksum matched `node_modules/electron/checksums.json`), unpacked into
`/tmp`, and the built web bundle served on a private loopback port in place
of Vite. Each app quit with Ctrl+Q and every process, port and display it
used was gone afterwards.

## Assumptions and decisions

Made 2026-11-01 against `main` at `93b99bfb`.

### Task 1: how to fill the panel

- **Chose:** the recommended option, one `app.setAboutPanelOptions` call on
  every platform.
- **Why:** the code gave no reason to do otherwise; the panel is a built-in
  role on every platform, and one call keeps them in step.

### Task 1: which name the panel shows

- **Chose:** `productName`, the runtime profile's `electronTitle` when there
  is one and `PRODUCT_NAME` otherwise: the same name `app.setName`, the window
  titles and the macOS app menu use.
- **Why:** a development or agent-test profile then says which profile it is,
  as the file's recommended option expected, and an install with no profile
  shows "Orkestrator AI".

### Task 1: where the icon comes from

- **Chose:** ship `apps/desktop/electron/resources/icon.png` (512x512) as an
  extra resource named `icon.png`, and read it from `process.resourcesPath`
  when `app.isPackaged`; otherwise read the source file relative to the
  emitted main bundle.
- **Why:** nothing under `buildResources` reaches the app; `build.linux.icon`
  only installs the desktop entry's icons into the icon theme, and an
  unpacked `--dir` build or an AppImage run without integration has no themed
  icon to name. The file is about 40 KB. `app.isPackaged`, not
  `ELECTRON_DEV`, picks the branch, so an Electron spec that starts the
  bundle without the dev flag still finds the icon instead of looking in
  Electron's own resources directory. GTK scales it to 64x64.

### Task 1: setting `version` as well as `applicationVersion`

- **Chose:** pass the same version as `version`, which only macOS reads (the
  build number it shows in brackets).
- **Why:** an unpackaged macOS run would otherwise show Electron's release
  there. A packaged macOS build already has the same value
  (`CFBundleVersion` defaults to the version), so nothing changes for users.

### Task 1: no copyright, website or credits

- **Chose:** leave them out.
- **Why:** the task asks for the name, version and icon. GTK's Credits and
  License buttons are there with or without them. A website (the GitHub
  repository, as the Linux release config's `homepage`) is easy to add later.

### Task 1: checking the product name with a profile titled "Orkestrator AI"

- **Chose:** run the packaged app with an agent-test profile whose title is
  "Orkestrator AI", rather than with no profile.
- **Why:** with no profile, a packaged app's gateway defaults to 34121, the
  live instance's port, which this run must not bind. The profile's title is
  the only input to the panel's name.

## Needs verification

- **Windows.** Electron's Windows About panel is different code, and it reads
  `applicationName`, `applicationVersion` and `iconPath` too. No Windows build
  is configured (`build.win` is unset) and this host is Linux, so it was not
  run. The native menu CI workflow takes a Windows About screenshot, but from
  the fixture, not the app.
- **macOS.** The options apply there too. A packaged macOS panel used to take
  its name from the bundle (`CFBundleName`, which electron-builder sets from
  `build.productName`, "OrkestratorV2") and should now read "Orkestrator AI",
  matching the app menu. The version is unchanged. This was not observed:
  no Mac was available.

## Related

- [0325](0325-keyboard-shortcuts-desktop-gaps.md): the Linux menu-bar row that recorded this panel.

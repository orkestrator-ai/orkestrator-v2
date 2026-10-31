# Linux About panel shows the executable name, no version and no icon

## Task analysis

Analysed 2026-10-31 against `main` at `931e5541`.

### Tasks

1. **Give the Windows/Linux About panel the product's name, version and icon**: Help › About shows "Orkestrator AI", the app version and the app icon. Status: open.

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

## Related

- [0325](0325-keyboard-shortcuts-desktop-gaps.md): the Linux menu-bar row that recorded this panel.

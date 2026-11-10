import { defineLogAreas, ESSENTIAL_ERROR_FIELDS, THROTTLE_LOG_EVENTS } from "./define.js";

export const DESKTOP_LOG_AREAS = defineLogAreas({
  desktop: {
    description: "The Electron main process: startup, windows, quit and the Local backend's life.",
    events: {
      "backend.docker-context-seed-failed":
        "An agent-test profile fell back to the default Docker context.",
      "backend.exited": {
        description:
          "The Local backend exited unexpectedly; Local work is unavailable. `error.exitCode` and `error.signal` say how.",
        essential: true,
        fields: ESSENTIAL_ERROR_FIELDS,
      },
      "backend.exited-recovering": {
        description:
          "The Local backend exited just after a remote update; relaunching unattended. `error.exitCode` and `error.signal` say how.",
        essential: true,
        fields: ESSENTIAL_ERROR_FIELDS,
      },
      "backend.keychain-link-remove-failed":
        "An agent-test profile kept a legacy link to the host keychain.",
      "backend.start-failed": {
        description: "The Local backend did not start; continuing with remote machines.",
        essential: true,
        fields: ESSENTIAL_ERROR_FIELDS,
      },
      "clipboard.write-failed": "Writing text to the system clipboard failed.",
      "dev-mode.ignored-packaged":
        "A packaged app was launched with ELECTRON_DEV=1 and ignored it; it loads its bundled renderer.",
      "instance.already-running": "Another instance holds this data directory; this one will quit.",
      "main-thread.stalled": {
        description:
          "A timer fired late, so windows, IPC and the stdout reader waited. `cpuMs` is the CPU time the process used in the window: near `lagMs` the main thread was busy, far below it the thread waited.",
        essential: true,
        minLevel: "error",
        fields: { lagMs: "number", intervalMs: "number", cpuMs: "number" },
      },
      "process-memory":
        "Development only: working set per Electron process type, sampled on an interval.",
      "process-memory.failed": "Development only: one process memory sample could not be read.",
      "quit.stopping-backend": "The app is quitting and has asked the Local backend to stop.",
      "realm-partitions.list-failed":
        "The partitions directory could not be read, so retired workspace realm storage stays until the next start.",
      "realm-partitions.remove-failed":
        "Some retired workspace realm storage directories could not be removed; count says how many.",
      "realm-partitions.removed":
        "Retired workspace realm storage was removed at startup; count says how many directories.",
      "relaunch.schedule-failed":
        "The AppImage relaunch waiter failed; using Electron's relauncher.",
      "relaunch.service-register-failed":
        "The AppImage relaunch service was refused; using a detached waiter.",
      "renderer.gone-giving-up": "A renderer kept dying, so the window is no longer reloaded.",
      "renderer.gone-reloading": "A renderer died and the window is being reloaded.",
      "renderer.reload-failed": "Reloading a window after its renderer died failed.",
      "restart-prompt.failed": "A native restart prompt could not be shown.",
      "saved-machines.attach-failed": "Saved machines were not imported into the command node yet.",
      "saved-machines.attached": "Saved machines were imported into the local command node.",
      "startup.failed": "The application failed to start.",
      "uncaught-exception": {
        description: "The main process hit an uncaught exception.",
        essential: true,
        fields: ESSENTIAL_ERROR_FIELDS,
      },
      "uncaught-exception.dialog-failed": "The uncaught exception sheet could not be shown.",
      "window.create-failed": "A menu-driven new window could not be created.",
      "window.recreate-failed": "The main window could not be recreated on activation.",
      "window.second-launch-failed": "A second launch could not open a window.",
    },
  },
  "desktop.startup": {
    description:
      "Renderer startup markers and renderer process failures. These are the only events the renderer can place in the persistent log.",
    // Support recipes and docs/architecture/bridge-diagnostics.md search for this.
    tag: "DesktopStartup",
    events: {
      "backend-unavailable": "The renderer could not complete a Local backend read in time.",
      "bridge-unavailable": "The preload API or connection-list IPC did not answer.",
      checking: "The renderer began waiting for the desktop connection.",
      "page-load-failed": "Chromium failed to load the main document.",
      "preload-failed": "Electron rejected the preload script.",
      ready: "The renderer reached the desktop connection and may mount the workspace.",
      "renderer-error": "An uncaught error occurred while the renderer was starting.",
      "renderer-gone": "A renderer process exited.",
      "renderer-load-failed": "Importing or mounting the application failed.",
      "unhandled-rejection": "An unhandled rejection occurred while the renderer was starting.",
    },
  },
  "desktop.permissions": {
    description: "Permission requests refused on the renderer's session.",
    events: {
      denied: "A renderer asked for a permission the policy does not grant.",
    },
  },
  "desktop.webrequest": {
    description:
      "Main-process webRequest listeners on Electron sessions. Listener names only; never a URL, header or error message.",
    events: {
      "listener.failed-closed":
        "A listener's decision threw or rejected, so it answered with its fail-closed response.",
      "observer.failed":
        "A listener with no callback (a redirect observer) threw; its fallback ran.",
      "callback.failed": "Electron's webRequest callback threw while a listener answered.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
  "desktop.dialog": {
    description: "Native dialogs, whose modal loops hold the main thread while they are open.",
    events: {
      "attention-failed": "A dialog could not ask for the user's attention.",
      closed: "A native dialog closed.",
      "hidden-cancelled": "A hidden profile cancelled a dialog without opening native UI.",
      "no-display-cancelled":
        "A headless Electron with no display cancelled a dialog instead of opening native UI.",
      "open-failed": "A dialog could not open; it was answered as cancelled.",
      opening: "A native dialog is opening.",
      "preview-beforeunload-ignored": "A browser preview's beforeunload handler was ignored.",
      "renderer-beforeunload-cancelled": "A renderer's beforeunload handler cancelled an unload.",
    },
  },
  "backend.client": {
    description: "The desktop's HTTP and event stream client for a backend.",
    events: {
      "event-stream.disconnected": "The event stream dropped; the client reconnects with backoff.",
      "event-stream.malformed-frame": "An event stream frame could not be parsed and was dropped.",
    },
  },
  connections: {
    description: "The desktop's saved machines and active connection.",
    events: {
      "catalogue.legacy-read-failed": "The previous connection list could not be read to migrate.",
      "catalogue.restored-from-backup": "The device catalogue was unreadable; the backup was used.",
      "restore.failed": "The previous remote connection could not be restored; using Local.",
      "secure-storage.waiting": "Startup is waiting on an operating system keychain prompt.",
    },
  },
  workspaces: {
    description: "Node workspaces (node scopes) the desktop holds on other machines.",
    events: {
      "route.moved-direct": "A relayed workspace moved to its direct route.",
      "workspace.opened":
        "The command node issued a node workspace grant; durationMs is the open_node_workspace call.",
      "workspace.route-probed":
        "One route of a node workspace was probed; outcome is fixed, durationMs the probe.",
    },
  },
  toolchain: {
    description: "Preparing the pinned agent toolchain at desktop startup.",
    events: {
      "bootstrap-progress.show-failed": "The toolchain progress window could not be shown.",
      "prepare.failed": "Preparing the pinned agent tools failed.",
      "prepare.ready":
        "The pinned agent tools were verified and activated; durationMs is how long startup waited.",
    },
  },
  "artifact-host": {
    description: "Live artifact hosts in the desktop app.",
    events: {
      "host.ended": "A host ended; fields count its blocked and rejected requests by reason.",
    },
  },
});

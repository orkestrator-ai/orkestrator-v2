/**
 * One routing path for the app-level keyboard shortcuts (`APP_SHORTCUTS`:
 * ⌘K search, ⌘⇧/ shortcuts dialog, ⌘, settings, ⌘T new agent tab, and
 * ⌘⇧D sidebar group-by), so they work wherever focus is in the window.
 *
 * The window's document runs one capture-phase key router. It claims an app
 * shortcut before the focused surface (composer, terminal, editor) can
 * handle or stop it, except where that surface owns the key
 * (`appClaimsShortcut`), and hands it to `requestAppShortcut`, which runs
 * this document's handlers (`onAppShortcut`). The other entry points feed
 * the same function: the design frame bridge (design sandboxes) and Electron
 * main's `APP_SHORTCUT_EVENT` (native artifact views).
 *
 * One key router for every node the window shows in its own tree (plan item
 * 5003): another node's workspace is in this document, so its keys reach
 * the window's handlers directly. Its workspace handlers sit beside the
 * window's own node's (which stays mounted, hidden, while another node is
 * shown), so a workspace-owned
 * shortcut runs only the handlers of the workspace on show: handlers say which
 * workspace they belong to (`onAppShortcut(id, handler, { workspace })`) and
 * the window says which one it shows (`setShownAppShortcutWorkspace`).
 */

import {
  APP_SHORTCUT_EVENT,
  appClaimsShortcut,
  appShortcut,
  isAppShortcutId,
  matchAppShortcut,
  type AppShortcutId,
  shortcutFocus,
} from "@orkestrator/protocol/keyboard-shortcuts";
import { detectShortcutPlatform } from "@/lib/keyboard-shortcuts";
import { listen } from "@/lib/native/events";

export { shortcutFocus } from "@orkestrator/protocol/keyboard-shortcuts";

type Handler = () => void;

interface Registration {
  readonly handler: Handler;
  /** The workspace (a node scope) the handler acts on; none for document-wide handlers. */
  readonly workspace?: unknown;
}

const handlers = new Map<AppShortcutId, Set<Registration>>();
let shownWorkspace: (() => unknown) | null = null;
/** Requested while their UI was being shown; delivered to the next handler. */
const pending = new Set<AppShortcutId>();
let unhandled: ((id: AppShortcutId) => boolean) | null = null;
let routerUsers = 0;
let detachRouter: (() => void) | null = null;

function handleKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented) return;
  const id = matchAppShortcut(event);
  if (!id) return;
  const claimed = appClaimsShortcut(
    appShortcut(id),
    event,
    detectShortcutPlatform(),
    shortcutFocus(event.target),
  );
  if (!claimed) return;
  // Capture phase on the window runs before Monaco, xterm and the composer;
  // stopping here keeps them, and the desktop menu's key equivalent, from
  // handling the key as well.
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) requestAppShortcut(id);
}

function attachRouter(): () => void {
  window.addEventListener("keydown", handleKeyDown, true);
  // Desktop only: a key typed in a native view that runs no router.
  const unlisten = listen<unknown>(APP_SHORTCUT_EVENT, ({ payload }) => {
    if (isAppShortcutId(payload)) requestAppShortcut(payload);
  });
  return () => {
    window.removeEventListener("keydown", handleKeyDown, true);
    void unlisten.then((dispose) => dispose());
  };
}

/**
 * Keep this document's key router installed until the returned function is
 * called. Every handler retains it, so a component rendered on its own (a
 * fixture, a test) routes its shortcut too.
 */
export function retainAppShortcutRouter(): () => void {
  if (routerUsers++ === 0) detachRouter = attachRouter();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--routerUsers === 0) {
      detachRouter?.();
      detachRouter = null;
    }
  };
}

/** Deliver an app shortcut to the handlers of its UI. */
export function requestAppShortcut(id: AppShortcutId): void {
  const current = Array.from(handlers.get(id) ?? []);
  if (current.length > 0) {
    // A workspace's shortcut acts on the workspace on show, never on a hidden one.
    const shown =
      appShortcut(id).owner === "workspace" && shownWorkspace ? shownWorkspace() : undefined;
    const targets =
      shown === undefined
        ? current
        : current.filter(
            (registration) =>
              registration.workspace === undefined || registration.workspace === shown,
          );
    for (const registration of targets) registration.handler();
    return;
  }
  // The UI is not mounted (the sidebar holding the search is hidden). If the
  // window can show it, the request waits for it; otherwise it is dropped,
  // never delivered later by surprise.
  if (unhandled?.(id)) pending.add(id);
}

/**
 * Run `handler` for each request of `id` in this document, including one
 * made while no handler was mounted. `workspace` names the workspace (its
 * node scope) a workspace-owned shortcut's handler acts on, so it runs only
 * while that workspace is the one shown.
 */
export function onAppShortcut(
  id: AppShortcutId,
  handler: Handler,
  options: { workspace?: unknown } = {},
): () => void {
  const release = retainAppShortcutRouter();
  let set = handlers.get(id);
  if (!set) {
    set = new Set();
    handlers.set(id, set);
  }
  const registration: Registration =
    options.workspace === undefined ? { handler } : { handler, workspace: options.workspace };
  set.add(registration);
  if (pending.delete(id)) handler();
  return () => {
    set.delete(registration);
    release();
  };
}

/**
 * Which workspace the window shows, for workspace-owned shortcuts: `resolve`
 * returns the shown workspace's key (its node scope), or `null` while the
 * window shows a workspace it has no handlers for (one whose scope is still
 * opening). One per
 * document; returns the unregister function. Without one, every handler runs.
 */
export function setShownAppShortcutWorkspace(resolve: () => unknown): () => void {
  shownWorkspace = resolve;
  return () => {
    if (shownWorkspace === resolve) shownWorkspace = null;
  };
}

/**
 * What the window does with a request nothing handled, such as showing the
 * sidebar for search: `true` when it is mounting the handler, so the request
 * should wait for it. One per document; returns the unregister function.
 */
export function setUnhandledAppShortcut(handler: (id: AppShortcutId) => boolean): () => void {
  unhandled = handler;
  return () => {
    if (unhandled === handler) unhandled = null;
  };
}

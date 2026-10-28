/**
 * One routing path for the app-level keyboard shortcuts (`APP_SHORTCUTS`:
 * ⌘K search, ⌘⇧K shortcuts dialog), so they work wherever focus is in the
 * window.
 *
 * Every app document (the window's shell and each workspace realm) runs one
 * capture-phase key router. It claims an app shortcut before the focused
 * surface (composer, terminal, editor) can handle or stop it, except where
 * that surface owns the key (`appClaimsShortcut`), and hands it to
 * `requestAppShortcut`. The other entry points feed the same function: the
 * design frame bridge (design sandboxes), a realm's `shortcut` message (shell
 * side), and Electron main's `APP_SHORTCUT_EVENT` (native artifact views).
 *
 * `requestAppShortcut` delivers to the shortcut's owner: a window-owned
 * shortcut typed in a realm crosses to the shell over the realm message
 * channel; otherwise this document's handlers (`onAppShortcut`) run.
 */

import {
  APP_SHORTCUT_EVENT,
  appClaimsShortcut,
  appShortcut,
  isAppShortcutId,
  matchAppShortcut,
  type AppShortcutId,
  type ShortcutFocus,
} from "@orkestrator/protocol/keyboard-shortcuts";
import { isWorkspaceRealm, postToShell } from "@/lib/federation/workspace-realm";
import { detectShortcutPlatform } from "@/lib/keyboard-shortcuts";
import { listen } from "@/lib/native/events";

type Handler = () => void;

const handlers = new Map<AppShortcutId, Set<Handler>>();
/** Requested while their UI was being shown; delivered to the next handler. */
const pending = new Set<AppShortcutId>();
let unhandled: ((id: AppShortcutId) => boolean) | null = null;
let routerUsers = 0;
let detachRouter: (() => void) | null = null;

const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** What kind of surface `target` is, for `appClaimsShortcut`. */
export function shortcutFocus(target: EventTarget | null): ShortcutFocus {
  if (!(target instanceof Element)) return "page";
  // xterm's helper textarea is a text field, but its keys go to a shell.
  if (target.closest(".xterm")) return "terminal";
  if (target.closest(".monaco-editor")) return "text";
  if (target instanceof HTMLElement && target.isContentEditable) return "text";
  if (target instanceof HTMLInputElement) return NON_TEXT_INPUTS.has(target.type) ? "page" : "text";
  return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
    ? "text"
    : "page";
}

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

/** Deliver an app shortcut to the document that owns its UI. */
export function requestAppShortcut(id: AppShortcutId): void {
  if (appShortcut(id).owner === "window" && isWorkspaceRealm()) {
    postToShell({ type: "shortcut", shortcut: id });
    return;
  }
  const current = handlers.get(id);
  if (current && current.size > 0) {
    for (const handler of Array.from(current)) handler();
    return;
  }
  // The UI is not mounted (the sidebar holding the search is hidden). If the
  // window can show it, the request waits for it; otherwise it is dropped,
  // never delivered later by surprise.
  if (unhandled?.(id)) pending.add(id);
}

/**
 * Run `handler` for each request of `id` in this document, including one
 * made while no handler was mounted.
 */
export function onAppShortcut(id: AppShortcutId, handler: Handler): () => void {
  const release = retainAppShortcutRouter();
  let set = handlers.get(id);
  if (!set) {
    set = new Set();
    handlers.set(id, set);
  }
  set.add(handler);
  if (pending.delete(id)) handler();
  return () => {
    set.delete(handler);
    release();
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

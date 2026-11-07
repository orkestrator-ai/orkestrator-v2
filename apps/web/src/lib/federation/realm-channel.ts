/**
 * The realm protocol's two ends, as a value instead of the page.
 *
 * A workspace realm (`workspace-realm.ts`) talks to its window over the
 * page: its URL says it is a realm and what it opened on, and its messages
 * cross desktop IPC or a frame's `postMessage`. A node shown in the window's
 * own tree (plan item 4001, `InTreeWorkspace`) runs the same realm-side code
 * (`WorkspaceRealmHost`, `RealmTitleBarPanels`) in the window's document, so
 * those components read their channel from context instead of from the page:
 *
 * - `pageRealmChannel`: the URL and `window` reads of a realm document, and
 *   in the window's own document a channel that is not a realm (`isRealm`
 *   false, posts dropped, no messages). The default of `RealmChannelContext`.
 * - `createRealmLoopback(initial)`: an in-memory pair for an in-tree node.
 *   The window's side (`send`, `onRealmMessage`) is what `useRealmRequests`
 *   drives; the realm side is provided to the in-tree subtree. Messages pass
 *   through the same parsers as the page transports and are delivered in a
 *   later microtask, in order, as a transport would; a message that arrives
 *   while the other side does not listen is dropped, as a frame that has not
 *   loaded drops it, which is why the realm says `ready` once it listens.
 *
 * Plan item 4005 replaces the loopback's messages with direct calls one by
 * one (report Appendix C); 6002 deletes the page channel with realms.
 *
 * Imperative callers outside React (`open-workspace.ts`, `settings-navigation.ts`,
 * `open-bug-report.ts`, `app-shortcuts.ts`, `realm-boot-timing.ts`) keep the
 * page channel on purpose: under an in-tree node they run in the window's
 * document, where the window's direct path is the unified behaviour.
 */

import { createContext, useContext } from "react";
import {
  isWorkspaceRealm,
  onShellMessage,
  parseShellMessage,
  postToShell,
  realmInitialRequest,
  type RealmSelectRequest,
  type RealmToShellMessage,
  type ShellToRealmMessage,
} from "./workspace-realm";

/** The realm side of the protocol, wherever the realm runs. */
export interface RealmChannel {
  /** `page`: a realm document (or not a realm at all); `loopback`: a node in the window's tree. */
  readonly kind: "page" | "loopback";
  /** Whether this subtree is another node's workspace in a command node's window. */
  isRealm(): boolean;
  /** What the window opened the realm on. */
  initialRequest(): RealmSelectRequest | null;
  /** Realm side: tell the window. */
  post(message: RealmToShellMessage): void;
  /** Realm side: requests from the window. */
  onMessage(handler: (message: ShellToRealmMessage) => void): () => void;
}

/** The page's channel: a realm document's URL and transport, or none in the window. */
export const pageRealmChannel: RealmChannel = Object.freeze({
  kind: "page" as const,
  isRealm: isWorkspaceRealm,
  initialRequest: realmInitialRequest,
  post: postToShell,
  onMessage: onShellMessage,
});

/** One in-tree node's loopback. */
export interface RealmLoopback {
  /** The realm side, for `RealmChannelContext`. */
  readonly realm: RealmChannel;
  /** Window side: what `useRealmRequests` sends. */
  send(message: ShellToRealmMessage): void;
  /** Window side: what the realm posts, unparsed, as the page transports deliver it. */
  onRealmMessage(handler: (message: unknown) => void): () => void;
  /** Ends the pair: pending and later messages are dropped, listeners released. */
  close(): void;
  readonly closed: boolean;
}

export interface RealmLoopbackOptions {
  /** Defers each delivery; defaults to `queueMicrotask`. Tests may deliver synchronously. */
  readonly schedule?: (deliver: () => void) => void;
}

/**
 * An in-memory realm channel opened on `initial`, the request a realm
 * document would have found in its URL (`useRealmRequests`' `restart()`).
 */
export function createRealmLoopback(
  initial: Omit<RealmSelectRequest, "type"> | null,
  options: RealmLoopbackOptions = {},
): RealmLoopback {
  const schedule = options.schedule ?? queueMicrotask;
  const realmListeners = new Set<(message: ShellToRealmMessage) => void>();
  const shellListeners = new Set<(message: unknown) => void>();
  let closed = false;

  // Whoever listens when the message arrives gets it; nobody listening drops it.
  const deliver = <T>(listeners: Set<(message: T) => void>, message: T) => {
    if (closed) return;
    schedule(() => {
      if (closed) return;
      // A copy: a listener may unsubscribe while the message is delivered.
      for (const listener of Array.from(listeners)) listener(message);
    });
  };

  const realm: RealmChannel = Object.freeze({
    kind: "loopback" as const,
    isRealm: () => true,
    initialRequest: () => (initial ? { type: "select" as const, ...initial } : null),
    post: (message: RealmToShellMessage) => {
      // The window's side parses, as it does a frame's or a view's message.
      deliver(shellListeners, message as unknown);
    },
    onMessage: (handler: (message: ShellToRealmMessage) => void) => {
      if (closed) return () => undefined;
      realmListeners.add(handler);
      return () => {
        realmListeners.delete(handler);
      };
    },
  });

  return {
    realm,
    send(message) {
      // Parsed as `onShellMessage` parses what crosses the page.
      const parsed = parseShellMessage(message);
      if (parsed) deliver(realmListeners, parsed);
    },
    onRealmMessage(handler) {
      if (closed) return () => undefined;
      shellListeners.add(handler);
      return () => {
        shellListeners.delete(handler);
      };
    },
    close() {
      closed = true;
      realmListeners.clear();
      shellListeners.clear();
    },
    get closed() {
      return closed;
    },
  };
}

/** The realm channel of the nearest in-tree node, or the page's. */
export const RealmChannelContext = createContext<RealmChannel>(pageRealmChannel);

export function useRealmChannel(): RealmChannel {
  return useContext(RealmChannelContext);
}

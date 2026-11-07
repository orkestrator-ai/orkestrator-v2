/**
 * This renderer's window scope, with its command scope open over
 * `window.orkestrator`. Created on first use and never disposed by the app:
 * the window's lifetime is the page's.
 *
 * The command scope's node id is the command node's installation identity
 * when the page already holds a proven one: Electron main proves the
 * window's machine before it loads the page (`orkestratorDesktopIdentity`).
 * A hosted browser page has none, so its
 * command scope opens under the provisional id
 * `COMMAND_SCOPE_PROVISIONAL_NODE_ID` and moves to the installation id the
 * command node's hello proves as soon as it answers (plan item 2011,
 * `WindowScope.adoptCommandNodeId`); the provisional id stays an alias for
 * lookups. Look the command scope up with `commandScope()`, never by its id.
 */

import {
  isBackendId,
  provisionalBackendId,
  type BackendId,
} from "@orkestrator/protocol/federation";
import type { NodeClient, ReadableSignal } from "@orkestrator/protocol/node-client";
import { createWindowOrkestratorClient } from "./command-client";
import { WindowScope } from "./window-scope";

export const COMMAND_SCOPE_PROVISIONAL_NODE_ID = provisionalBackendId("command-node");

let appWindowScope: WindowScope | null = null;

/**
 * The command node's proven installation identity, or the provisional id.
 * Read once, when the window scope is created: a scope's node id never
 * changes, and a command-node switch reloads the page.
 */
export function commandNodeIdFromPage(): BackendId {
  if (typeof window === "undefined") return COMMAND_SCOPE_PROVISIONAL_NODE_ID;
  const candidate = window.orkestratorDesktopIdentity?.backendId;
  return isBackendId(candidate) ? candidate : COMMAND_SCOPE_PROVISIONAL_NODE_ID;
}

/** A client that can learn its proven id (the window client), else nothing. */
function provenNodeIdOf(client: NodeClient): ReadableSignal<BackendId | null> | null {
  const signal = (client as { provenNodeId?: ReadableSignal<BackendId | null> }).provenNodeId;
  return signal && typeof signal.subscribe === "function" ? signal : null;
}

/**
 * Moves the command scope to the id its client's hello proves, once, while
 * its id is provisional.
 */
function adoptProvenCommandNodeId(windowScope: WindowScope, client: NodeClient): void {
  const proven = provenNodeIdOf(client);
  if (!proven) return;
  const adopt = (nodeId: BackendId | null) => {
    if (nodeId) windowScope.adoptCommandNodeId(nodeId);
  };
  const stop = proven.subscribe(adopt);
  windowScope.commandScope().onDispose("adopt-proven-id", stop);
  adopt(proven.get());
}

function createAppWindowScope(commandClient?: NodeClient): WindowScope {
  const windowScope = new WindowScope();
  const client = commandClient ?? createWindowOrkestratorClient(commandNodeIdFromPage());
  windowScope.open({ role: "command", client });
  adoptProvenCommandNodeId(windowScope, client);
  return windowScope;
}

export function getWindowScope(): WindowScope {
  appWindowScope ??= createAppWindowScope();
  return appWindowScope;
}

/**
 * The command scope's client: what every renderer call to the command node
 * goes through. Read it at the call, not once at module load, so a test that
 * resets the window scope is seen.
 */
export function commandClient(): NodeClient {
  return getWindowScope().commandScope().client;
}

/**
 * Disposes the app window scope. The next `getWindowScope()` builds a fresh
 * one; with `commandClient`, it is built now with that client as its command
 * scope's (a fake, so a test sees every call the app makes).
 */
export function resetWindowScopeForTests(commandClient?: NodeClient): void {
  appWindowScope?.dispose();
  appWindowScope = commandClient ? createAppWindowScope(commandClient) : null;
}

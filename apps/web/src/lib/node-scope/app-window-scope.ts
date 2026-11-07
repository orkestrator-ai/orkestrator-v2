/**
 * This renderer's window scope, with its command scope open over
 * `window.orkestrator`. Created on first use and never disposed by the app:
 * the window's lifetime is the page's.
 *
 * The command scope's node id is the command node's installation identity
 * when the page already holds a proven one: Electron main proves the
 * window's machine before it loads the page (`orkestratorDesktopIdentity`),
 * and a workspace realm document is opened for a known node
 * (`orkestratorWorkspaceTarget`). A hosted browser page does not read its
 * command node's hello yet (plan item 2011 adds that), so its command scope
 * opens under the provisional id `COMMAND_SCOPE_PROVISIONAL_NODE_ID`. Look the
 * command scope up with `commandScope()`, never by its id.
 */

import {
  isBackendId,
  provisionalBackendId,
  type BackendId,
} from "@orkestrator/protocol/federation";
import type { NodeClient } from "@orkestrator/protocol/node-client";
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
  const candidates = [
    window.orkestratorDesktopIdentity?.backendId,
    window.orkestratorWorkspaceTarget?.nodeId,
  ];
  for (const candidate of candidates) if (isBackendId(candidate)) return candidate;
  return COMMAND_SCOPE_PROVISIONAL_NODE_ID;
}

function createAppWindowScope(commandClient?: NodeClient): WindowScope {
  const windowScope = new WindowScope();
  windowScope.open({
    role: "command",
    client: commandClient ?? createWindowOrkestratorClient(commandNodeIdFromPage()),
  });
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

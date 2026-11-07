/**
 * This renderer's window scope, with its command scope open over
 * `window.orkestrator`. Created on first use and never disposed by the app:
 * the window's lifetime is the page's.
 *
 * The command node's installation identity is not known when the window
 * mounts (the renderer does not read the command node's hello yet), so the
 * command scope is opened under the provisional id
 * `COMMAND_SCOPE_PROVISIONAL_NODE_ID`. Look the command scope up with
 * `commandScope()`, never by that id; plan item 2010 replaces it with the
 * proven id when it wires the command client.
 */

import { provisionalBackendId } from "@orkestrator/protocol/federation";
import { createWindowOrkestratorClient } from "./command-client";
import { WindowScope } from "./window-scope";

export const COMMAND_SCOPE_PROVISIONAL_NODE_ID = provisionalBackendId("command-node");

let appWindowScope: WindowScope | null = null;

export function getWindowScope(): WindowScope {
  if (!appWindowScope) {
    const windowScope = new WindowScope();
    windowScope.open({
      role: "command",
      client: createWindowOrkestratorClient(COMMAND_SCOPE_PROVISIONAL_NODE_ID),
    });
    appWindowScope = windowScope;
  }
  return appWindowScope;
}

/** Disposes the app window scope so the next `getWindowScope()` builds a fresh one. */
export function resetWindowScopeForTests(): void {
  appWindowScope?.dispose();
  appWindowScope = null;
}

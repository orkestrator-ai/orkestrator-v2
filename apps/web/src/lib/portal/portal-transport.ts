/**
 * The portal channel: always the command node this client is connected to.
 *
 * A window's workspace — `window.orkestrator`, and with it every store,
 * service and the main pane — is on the command node until the user opens
 * an environment on another node. Then the window is re-bound to that node
 * and behaves exactly as if it had connected to it directly, while the
 * portal layer (the multi-node sidebar, cross-node actions, node workspaces,
 * the node registry) keeps talking to the command node through this module.
 * Portal code must never use the workspace transport for that.
 */

import {
  listenAuthoritativeWith,
  type AuthoritativeListenOptions,
} from "@/lib/native/authoritative-events";
import { invoke } from "@/lib/native/backend";
import {
  listen,
  listenOn,
  type ListenOptions,
  type NativeEvent,
  type UnlistenFn,
} from "@/lib/native/events";

export type WorkspaceTarget = NonNullable<Window["orkestratorWorkspaceTarget"]>;

/** The node the workspace is on, or `null` while it is on the command node itself. */
export function workspaceTarget(): WorkspaceTarget | null {
  return (typeof window !== "undefined" && window.orkestratorWorkspaceTarget) || null;
}

export function portalInvoke<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const portal = window.orkestratorPortal;
  return portal ? portal.invoke<T>(command, args) : invoke<T>(command, args);
}

export function portalListen<T>(
  event: string,
  handler: (event: NativeEvent<T>) => unknown,
  options: ListenOptions = {},
): Promise<UnlistenFn> {
  const portal = window.orkestratorPortal;
  return portal ? listenOn(portal, event, handler, options) : listen(event, handler, options);
}

export function portalListenAuthoritative<T>(
  event: string,
  handler: (event: NativeEvent<T>) => unknown,
  options: AuthoritativeListenOptions,
): Promise<UnlistenFn> {
  return listenAuthoritativeWith(portalListen, event, handler, options);
}

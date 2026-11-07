/**
 * The window's command node, for the portal APIs (plan item 5004, report
 * §5.1): inherited settings, the node registry, grants, portal layout,
 * project copy, outcomes, action requests and handover are calls on the
 * command scope.
 *
 * In an app window these are the command scope's own transport
 * (`@/lib/native/backend` `invoke` and `@/lib/native/events` `listen`, which
 * are that scope's client and prefetched cache, and what suites mock), so a
 * portal call and any other command-node call are one path. That holds for
 * every node shown in the window's tree too (plan item 4001): its scope is a
 * leaf of the same window, whose command scope is this one.
 *
 * Calls carry no negotiated range, so a domain client over them takes version
 * 0 (today's call); see `@/lib/node-scope/domains/invoke-over`.
 */

import {
  listenAuthoritativeWith,
  type AuthoritativeListenOptions,
} from "@/lib/native/authoritative-events";
import { invoke } from "@/lib/native/backend";
import { listen, type ListenOptions, type NativeEvent, type UnlistenFn } from "@/lib/native/events";
import type { BackendClient } from "@/lib/backend/client";

/** A command on the window's command node. */
export function commandScopeInvoke<T = unknown>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return invoke<T>(command, args);
}

/** Listens for `event` from the window's command node. */
export function commandScopeListen<T>(
  event: string,
  handler: (event: NativeEvent<T>) => unknown,
  options: ListenOptions = {},
): Promise<UnlistenFn> {
  return listen(event, handler, options);
}

/** `commandScopeListen`, resolving once the command node's stream carries `event`. */
export function commandScopeListenAuthoritative<T>(
  event: string,
  handler: (event: NativeEvent<T>) => unknown,
  options: AuthoritativeListenOptions,
): Promise<UnlistenFn> {
  return listenAuthoritativeWith(commandScopeListen, event, handler, options);
}

/** The window's command node as a `lib/backend` factory client (version 0 calls). */
export const commandScopeBackendClient: BackendClient = {
  invokeRaw: <T>(command: string, args?: Readonly<Record<string, unknown>>) =>
    commandScopeInvoke<T>(command, args as Record<string, unknown> | undefined),
};

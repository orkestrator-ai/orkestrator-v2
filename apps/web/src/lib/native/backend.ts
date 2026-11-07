import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import { invokeInScope } from "@/lib/node-scope/scope-transport";

/**
 * `command` on the window's command node, through the command scope's client
 * and its prefetched cache (`invokeInScope`). Behaviour is today's
 * single-backend `invoke`; scoped code calls `invokeInScope` with its own
 * scope instead.
 */
export function invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invokeInScope<T>(getWindowScope().commandScope(), command, args);
}

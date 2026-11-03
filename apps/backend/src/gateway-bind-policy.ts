/**
 * Which addresses the browser listener may bind.
 *
 * The browser listener serves plain HTTP, so by default it binds only a
 * Tailscale address, where WireGuard supplies the transport security. Two
 * startup modes put a TLS-terminating proxy in front of it instead (Tailscale
 * Serve, and the desktop's managed web client), and those need a loopback bind.
 * They relax the guard for loopback only: anything else still needs the
 * explicit `--allow-non-tailscale-bind`, so a mode flag can never put the
 * listener on the LAN by itself.
 */
import { isLoopbackAddress, isTailscaleAddress } from "./gateway-internals.js";
import type { BackendOptions } from "./options.js";

type GatewayBindOptions = Pick<
  BackendOptions,
  "host" | "tailscaleServe" | "desktopWebClient" | "allowNonTailscaleBind"
>;

/** Loopback the proxy-fronted modes bind when no `--host` is given. */
const PROXIED_DEFAULT_HOST = "127.0.0.1";

function proxiedMode(
  options: GatewayBindOptions,
): "--desktop-web-client" | "--tailscale-serve" | null {
  if (options.desktopWebClient) return "--desktop-web-client";
  if (options.tailscaleServe) return "--tailscale-serve";
  return null;
}

/**
 * The startup check for a proxy-fronted mode's `--host`, run before anything
 * binds. A loopback host (`127.0.0.1` or `::1`) starts; Tailscale Serve
 * proxies to that same loopback address (`tailscale-serve.ts`). A host the
 * bind guard would refuse is refused here with the guard's own message. Any
 * other host (a Tailscale address, or a LAN one allowed by
 * `--allow-non-tailscale-bind`) is refused because Serve cannot front it.
 */
export function assertProxiedModeHost(options: GatewayBindOptions): void {
  const mode = proxiedMode(options);
  if (!mode || !options.host || isLoopbackAddress(options.host)) return;
  assertGatewayBindAllowed(options.host, {
    allowNonTailscaleBind: gatewayAllowsNonTailscaleBind(options),
    safeLoopbackFallback: false,
  });
  throw new Error(`${mode} requires a loopback --host (127.0.0.1 or ::1)`);
}

/** The address handed to the gateway; `undefined` lets it pick a Tailscale one. */
export function gatewayBindAddress(options: GatewayBindOptions): string | undefined {
  return proxiedMode(options) ? (options.host ?? PROXIED_DEFAULT_HOST) : options.host;
}

/**
 * The gateway's `allowNonTailscaleBind`. The explicit flag allows any address;
 * a proxy-fronted mode allows only a loopback bind; otherwise nothing but a
 * Tailscale address (or the gateway's own loopback fallback) is accepted.
 */
export function gatewayAllowsNonTailscaleBind(options: GatewayBindOptions): boolean {
  if (options.allowNonTailscaleBind) return true;
  if (!proxiedMode(options)) return false;
  const bindAddress = gatewayBindAddress(options);
  return bindAddress !== undefined && isLoopbackAddress(bindAddress);
}

/** The browser listener's bind guard, run by `GatewayLifecycle.start`. */
export function assertGatewayBindAllowed(
  bindAddress: string,
  policy: { allowNonTailscaleBind: boolean; safeLoopbackFallback: boolean },
): void {
  if (policy.allowNonTailscaleBind) return;
  if (policy.safeLoopbackFallback) return;
  if (isTailscaleAddress(bindAddress)) return;
  throw new Error(`Refusing to bind gateway to non-Tailscale address: ${bindAddress}`);
}

import type { BackendHttpClient } from "./backend-process.js";

const UNAVAILABLE = "The Local backend on this computer is not running.";

/**
 * Stand-in for the local backend client when it failed to start, so the
 * desktop can still open its saved remote machines. Every call fails with
 * a plain explanation; nothing is queued for later.
 */
export function createUnavailableLocalBackend(): Pick<
  BackendHttpClient,
  | "invoke"
  | "probe"
  | "getWebClientStatus"
  | "setWebClientEnabled"
  | "resetWebClientServe"
  | "getTokenSettings"
  | "setToken"
> {
  const fail = () => Promise.reject(new Error(UNAVAILABLE));
  return {
    invoke: fail,
    probe: () => Promise.resolve(false),
    getWebClientStatus: fail,
    setWebClientEnabled: fail,
    resetWebClientServe: fail,
    getTokenSettings: fail,
    setToken: fail,
  };
}

import path from "node:path";
import {
  BACKEND_INSTANCE_DESCRIPTOR_FILE,
  type BackendInstanceDescriptor,
} from "@orkestrator/protocol/backend-instance";
import { CliError } from "./errors.js";
import { isLoopbackHost, processIsAlive, readDescriptor, readTokenFile } from "./targets.js";
import { observe, ObservationStopped, throwIfInterrupted, type ObserveOptions } from "./wait.js";

/**
 * How to reach a freshly started service: the address it serves browsers on
 * and the gateway token. The token is for the operator's own terminal only;
 * callers must keep it out of logs and machine-readable output.
 */
export interface ServiceConnection {
  /** Browser listener (the Tailscale Serve URL with `--tailscale-serve`). */
  browserUrl: string | null;
  authFile: string;
  token: string | null;
  credentialError?: string;
}

/** Generation of the descriptor in `dataDir` now, so a restart can be told apart. */
export async function currentDescriptorGeneration(dataDir: string): Promise<string | null> {
  try {
    return (await readDescriptor(path.join(dataDir, BACKEND_INSTANCE_DESCRIPTOR_FILE))).generation;
  } catch {
    return null;
  }
}

/**
 * Waits for a backend generation other than `previousGeneration` to publish
 * its descriptor in `dataDir`, then reads its token. Returns null when none is
 * ready in time; the service keeps starting either way.
 */
export async function awaitServiceConnection(
  dataDir: string,
  previousGeneration: string | null,
  options: ObserveOptions,
): Promise<ServiceConnection | null> {
  const file = path.join(dataDir, BACKEND_INSTANCE_DESCRIPTOR_FILE);
  try {
    const descriptor = await observe<BackendInstanceDescriptor>(async () => {
      try {
        const value = await readDescriptor(file);
        const fresh =
          value.generation !== previousGeneration &&
          path.resolve(value.dataDir) === path.resolve(dataDir) &&
          processIsAlive(value.pid);
        return fresh ? { done: true as const, value } : { done: false as const };
      } catch {
        return { done: false as const };
      }
    }, options);
    const connection: ServiceConnection = {
      // Publishers omit browserUrl when it equals the primary URL. Loopback
      // URLs may instead be control or SSH listeners, including old descriptors
      // without endpoint roles, so only fall back to a remote primary address.
      browserUrl:
        descriptor.browserUrl ??
        (isLoopbackHost(new URL(descriptor.url).hostname) ||
        descriptor.endpoints?.some((endpoint) => endpoint.url === descriptor.url)
          ? null
          : descriptor.url),
      authFile: descriptor.authFile,
      token: null,
    };
    try {
      connection.token = await readTokenFile(descriptor.authFile, true);
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      connection.credentialError = error.message;
    }
    throwIfInterrupted(options.signal);
    return connection;
  } catch (error) {
    if (error instanceof ObservationStopped) {
      if (error.reason === "deadline") return null;
      throw new CliError("observation-interrupted", "Stopped waiting for the backend to start");
    }
    throw error;
  }
}

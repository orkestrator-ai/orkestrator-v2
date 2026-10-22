import path from "node:path";
import {
  BACKEND_INSTANCE_DESCRIPTOR_FILE,
  type BackendInstanceDescriptor,
} from "@orkestrator/protocol/backend-instance";
import { CliError } from "./errors.js";
import { processIsAlive, readDescriptor, readTokenFile } from "./targets.js";
import { observe, ObservationStopped, type ObserveOptions } from "./wait.js";

/**
 * How to reach a freshly started service: the address it serves browsers on
 * and the gateway token. The token is for the operator's own terminal only;
 * callers must keep it out of logs and machine-readable output.
 */
export interface ServiceConnection {
  /** Browser listener (the Tailscale Serve URL with `--tailscale-serve`). */
  browserUrl: string | null;
  authFile: string;
  token: string;
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
    return {
      browserUrl: descriptor.browserUrl ?? null,
      authFile: descriptor.authFile,
      token: await readTokenFile(descriptor.authFile, true),
    };
  } catch (error) {
    // The install itself succeeded; a slow start or an unreadable token file
    // only means the operator reads the token from the file instead.
    if (error instanceof ObservationStopped || error instanceof CliError) return null;
    throw error;
  }
}

import { open } from "node:fs/promises";
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

const LOG_EXCERPT_LINES = 20;
const LOG_EXCERPT_MAX_LINE = 500;
const LOG_EXCERPT_MAX_BYTES = 256 * 1024;

/**
 * What the service logged for `version`'s last failed boot, from `offset` on:
 * the lines before the launcher reported its exit. Later lines belong to
 * whatever the launcher started next.
 */
export async function startupLogExcerpt(
  logFile: string,
  offset: number,
  version: string,
): Promise<string[]> {
  let text: string;
  try {
    const file = await open(logFile);
    try {
      const { size } = await file.stat();
      const start = Math.max(offset, size - LOG_EXCERPT_MAX_BYTES);
      const buffer = Buffer.alloc(Math.max(size - start, 0));
      await file.read(buffer, 0, buffer.length, start);
      text = buffer.toString("utf8");
    } finally {
      await file.close();
    }
  } catch {
    return [];
  }
  const lines = text.split("\n");
  const exit = lines.findLastIndex((line) => line.includes(` ${version} exited (`));
  // Persisted boot attempts can trigger rollback without another child exit.
  // In that case stop at the rollback message (or the next release's start).
  const rollback = lines.findIndex(
    (line) =>
      line.includes(` ${version} did not start after `) && line.includes("; rolling back to "),
  );
  const nextStart = lines.findIndex(
    (line) => /^\[launcher\] \S+ starting /.test(line) && !line.endsWith(` starting ${version}`),
  );
  const end =
    exit >= 0
      ? exit
      : Math.min(...[rollback, nextStart, lines.length].filter((index) => index >= 0));
  return lines
    .slice(0, end)
    .filter((line) => line.trim() !== "")
    .slice(-LOG_EXCERPT_LINES)
    .map((line) => line.slice(0, LOG_EXCERPT_MAX_LINE));
}

/**
 * Waits for a backend generation other than `previousGeneration` to publish
 * its descriptor in `dataDir`, then reads its token. Returns null when none is
 * ready in time; the service keeps starting either way. With `expectedVersion`,
 * only that release counts: a rollback also publishes a new generation.
 * `assertStarting` runs on each poll and may throw to stop waiting.
 */
export async function awaitServiceConnection(
  dataDir: string,
  previousGeneration: string | null,
  options: ObserveOptions & { expectedVersion?: string; assertStarting?: () => Promise<void> },
): Promise<ServiceConnection | null> {
  const file = path.join(dataDir, BACKEND_INSTANCE_DESCRIPTOR_FILE);
  try {
    const descriptor = await observe<BackendInstanceDescriptor>(async () => {
      try {
        const value = await readDescriptor(file);
        const fresh =
          value.generation !== previousGeneration &&
          path.resolve(value.dataDir) === path.resolve(dataDir) &&
          (options.expectedVersion === undefined || value.appVersion === options.expectedVersion) &&
          processIsAlive(value.pid);
        if (fresh) return { done: true as const, value };
      } catch {
        // Not published yet, or mid-replacement.
      }
      await options.assertStarting?.();
      return { done: false as const };
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

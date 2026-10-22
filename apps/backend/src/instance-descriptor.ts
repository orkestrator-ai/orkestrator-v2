import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  BACKEND_INSTANCE_DESCRIPTOR_FILE,
  BACKEND_INSTANCE_DESCRIPTOR_TYPE,
  BACKEND_INSTANCE_MAX_ENDPOINTS,
  parseBackendInstanceDescriptor,
  type BackendInstanceDescriptor,
  type BackendInstanceEndpoint,
} from "@orkestrator/protocol/backend-instance";
import type { GatewayStartInfo } from "./gateway-internals.js";

/**
 * The descriptor's listeners by role, from the gateway's own listener URLs
 * (never a Tailscale Serve URL): the control listener, the browser listener
 * when it is bound to loopback, and the loopback client gateway. Only
 * `client` entries are suitable SSH forwarding targets.
 */
export function instanceEndpoints(
  info: Pick<GatewayStartInfo, "controlUrl" | "browserUrl" | "loopbackClientUrl">,
): BackendInstanceEndpoint[] {
  const endpoints: BackendInstanceEndpoint[] = [];
  if (info.controlUrl) endpoints.push({ role: "control", url: info.controlUrl });
  if (info.browserUrl && isLoopbackUrl(info.browserUrl)) {
    endpoints.push({ role: "client", url: info.browserUrl });
  }
  if (info.loopbackClientUrl && info.loopbackClientUrl !== info.browserUrl) {
    endpoints.push({ role: "client", url: info.loopbackClientUrl });
  }
  return endpoints.slice(0, BACKEND_INSTANCE_MAX_ENDPOINTS);
}

function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

export function instanceDescriptorPath(dataDir: string): string {
  return path.join(dataDir, BACKEND_INSTANCE_DESCRIPTOR_FILE);
}

/**
 * Publish the running backend's instance descriptor: mode 0600, written to a
 * temporary file and renamed into place so a reader never sees a partial
 * document. It names the endpoint and the credential *file*, never the
 * credential. Returns a remover that deletes the descriptor only while it
 * still describes this generation, so a newer backend's descriptor survives
 * an older process's late shutdown.
 */
export async function publishInstanceDescriptor(
  descriptor: Omit<BackendInstanceDescriptor, "version" | "type">,
): Promise<() => Promise<void>> {
  const value: BackendInstanceDescriptor = {
    version: 1,
    type: BACKEND_INSTANCE_DESCRIPTOR_TYPE,
    ...descriptor,
  };
  // Validate what we publish with the same parser clients use.
  parseBackendInstanceDescriptor(value);
  const file = instanceDescriptorPath(descriptor.dataDir);
  const temporary = path.join(
    descriptor.dataDir,
    `.${BACKEND_INSTANCE_DESCRIPTOR_FILE}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return async () => {
    try {
      const current = parseBackendInstanceDescriptor(JSON.parse(await fs.readFile(file, "utf8")));
      if (current.generation !== value.generation) return;
      await fs.rm(file, { force: true });
    } catch {
      // Absent or replaced: nothing of ours to remove.
    }
  };
}

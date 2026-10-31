import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseBackendInstanceDescriptor } from "@orkestrator/protocol/backend-instance";
import { instanceDescriptorPath } from "./instance-descriptor.js";
import {
  createFileOwnershipStore,
  type ManagedWebClientOwnershipStore,
} from "./managed-web-client.js";
import { getTailscaleServeTargetPort } from "./tailscale-serve.js";

/** Recover pre-ownership-file services from their last successful publication. */
export function createStandaloneServeOwnershipStore(
  dataDir: string,
): ManagedWebClientOwnershipStore {
  const store = createFileOwnershipStore(path.join(dataDir, "standalone-serve.json"));
  return {
    ...store,
    async load() {
      const ownership = await store.load();
      if (ownership) return ownership;
      let raw: string;
      try {
        raw = await readFile(instanceDescriptorPath(dataDir), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      try {
        const descriptor = parseBackendInstanceDescriptor(JSON.parse(raw));
        if (path.resolve(descriptor.dataDir) !== path.resolve(dataDir) || !descriptor.browserUrl)
          return null;
        const browser = new URL(descriptor.browserUrl);
        if (browser.protocol !== "https:") return null;
        // Standalone Serve's primary gateway is the loopback browser listener.
        // Never infer ownership from arbitrary client/SSH or control endpoints.
        const targetPort = getTailscaleServeTargetPort(descriptor.url);
        return { version: 1, targetPort, httpsPort: Number(browser.port || 443) };
      } catch {
        // Malformed or unrelated descriptors prove no ownership. Serve still
        // rejects a nonmatching root rather than guessing from its proxy port.
        return null;
      }
    },
  };
}

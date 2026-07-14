import type { WebClientStatus } from "@orkestrator/protocol/web-client";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getTailscaleServeTargetPort, TailscaleServeManager } from "./tailscale-serve.js";

type ServeManager = Pick<TailscaleServeManager, "start" | "stop"> &
  Partial<Pick<TailscaleServeManager, "stopOwned">>;

export type ManagedWebClientOwnership = {
  version: 1;
  targetPort: number;
  httpsPort: number;
};

export type ManagedWebClientOwnershipStore = {
  load(): Promise<ManagedWebClientOwnership | null>;
  save(ownership: ManagedWebClientOwnership): Promise<void>;
  clear(): Promise<void>;
};

function createVolatileOwnershipStore(): ManagedWebClientOwnershipStore {
  let ownership: ManagedWebClientOwnership | null = null;
  return {
    load: async () => ownership,
    save: async (next) => { ownership = next; },
    clear: async () => { ownership = null; },
  };
}

export function createFileOwnershipStore(filePath: string): ManagedWebClientOwnershipStore {
  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      const parsed = JSON.parse(raw) as Partial<ManagedWebClientOwnership>;
      if (
        parsed.version !== 1
        || !Number.isInteger(parsed.targetPort)
        || parsed.targetPort! < 1
        || parsed.targetPort! > 65535
        || !Number.isInteger(parsed.httpsPort)
        || parsed.httpsPort! < 1
        || parsed.httpsPort! > 65535
      ) {
        throw new Error("Managed web client ownership file is invalid");
      }
      return parsed as ManagedWebClientOwnership;
    },
    async save(ownership) {
      const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(ownership)}\n`, { mode: 0o600 });
        await rename(temporaryPath, filePath);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
      }
    },
    async clear() {
      await rm(filePath, { force: true });
    },
  };
}

export class ManagedWebClient {
  private enabled = false;
  private url: string | null = null;
  private error: string | null = null;
  private browserListenerUrl: string | null = null;
  private transition: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly serve: ServeManager,
    private readonly httpsPort = 443,
    private readonly logger: Pick<Console, "error"> = console,
    private readonly ownershipStore: ManagedWebClientOwnershipStore = createVolatileOwnershipStore(),
  ) {}

  setBrowserListenerUrl(url: string | undefined): void {
    this.browserListenerUrl = url ?? null;
  }

  getStatus(): WebClientStatus {
    return {
      enabled: this.enabled,
      running: this.url !== null,
      url: this.url,
      error: this.error,
    };
  }

  setEnabled(enabled: boolean): Promise<WebClientStatus> {
    const result = this.transition.catch(() => undefined).then(() => this.applyEnabled(enabled));
    this.transition = result;
    return result;
  }

  async shutdown(): Promise<void> {
    const status = await this.setEnabled(false);
    if (status.error) throw new Error(status.error);
  }

  private async applyEnabled(enabled: boolean): Promise<WebClientStatus> {
    this.enabled = enabled;
    this.error = null;

    if (!enabled) {
      try {
        const ownership = await this.ownershipStore.load();
        if (ownership && this.serve.stopOwned) {
          await this.serve.stopOwned(ownership.targetPort, ownership.httpsPort);
        } else {
          await this.serve.stop();
        }
        await this.ownershipStore.clear();
        this.url = null;
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
        this.logger.error("[TailscaleServe] Failed to disable web access:", error);
      }
      return this.getStatus();
    }

    if (this.url) return this.getStatus();
    if (!this.browserListenerUrl) {
      this.error = "The backend browser listener is unavailable.";
      return this.getStatus();
    }

    let ownership: ManagedWebClientOwnership | null = null;
    try {
      const targetPort = getTailscaleServeTargetPort(this.browserListenerUrl);
      ownership = await this.ownershipStore.load();
      const canAdopt = ownership?.targetPort === targetPort
        && ownership.httpsPort === this.httpsPort;
      if (ownership && !canAdopt) {
        if (this.serve.stopOwned) {
          await this.serve.stopOwned(ownership.targetPort, ownership.httpsPort);
        } else {
          await this.serve.stop();
        }
        await this.ownershipStore.clear();
      }

      const nextOwnership: ManagedWebClientOwnership = {
        version: 1,
        targetPort,
        httpsPort: this.httpsPort,
      };
      await this.ownershipStore.save(nextOwnership);
      ownership = nextOwnership;
      this.url = await this.serve.start(targetPort, this.httpsPort, { adoptExisting: canAdopt });
    } catch (error) {
      this.url = null;
      this.error = error instanceof Error ? error.message : String(error);
      this.logger.error("[TailscaleServe] Failed to enable web access:", error);
      // Serve can be configured successfully before URL discovery fails. In
      // that case, remove the listener so a retry is safe and deterministic.
      try {
        await this.serve.stop();
        if (ownership) await this.ownershipStore.clear();
      } catch (cleanupError) {
        this.logger.error("[TailscaleServe] Failed to clean up web access:", cleanupError);
      }
    }
    return this.getStatus();
  }
}

export function createManagedWebClient(
  executable: string,
  dataDir: string,
  httpsPort = 443,
): ManagedWebClient {
  return new ManagedWebClient(
    new TailscaleServeManager(executable),
    httpsPort,
    console,
    createFileOwnershipStore(path.join(dataDir, "managed-web-client.json")),
  );
}

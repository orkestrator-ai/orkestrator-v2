import type { WebClientStatus } from "@orkestrator/protocol/web-client";
import { getTailscaleServeTargetPort, TailscaleServeManager } from "./tailscale-serve.js";

type ServeManager = Pick<TailscaleServeManager, "start" | "stop">;

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
    await this.transition.catch(() => undefined);
    await this.serve.stop();
    this.url = null;
  }

  private async applyEnabled(enabled: boolean): Promise<WebClientStatus> {
    this.enabled = enabled;
    this.error = null;

    if (!enabled) {
      try {
        await this.serve.stop();
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

    try {
      const targetPort = getTailscaleServeTargetPort(this.browserListenerUrl);
      this.url = await this.serve.start(targetPort, this.httpsPort);
    } catch (error) {
      this.url = null;
      this.error = error instanceof Error ? error.message : String(error);
      this.logger.error("[TailscaleServe] Failed to enable web access:", error);
      // Serve can be configured successfully before URL discovery fails. In
      // that case, remove the listener so a retry is safe and deterministic.
      await this.serve.stop().catch((cleanupError: unknown) => {
        this.logger.error("[TailscaleServe] Failed to clean up web access:", cleanupError);
      });
    }
    return this.getStatus();
  }
}

export function createManagedWebClient(
  executable: string,
  httpsPort = 443,
): ManagedWebClient {
  return new ManagedWebClient(new TailscaleServeManager(executable), httpsPort);
}
